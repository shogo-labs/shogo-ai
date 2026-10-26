// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One turn per chat at a time, at the stream buffer.
 *
 * `StreamBufferStore.create` completes whatever buffer is live for the chat,
 * after which that turn's remaining frames are dropped: every window attached
 * to it stops receiving it, and the API (which saves the reply from the same
 * buffer) saves it cut short. A second message for a busy chat (another
 * window, another member, a schedule, a queued message) must therefore wait
 * for the live turn before creating its own buffer.
 *
 * A turn the user stopped is not waited for, matching the gateway's turn lock,
 * which `abortCurrentTurn` releases so the next message starts right away.
 * Stop also cancels turns that were already waiting: they were sent before
 * the user pressed Stop, and starting one afterwards would run a turn nobody
 * asked to keep.
 */
import type { StreamBufferStore } from '@shogo-ai/sdk/stream-buffer'

const POLL_MS = 100

export type LiveTurnWait = { waitedMs: number; stopped: boolean; timedOut?: boolean }

/** How long a caller is willing to wait for a live turn to end. */
export interface LiveTurnWaitOptions {
  /**
   * Give up after this long. No caller uses it: a message for a busy chat is
   * queued, never dropped, so a `project_call` waits exactly like a chat
   * message from a second window does.
   */
  timeoutMs?: number
}

/** Calls waiting for a chat's live turn: how many, and since when. */
export interface LiveTurnQueue {
  depth: number
  since: number
}

/**
 * Where one named call stands in a chat. A call cannot be identified by "the
 * chat has a waiter": a message from another window queues on the same gate, so
 * "somebody is waiting" is also true for a call that already started. The
 * caller names its call (`callId`) and this is the answer for that name.
 */
export interface LiveCallState {
  /** Set while the call is still waiting for the chat's own turn to end. */
  queuedSince?: number
  /** The turn the call got once it started. */
  turnId?: string
  /** When that turn started. */
  startedAt?: number
  /** The chat was stopped before the call could start. */
  stopped?: boolean
}

/** How long a call stays answerable on the turn probe, so a slow follower can still find it. */
const CALL_STATE_TTL_MS = 60 * 60_000

export class LiveTurnGate {
  /** Turn the user last stopped, per chat. */
  private readonly stoppedTurn = new Map<string, string>()
  /** Callers waiting on each chat's live turn, with the moment they started waiting. */
  private readonly waiters = new Map<string, Map<number, { since: number }>>()
  /** Named calls, per chat: queued since, or the turn they started. */
  private readonly calls = new Map<string, Map<string, LiveCallState>>()
  private nextWaiterId = 1
  /** Bumped on every Stop, per chat, so waiters can tell a Stop happened. */
  private readonly stopEpoch = new Map<string, number>()

  constructor(
    private readonly store: Pick<StreamBufferStore, 'snapshot'>,
    private readonly pollMs = POLL_MS,
  ) {}

  markStopped(chatSessionId: string): void {
    this.stopEpoch.set(chatSessionId, (this.stopEpoch.get(chatSessionId) ?? 0) + 1)
    const live = this.store.snapshot(chatSessionId)
    if (live?.status === 'active') this.stoppedTurn.set(chatSessionId, live.turnId)
  }

  /** True while `chatSessionId` has a live turn a new turn must wait for. */
  isBusy(chatSessionId: string): boolean {
    const live = this.store.snapshot(chatSessionId)
    return !!live && live.status === 'active' && this.stoppedTurn.get(chatSessionId) !== live.turnId
  }

  /**
   * Calls queued behind this chat's live turn, or null when nothing is
   * waiting. A caller that never got its own buffer is not lost — it is
   * waiting, and this is how the API's follower can tell that from a call the
   * runtime dropped.
   */
  queued(chatSessionId: string): LiveTurnQueue | null {
    const waiters = this.waiters.get(chatSessionId)
    if (!waiters?.size) return null
    let since = Number.POSITIVE_INFINITY
    for (const waiter of waiters.values()) since = Math.min(since, waiter.since)
    return { depth: waiters.size, since }
  }

