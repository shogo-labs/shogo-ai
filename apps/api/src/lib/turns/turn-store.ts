// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * In-memory turn store on the API side.
 *
 * Runtimes (via `/agent/turns/:turnId/status` and a best-effort push to
 * `/projects/:projectId/turns/ingest`) populate this store with the
 * semantic lifecycle of every active turn. The store is NOT the source of
 * truth — the runtime's on-disk TurnCheckpointLedger is — but it lets the
 * API answer health/observability and UI-poll queries without round-tripping
 * to the runtime for every request.
 *
 * Design:
 * - Bounded retention: evict entries older than `retentionMs` (default 1h)
 *   on every mutation. Keeps memory constant even under heavy churn.
 * - Per-turn history capped to `maxCheckpointsPerTurn` (default 64) to
 *   protect against runaway producers.
 * - Thread-safe for Node single-thread JS — no async in hot paths.
 */

export type TurnStatus =
  | 'active'
  | 'completed'
  | 'aborted'
  | 'interrupted_recoverable'
  | 'max_continuations'
  | 'provider_fatal'
  | 'loop_detected'

export interface StoredTurnCheckpoint {
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
  extra?: Record<string, unknown>
}

export interface StoredTurn {
  turnId: string
  projectId: string
  chatSessionId?: string
  runtimeId?: string
  status: TurnStatus
  createdAt: number
  updatedAt: number
  terminalReason?: string
  checkpoints: StoredTurnCheckpoint[]
}

export interface TurnStoreOptions {
  retentionMs?: number
  maxCheckpointsPerTurn?: number
  maxTurns?: number
}

const DEFAULT_RETENTION_MS = 60 * 60 * 1000
const DEFAULT_MAX_CHECKPOINTS = 64
const DEFAULT_MAX_TURNS = 1024

export class TurnStore {
  private readonly retentionMs: number
  private readonly maxCheckpointsPerTurn: number
  private readonly maxTurns: number
  private readonly turns = new Map<string, StoredTurn>()

  constructor(options: TurnStoreOptions = {}) {
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS
    this.maxCheckpointsPerTurn = options.maxCheckpointsPerTurn ?? DEFAULT_MAX_CHECKPOINTS
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  }

  upsertStart(input: {
    turnId: string
    projectId: string
    chatSessionId?: string
    runtimeId?: string
  }): StoredTurn {
    this.evictIfNeeded()
    const existing = this.turns.get(input.turnId)
    if (existing) {
      existing.updatedAt = Date.now()
      return existing
    }
    const now = Date.now()
    const turn: StoredTurn = {
      turnId: input.turnId,
      projectId: input.projectId,
      chatSessionId: input.chatSessionId,
      runtimeId: input.runtimeId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      checkpoints: [],
    }
    this.turns.set(input.turnId, turn)
    return turn
  }

  appendCheckpoint(turnId: string, cp: Omit<StoredTurnCheckpoint, 'seq' | 'at'> & Partial<Pick<StoredTurnCheckpoint, 'seq' | 'at'>>): StoredTurn | null {
    const turn = this.turns.get(turnId)
    if (!turn) return null
    const seq = cp.seq ?? (turn.checkpoints.length > 0 ? turn.checkpoints[turn.checkpoints.length - 1].seq + 1 : 1)
    const record: StoredTurnCheckpoint = {
      seq,
      at: cp.at ?? Date.now(),
      attempt: cp.attempt,
      reason: cp.reason,
      willContinue: cp.willContinue,
      iterations: cp.iterations,
      toolCallsThisAttempt: cp.toolCallsThisAttempt,
      toolCallsTotal: cp.toolCallsTotal,
      outputTokensTotal: cp.outputTokensTotal,
      lastStopReason: cp.lastStopReason,
      modelId: cp.modelId,
      error: cp.error,
      extra: cp.extra,
    }
    turn.checkpoints.push(record)
    if (turn.checkpoints.length > this.maxCheckpointsPerTurn) {
      turn.checkpoints.splice(0, turn.checkpoints.length - this.maxCheckpointsPerTurn)
    }
    turn.updatedAt = record.at
    return turn
  }

  finalize(turnId: string, status: TurnStatus, terminalReason?: string): StoredTurn | null {
    const turn = this.turns.get(turnId)
    if (!turn) return null
    turn.status = status
    turn.terminalReason = terminalReason
    turn.updatedAt = Date.now()
    return turn
  }

  get(turnId: string): StoredTurn | null {
    return this.turns.get(turnId) ?? null
  }

  listActive(projectId?: string): StoredTurn[] {
    const out: StoredTurn[] = []
    for (const turn of this.turns.values()) {
      if (turn.status !== 'active') continue
      if (projectId && turn.projectId !== projectId) continue
      out.push(turn)
    }
    return out
  }

  private evictIfNeeded(): void {
    const cutoff = Date.now() - this.retentionMs
    for (const [turnId, turn] of this.turns) {
      if (turn.status !== 'active' && turn.updatedAt < cutoff) {
        this.turns.delete(turnId)
      }
    }
    if (this.turns.size > this.maxTurns) {
      const entries = [...this.turns.entries()].sort(
        (a, b) => a[1].updatedAt - b[1].updatedAt,
      )
      const toDrop = this.turns.size - this.maxTurns
      for (let i = 0; i < toDrop; i++) this.turns.delete(entries[i][0])
    }
  }
}

export const turnStore = new TurnStore()
