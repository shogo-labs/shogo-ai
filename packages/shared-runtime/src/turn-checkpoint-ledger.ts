// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * File-backed semantic turn-checkpoint ledger.
 *
 * The DurableStreamLedger persists raw SSE frames so clients can replay the
 * wire-level protocol. This ledger persists the *semantic* lifecycle of a
 * turn — attempt boundaries, continuation reasons, tool-call counts, token
 * totals, termination — so the runtime can answer questions like:
 *
 *   - "Is turn T still active, paused, or terminally done?"
 *   - "If the runtime crashes and restarts, what was the last checkpoint
 *      so a reconciler can decide whether to resume, roll back, or ask?"
 *   - "What continuations did we run for this turn and why?"
 *
 * Shape:
 *   <dir>/<encodedTurnId>.meta.json  — single JSON blob for current state.
 *   <dir>/<encodedTurnId>.jsonl      — append-only record of every checkpoint.
 *
 * The two together mirror the DurableStreamLedger layout so ops can reason
 * about both at a glance.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export type TurnStatus =
  | 'active'
  | 'completed'
  | 'aborted'
  | 'interrupted_recoverable'
  | 'max_continuations'
  | 'provider_fatal'
  | 'loop_detected'

export interface TurnMeta {
  turnId: string
  sessionId?: string
  chatSessionId?: string
  runtimeId?: string
  status: TurnStatus
  createdAt: number
  updatedAt: number
  completedAt?: number
  terminalReason?: string
  attempts: number
  iterationsTotal: number
  toolCallsTotal: number
  outputTokensTotal: number
  lastStopReason?: string
  lastAttemptModel?: string
  lastSeq: number
}

export interface TurnCheckpointRecord {
  seq: number
  at: number
  attempt: number
  reason: string
  willContinue: boolean
  iterations: number
  toolCallsThisAttempt: number
  toolCallsTotal: number
  outputTokensTotal: number
  lastStopReason?: string
  modelId?: string
  error?: string
  /** Arbitrary extras (e.g. unfinishedMutating tool ids). */
  extra?: Record<string, unknown>
}

export interface TurnStartOptions {
  sessionId?: string
  chatSessionId?: string
  runtimeId?: string
}

export class TurnCheckpointLedger {
  private readonly dir: string
  private readonly retentionMs: number
  private metaCache = new Map<string, TurnMeta>()

  constructor(dir: string, options: { retentionMs?: number } = {}) {
    this.dir = dir
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS
    mkdirSync(this.dir, { recursive: true })
  }

  start(turnId: string, options: TurnStartOptions = {}): TurnMeta {
    mkdirSync(this.dir, { recursive: true })
    const now = Date.now()
    const meta: TurnMeta = {
      turnId,
      sessionId: options.sessionId,
      chatSessionId: options.chatSessionId,
      runtimeId: options.runtimeId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      iterationsTotal: 0,
      toolCallsTotal: 0,
      outputTokensTotal: 0,
      lastSeq: 0,
    }
    writeFileSync(this.eventPath(turnId), '', 'utf-8')
    this.writeMeta(meta)
    return meta
  }

  /**
   * Append a checkpoint and update the meta snapshot atomically (from a
   * single process's perspective; we rely on OS-level write atomicity for
   * small meta JSON blobs).
   */
  append(turnId: string, cp: Omit<TurnCheckpointRecord, 'seq' | 'at'>): TurnCheckpointRecord {
    const meta = this.getMeta(turnId) ?? this.start(turnId)
    const seq = meta.lastSeq + 1
    const record: TurnCheckpointRecord = {
      seq,
      at: Date.now(),
      ...cp,
    }
    appendFileSync(this.eventPath(turnId), `${JSON.stringify(record)}\n`, 'utf-8')

    meta.lastSeq = seq
    meta.updatedAt = record.at
    meta.attempts = Math.max(meta.attempts, record.attempt)
    meta.iterationsTotal += record.iterations
    meta.toolCallsTotal = Math.max(meta.toolCallsTotal, record.toolCallsTotal)
    meta.outputTokensTotal = Math.max(meta.outputTokensTotal, record.outputTokensTotal)
    if (record.lastStopReason) meta.lastStopReason = record.lastStopReason
    if (record.modelId) meta.lastAttemptModel = record.modelId
    this.writeMeta(meta)
    return record
  }

  finalize(turnId: string, status: TurnStatus, terminalReason?: string): TurnMeta | null {
    const meta = this.getMeta(turnId)
    if (!meta) return null
    meta.status = status
    meta.completedAt = Date.now()
    meta.updatedAt = meta.completedAt
    if (terminalReason) meta.terminalReason = terminalReason
    this.writeMeta(meta)
    return meta
  }

  getMeta(turnId: string): TurnMeta | null {
    const cached = this.metaCache.get(turnId)
    if (cached) return cached
    const path = this.metaPath(turnId)
    if (!existsSync(path)) return null
    try {
      const meta = JSON.parse(readFileSync(path, 'utf-8')) as TurnMeta
      this.metaCache.set(turnId, meta)
      return meta
    } catch {
      return null
    }
  }

  readCheckpoints(turnId: string, fromSeq = 0): TurnCheckpointRecord[] {
    const path = this.eventPath(turnId)
    if (!existsSync(path)) return []
    const out: TurnCheckpointRecord[] = []
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line) continue
      try {
        const rec = JSON.parse(line) as TurnCheckpointRecord
        if (rec.seq > fromSeq) out.push(rec)
      } catch {
        // malformed line — skip
      }
    }
    return out
  }

  /**
   * Scan the ledger dir and return meta records for turns that are still
   * marked `active`. Used by the runtime on boot to identify turns that
   * should be reconciled (either resumed or marked interrupted).
   */
  listActive(): TurnMeta[] {
    if (!existsSync(this.dir)) return []
    const out: TurnMeta[] = []
    for (const entry of readdirSync(this.dir)) {
      if (!entry.endsWith('.meta.json')) continue
      try {
        const meta = JSON.parse(readFileSync(join(this.dir, entry), 'utf-8')) as TurnMeta
        if (meta.status === 'active') out.push(meta)
      } catch {}
    }
    return out
  }

  cleanup(): void {
    if (!existsSync(this.dir)) return
    const cutoff = Date.now() - this.retentionMs
    for (const entry of readdirSync(this.dir)) {
      if (!entry.endsWith('.meta.json')) continue
      const metaPath = join(this.dir, entry)
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as TurnMeta
        const lastTouched = meta.completedAt ?? meta.updatedAt ?? statSync(metaPath).mtimeMs
        if (meta.status !== 'active' && lastTouched < cutoff) {
          const encoded = entry.slice(0, -'.meta.json'.length)
          rmSync(metaPath, { force: true })
          rmSync(join(this.dir, `${encoded}.jsonl`), { force: true })
          this.metaCache.delete(meta.turnId)
        }
      } catch {}
    }
  }

  private writeMeta(meta: TurnMeta): void {
    mkdirSync(dirname(this.metaPath(meta.turnId)), { recursive: true })
    writeFileSync(this.metaPath(meta.turnId), JSON.stringify(meta), 'utf-8')
    this.metaCache.set(meta.turnId, meta)
  }

  private metaPath(turnId: string): string {
    return join(this.dir, `${this.encode(turnId)}.meta.json`)
  }

  private eventPath(turnId: string): string {
    return join(this.dir, `${this.encode(turnId)}.jsonl`)
  }

  private encode(turnId: string): string {
    return Buffer.from(turnId).toString('base64url')
  }
}