  /** Record that a named call is queued behind this chat's live turn. */
  noteCallQueued(chatSessionId: string, callId: string): void {
    const calls = this.callsFor(chatSessionId)
    const state = calls.get(callId) ?? {}
    state.queuedSince ??= Date.now()
    calls.set(callId, state)
  }

  /** Record that a queued call got a turn of its own. */
  noteCallStarted(chatSessionId: string, callId: string, turnId: string): void {
    const calls = this.callsFor(chatSessionId)
    calls.set(callId, { turnId, startedAt: Date.now() })
  }

  /** Record that the chat was stopped before this call started. */
  noteCallStopped(chatSessionId: string, callId: string): void {
    this.callsFor(chatSessionId).set(callId, { stopped: true })
  }

  /**
   * Where this named call stands, or null when the gate never heard of it (the
   * runtime restarted, or the queued item is gone) — which is a loss, and the
   * difference the follower needs from "still queued".
   */
  callState(chatSessionId: string, callId: string): LiveCallState | null {
    const state = this.calls.get(chatSessionId)?.get(callId)
    return state ? { ...state } : null
  }

  private callsFor(chatSessionId: string): Map<string, LiveCallState> {
    const now = Date.now()
    const existing = this.calls.get(chatSessionId)
    if (existing) {
      for (const [callId, state] of existing) {
        const at = state.startedAt ?? state.queuedSince
        if (at !== undefined && now - at > CALL_STATE_TTL_MS) existing.delete(callId)
      }
      if (existing.size > 0) return existing
    }
    const fresh = new Map<string, LiveCallState>()
    this.calls.set(chatSessionId, fresh)
    return fresh
  }

  /**
   * Resolves once `chatSessionId` has no live turn to wait for, or with
   * `stopped` when the user pressed Stop meanwhile. Callers must create their
   * buffer synchronously after this resolves, so two waiters can't both start
   * (the second sees the first one's buffer and keeps waiting).
   *
   * With a `timeoutMs` budget it resolves `timedOut` instead of waiting for a
   * live turn that never ends. Nothing in the runtime passes one: a queued
   * call waits as long as the chat's turn takes.
   */
  async waitUntilFree(chatSessionId: string, options: LiveTurnWaitOptions = {}): Promise<LiveTurnWait> {
    const started = Date.now()
    const deadline = options.timeoutMs === undefined ? Infinity : started + options.timeoutMs
    const epoch = this.stopEpoch.get(chatSessionId) ?? 0
    let waiterId: number | null = null
    try {
      while (this.isBusy(chatSessionId)) {
        if (waiterId === null) waiterId = this.addWaiter(chatSessionId)
        if (Date.now() >= deadline) {
          return { waitedMs: Date.now() - started, stopped: false, timedOut: true }
        }
        await new Promise((resolve) => setTimeout(resolve, this.pollMs))
        if ((this.stopEpoch.get(chatSessionId) ?? 0) !== epoch) {
          return { waitedMs: Date.now() - started, stopped: true, timedOut: false }
        }
      }
      return { waitedMs: Date.now() - started, stopped: false, timedOut: false }
    } finally {
      if (waiterId !== null) this.dropWaiter(chatSessionId, waiterId)
    }
  }

  private addWaiter(chatSessionId: string): number {
    const id = this.nextWaiterId++
    const waiters = this.waiters.get(chatSessionId) ?? new Map<number, { since: number }>()
    waiters.set(id, { since: Date.now() })
    this.waiters.set(chatSessionId, waiters)
    return id
  }

  private dropWaiter(chatSessionId: string, waiterId: number): void {
    const waiters = this.waiters.get(chatSessionId)
    if (!waiters) return
    waiters.delete(waiterId)
    if (waiters.size === 0) this.waiters.delete(chatSessionId)
  }
}
