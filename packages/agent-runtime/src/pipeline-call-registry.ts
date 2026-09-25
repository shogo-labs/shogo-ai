// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export type PipelineCallStatus = 'running' | 'completed' | 'failed'

export interface PipelineCallSnapshot {
  callId: string
  status: PipelineCallStatus
  reply?: string
  error?: string
  runId?: string
  sessionId: string
  startedAt: number
  completedAt?: number
}

interface PipelineCallEntry extends PipelineCallSnapshot {
  promise: Promise<void>
}

const CALL_TTL_MS = 60 * 60 * 1000

export class PipelineCallRegistry {
  private calls = new Map<string, PipelineCallEntry>()

  start(
    run: () => Promise<{ reply: string; sessionId: string; runId?: string }>,
    metadata: { runId?: string; sessionId: string },
  ): PipelineCallSnapshot {
    this.cleanup()
    const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const entry: PipelineCallEntry = {
      callId,
      status: 'running',
      runId: metadata.runId,
      sessionId: metadata.sessionId,
      startedAt: Date.now(),
      promise: Promise.resolve(),
    }
    entry.promise = Promise.resolve().then(run).then(result => {
      entry.status = 'completed'
      entry.reply = result.reply
      entry.sessionId = result.sessionId
      entry.runId = result.runId ?? entry.runId
      entry.completedAt = Date.now()
    }).catch(error => {
      entry.status = 'failed'
      entry.error = error?.message ?? String(error)
      entry.completedAt = Date.now()
    })
    this.calls.set(callId, entry)
    return this.snapshot(entry)
  }

  async get(callId: string, waitMs = 0): Promise<PipelineCallSnapshot | null> {
    this.cleanup()
    const entry = this.calls.get(callId)
    if (!entry) return null
    if (entry.status === 'running' && waitMs > 0) {
      await Promise.race([
        entry.promise,
        new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 25_000))),
      ])
    }
    return this.snapshot(entry)
  }

  private snapshot(entry: PipelineCallEntry): PipelineCallSnapshot {
    const { promise: _promise, ...snapshot } = entry
    return snapshot
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [id, entry] of this.calls) {
      if (entry.completedAt && now - entry.completedAt > CALL_TTL_MS) {
        this.calls.delete(id)
      }
    }
  }
}

export const pipelineCallRegistry = new PipelineCallRegistry()
