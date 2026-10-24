// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Restart when idle" (SHO-181).
 *
 * Restarting for an update — and quitting — used to kill every live agent run
 * without a word. This is the loop behind both "Restart when idle" answers: turn
 * the API's drain on so nothing new starts, watch the counts, and quit once they
 * have been zero for a moment.
 *
 * The quiet window is not politeness: a turn that just ended schedules the next
 * one (a task wake, a chained card hand-off), so firing the instant the count
 * hits zero would restart into a run that had already been queued. Ten seconds
 * is long enough for the wake to appear in the counts and be waited for.
 *
 * Electron-free on purpose: the whole decision is unit-tested with a fake
 * activity source and a fake clock (see
 * `__tests__/restart-when-idle.test.ts`), and both the update banner and the
 * Quit dialog run it.
 */

import { liveActivityTotal, type LiveActivity } from './live-activity'

export const IDLE_POLL_INTERVAL_MS = 5_000
export const IDLE_QUIET_FOR_MS = 10_000

export interface IdleRestartDeps {
  /** Current counts, or null when the API cannot answer. */
  readActivity: () => Promise<LiveActivity | null>
  /** Turn the API's drain hold on/off. False when it was not accepted. */
  setDrain: (on: boolean) => Promise<boolean>
  /** Restart (or quit). Called exactly once, only after the counts settle. */
  quit: () => void
  /** Every poll, so a banner can say how many runs are still working. */
  onProgress?: (activity: LiveActivity | null) => void
  pollIntervalMs?: number
  quietForMs?: number
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
  now?: () => number
  log?: (message: string) => void
}

export type IdleRestartStart =
  | { ok: true; activity: LiveActivity | null; draining: boolean }
  | { ok: false; error: string }

const TAG = '[Desktop]'

export class IdleRestart {
  private waiting = false
  private timer: unknown = null
  private quietSince: number | null = null
  private drainAccepted: boolean | null = null
  private readonly deps: Required<Pick<IdleRestartDeps, 'readActivity' | 'setDrain' | 'quit'>> &
    Omit<IdleRestartDeps, 'readActivity' | 'setDrain' | 'quit'>

  constructor(deps: IdleRestartDeps) {
    this.deps = deps
  }

  /** True from `start()` until the restart fires or `cancel()` runs. */
  get isWaiting(): boolean {
    return this.waiting
  }

  /**
   * Begin waiting. Drains first, then polls: the order matters, because a due
   * schedule firing between the read and the drain would never let the counts
   * reach zero.
   */
  async start(): Promise<IdleRestartStart> {
    if (this.waiting) return { ok: true, activity: null, draining: this.drainAccepted === true }

    this.waiting = true
    this.quietSince = null

    let activity: LiveActivity | null = null
    try {
      activity = await this.deps.readActivity()
    } catch {
      activity = null
    }
    if (!this.waiting) return { ok: true, activity, draining: this.drainAccepted === true }

    this.drainAccepted = await this.deps.setDrain(true).catch(() => false)
    if (!this.drainAccepted) {
      // Not fatal: without the drain new work can still start, so the counts may
      // take longer to settle — but they usually do, and refusing to restart
      // would strand the user on the old version.
      this.log('drain hold was not accepted; still waiting for the counts to settle')
    }

    this.deps.onProgress?.(activity)
    this.absorb(activity)
    this.pump()
    return { ok: true, activity, draining: this.drainAccepted === true }
  }

  /** Give up waiting and let held automatic work run again. */
  async cancel(): Promise<void> {
    if (!this.waiting) return
    this.waiting = false
    this.clearTimer()
    this.quietSince = null
    if (this.drainAccepted) {
      await this.deps.setDrain(false).catch(() => false)
      this.drainAccepted = null
    }
    this.log('idle restart cancelled')
  }

  private async pump(): Promise<void> {
    if (!this.waiting) return
    let activity: LiveActivity | null = null
    try {
      activity = await this.deps.readActivity()
    } catch {
      activity = null
    }
    if (!this.waiting) return

    this.deps.onProgress?.(activity)
    if (this.absorb(activity)) {
      this.log('nothing is running — restarting now')
      this.waiting = false
      this.clearTimer()
      this.deps.quit()
      return
    }
    this.timer = this.schedule(() => void this.pump(), this.pollIntervalMs())
  }

  /** Track the quiet window; true when it is time to restart. */
  private absorb(activity: LiveActivity | null): boolean {
    if (liveActivityTotal(activity) > 0) {
      this.quietSince = null
      return false
    }
    const now = this.now()
    if (this.quietSince === null) {
      this.quietSince = now
      return this.quietForMs() === 0
    }
    return now - this.quietSince >= this.quietForMs()
  }

  private pollIntervalMs(): number {
    return this.deps.pollIntervalMs ?? IDLE_POLL_INTERVAL_MS
  }

  private quietForMs(): number {
    return this.deps.quietForMs ?? IDLE_QUIET_FOR_MS
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private schedule(fn: () => void, ms: number): unknown {
    return this.deps.schedule ? this.deps.schedule(fn, ms) : setTimeout(fn, ms)
  }

  private clearTimer(): void {
    if (this.timer === null) return
    if (this.deps.cancel) this.deps.cancel(this.timer)
    else clearTimeout(this.timer as ReturnType<typeof setTimeout>)
    this.timer = null
  }

  private log(message: string): void {
    ;(this.deps.log ?? ((line: string) => console.log(`${TAG} ${line}`)))(message)
  }
}
