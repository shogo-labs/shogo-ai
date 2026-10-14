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

export type LiveTurnWait = { waitedMs: number; stopped: boolean }

export class LiveTurnGate {
  /** Turn the user last stopped, per chat. */
  private readonly stoppedTurn = new Map<string, string>()
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
   * Resolves once `chatSessionId` has no live turn to wait for, or with
   * `stopped` when the user pressed Stop meanwhile. Callers must create their
   * buffer synchronously after this resolves, so two waiters can't both start
   * (the second sees the first one's buffer and keeps waiting).
   */
  async waitUntilFree(chatSessionId: string): Promise<LiveTurnWait> {
    const started = Date.now()
    const epoch = this.stopEpoch.get(chatSessionId) ?? 0
    while (this.isBusy(chatSessionId)) {
      await new Promise((resolve) => setTimeout(resolve, this.pollMs))
      if ((this.stopEpoch.get(chatSessionId) ?? 0) !== epoch) {
        return { waitedMs: Date.now() - started, stopped: true }
      }
    }
    return { waitedMs: Date.now() - started, stopped: false }
  }
}
