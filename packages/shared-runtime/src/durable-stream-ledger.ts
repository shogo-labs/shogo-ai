// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * File-backed stream ledger for resumable long-running agent responses.
 *
 * This intentionally stores the same bytes that the AI SDK client consumes.
 * The hot in-memory StreamBufferStore still serves live subscribers, while the
 * ledger lets a restarted runtime replay the last persisted stream frames.
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
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export type DurableStreamStatus = 'active' | 'completed' | 'aborted' | 'interrupted_recoverable'

export interface DurableStreamStartOptions {
  turnId?: string
  runtimeId?: string
}

export interface DurableStreamMeta {
  key: string
  turnId: string
  runtimeId?: string
  status: DurableStreamStatus
  createdAt: number
  updatedAt: number
  completedAt?: number
  terminalReason?: string
  lastSeq: number
}

export interface DurableStreamReplayOptions {
  fromSeq?: number
  turnId?: string
}

interface DurableStreamEvent {
  seq: number
  ts: number
  type: 'chunk'
  data: string
}

export class DurableStreamLedger {
  private readonly dir: string
  private readonly retentionMs: number
  private metaCache = new Map<string, DurableStreamMeta>()

  constructor(dir: string, options: { retentionMs?: number } = {}) {
    this.dir = dir
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS
    mkdirSync(this.dir, { recursive: true })
  }

  start(key: string, options: DurableStreamStartOptions = {}): DurableStreamMeta {
    mkdirSync(this.dir, { recursive: true })
    const meta: DurableStreamMeta = {
      key,
      turnId: options.turnId || randomUUID(),
      runtimeId: options.runtimeId,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastSeq: 0,
    }
    writeFileSync(this.eventPath(key), '', 'utf-8')
    this.writeMeta(meta)
    return meta
  }

  appendChunk(key: string, chunk: Uint8Array): number {
    const meta = this.getMeta(key) ?? this.start(key)
    if (meta.status !== 'active') return meta.lastSeq

    const seq = meta.lastSeq + 1
    const event: DurableStreamEvent = {
      seq,
      ts: Date.now(),
      type: 'chunk',
      data: Buffer.from(chunk).toString('base64'),
    }
    appendFileSync(this.eventPath(key), `${JSON.stringify(event)}\n`, 'utf-8')
    meta.lastSeq = seq
    meta.updatedAt = event.ts
    this.writeMeta(meta)
    return seq
  }

  complete(key: string, terminalReason = 'completed'): void {
    const meta = this.getMeta(key)
    if (!meta || meta.status !== 'active') return
    meta.status = 'completed'
    meta.completedAt = Date.now()
    meta.updatedAt = meta.completedAt
    meta.terminalReason = terminalReason
    this.writeMeta(meta)
  }

  abort(key: string, terminalReason = 'aborted'): void {
    const meta = this.getMeta(key)
    if (!meta) return
    meta.status = 'aborted'
    meta.completedAt = Date.now()
    meta.updatedAt = meta.completedAt
    meta.terminalReason = terminalReason
    this.writeMeta(meta)
  }

  interrupt(key: string, terminalReason = 'interrupted_recoverable'): void {
    const meta = this.getMeta(key)
    if (!meta || meta.status !== 'active') return
    meta.status = 'interrupted_recoverable'
    meta.completedAt = Date.now()
    meta.updatedAt = meta.completedAt
    meta.terminalReason = terminalReason
    this.writeMeta(meta)
  }

  has(key: string): boolean {
    const meta = this.getMeta(key)
    return !!meta && meta.status !== 'aborted' && existsSync(this.eventPath(key))
  }

  getMeta(key: string): DurableStreamMeta | null {
    const cached = this.metaCache.get(key)
    if (cached) return cached

    const path = this.metaPath(key)
    if (!existsSync(path)) return null
    try {
      const meta = JSON.parse(readFileSync(path, 'utf-8')) as DurableStreamMeta
      this.metaCache.set(key, meta)
      return meta
    } catch {
      return null
    }
  }

  createReplayStream(key: string, options: DurableStreamReplayOptions = {}): ReadableStream<Uint8Array> | null {
    const meta = this.getMeta(key)
    if (!meta || meta.status === 'aborted') return null
    if (options.turnId && meta.turnId !== options.turnId) return null

    const path = this.eventPath(key)
    if (!existsSync(path)) return null
    const rawFromSeq = options.fromSeq ?? 0
    const fromSeq = Number.isFinite(rawFromSeq) ? Math.max(0, rawFromSeq) : 0
    const events = readFileSync(path, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) as DurableStreamEvent } catch { return null }
      })
      .filter((event): event is DurableStreamEvent => !!event && event.seq > fromSeq)

    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(Buffer.from(event.data, 'base64'))
        }
        controller.close()
      },
    })
  }

  cleanup(): void {
    if (!existsSync(this.dir)) return
    const cutoff = Date.now() - this.retentionMs
    for (const entry of readdirSync(this.dir)) {
      if (!entry.endsWith('.meta.json')) continue
      const metaPath = join(this.dir, entry)
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as DurableStreamMeta
        const lastTouched = meta.completedAt ?? meta.updatedAt ?? statSync(metaPath).mtimeMs
        if (meta.status !== 'active' && lastTouched < cutoff) {
          const encoded = entry.slice(0, -'.meta.json'.length)
          rmSync(metaPath, { force: true })
          rmSync(join(this.dir, `${encoded}.jsonl`), { force: true })
          this.metaCache.delete(meta.key)
        }
      } catch {
        // Leave malformed entries alone; runtime replay should be conservative.
      }
    }
  }

  private writeMeta(meta: DurableStreamMeta): void {
    mkdirSync(dirname(this.metaPath(meta.key)), { recursive: true })
    writeFileSync(this.metaPath(meta.key), JSON.stringify(meta), 'utf-8')
    this.metaCache.set(meta.key, meta)
  }

  private metaPath(key: string): string {
    return join(this.dir, `${this.encodeKey(key)}.meta.json`)
  }

  private eventPath(key: string): string {
    return join(this.dir, `${this.encodeKey(key)}.jsonl`)
  }

  private encodeKey(key: string): string {
    return Buffer.from(key).toString('base64url')
  }
}
