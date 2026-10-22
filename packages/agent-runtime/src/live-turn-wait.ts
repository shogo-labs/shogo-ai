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

export class LiveTurnGate {
  /** Turn the user last stopped, per chat. */
  private readonly stoppedTurn = new Map<string, string>()
  /** Callers waiting on each chat's live turn, with the moment they started waiting. */
  private readonly waiters = new Map<string, Map<number, number>>()
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
    for (const at of waiters.values()) since = Math.min(since, at)
    return { depth: waiters.size, since }
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
    const waiters = this.waiters.get(chatSessionId) ?? new Map<number, number>()
    waiters.set(id, Date.now())
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
