// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Restart policy for the desktop app's long-lived local API child.
 *
 * The API used to be spawn-once: `local-server.ts` logged
 * `API server exited: code=null, signal=SIGKILL` and cleared the handle, so a
 * userland kill (SHO-26 — an agent shell that inherited `API_PORT` and ran
 * `bun dev:all`, which `kill -9`s whatever listens on it) left the app dead
 * until the user quit and relaunched. This module owns the "respawn instead of
 * dying" decision: capped exponential backoff, give up loudly after N attempts,
 * and never resurrect after an intentional stop.
 *
 * Deliberately free of Electron/fs imports so it can be unit-tested with an
 * injected `start()` (see `__tests__/local-server-respawn.test.ts`).
 */

export interface RestartPolicy {
  /** Delay before each attempt; the last entry is reused once exhausted. */
  backoffMs: readonly number[]
  /** Total attempts inside one unhealthy window before giving up. */
  maxAttempts: number
  /**
   * How long the API must stay healthy before the attempt counter resets. Without
   * this, a process that comes up, passes /health and dies 2s later would restart
   * forever at the fastest backoff.
   */
  resetAfterMs: number
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  backoffMs: [500, 1_000, 2_000, 4_000, 8_000],
  maxAttempts: 5,
  resetAfterMs: 60_000,
}

export interface RestartAttemptInfo {
  attempt: number
  maxAttempts: number
  delayMs: number
}

export interface LocalApiSupervisorOptions {
  /**
   * Spawn the API, write its pid file and resolve once `/health` is green.
   * Resolves with the new child's pid (undefined on platforms without pids).
   * Throws if the child could not be brought up healthy.
   *
   * `attempt` is 0 for the first boot and 1..maxAttempts for restarts, so the
   * caller can allow a cold start longer to become healthy than a restart.
   */
  start: (context: { attempt: number }) => Promise<number | undefined>
  /** Called on every exit, including the intentional ones. */
  onExit?: (code: number | null, signal: string | null) => void
  /** Called just before sleeping, so the log line lands before the delay. */
  onRestartAttempt?: (info: RestartAttemptInfo) => void
  /** Called after a respawn has passed its health check. */
  onRestarted?: (info: { attempt: number; pid?: number }) => void
  /** Called once when the policy is exhausted — the UI should show this. */
  onGiveUp?: (error: Error) => void
  log?: (message: string) => void
  policy?: Partial<RestartPolicy>
  sleep?: (ms: number) => Promise<void>
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export class LocalApiSupervisor {
  private readonly policy: RestartPolicy
  private readonly log: (message: string) => void
  private readonly sleep: (ms: number) => Promise<void>
  private readonly setTimer: NonNullable<LocalApiSupervisorOptions['setTimer']>
  private readonly clearTimer: NonNullable<LocalApiSupervisorOptions['clearTimer']>

  private stopped = false
  private gaveUp = false
  private restarting = false
  private attempts = 0
  private attemptsResetTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: LocalApiSupervisorOptions) {
    this.policy = { ...DEFAULT_RESTART_POLICY, ...opts.policy }
    this.log = opts.log ?? ((message: string) => console.log(message))
    this.sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  /** First boot. Errors propagate to the caller (main.ts shows a dialog). */
  async start(): Promise<void> {
    this.stopped = false
    this.gaveUp = false
    this.attempts = 0
    await this.opts.start({ attempt: 0 })
    this.markHealthy()
  }

  /**
   * Quit path. The child's own `exit` event still arrives afterwards; it must
   * never trigger a respawn, or quitting the app would leave an API behind.
   */
  stop(): void {
    this.stopped = true
    this.clearAttemptsReset()
  }

  get isStopped(): boolean {
    return this.stopped
  }

  get hasGivenUp(): boolean {
    return this.gaveUp
  }

  /**
   * Wire to the API child's `exit` event.
   *
   * Returns the in-flight restart loop (or undefined when the exit is ours or
   * a loop is already running) so callers and tests can await it.
   */
  notifyExit(code: number | null, signal: string | null): Promise<void> | undefined {
    this.opts.onExit?.(code, signal)
    if (this.stopped || this.gaveUp) return undefined
    return this.restartLoop()
  }

  private async restartLoop(): Promise<void> {
    // One loop at a time: the exit event of a child that died *during* a
    // restart attempt must not stack a second backoff sequence on top.
    if (this.restarting) return Promise.resolve()
    this.restarting = true
    try {
      while (!this.stopped && this.attempts < this.policy.maxAttempts) {
        const attempt = this.attempts + 1
        this.attempts = attempt
        const delayMs =
          this.policy.backoffMs[Math.min(attempt - 1, this.policy.backoffMs.length - 1)] ?? 0

        this.opts.onRestartAttempt?.({ attempt, maxAttempts: this.policy.maxAttempts, delayMs })
        this.log(
          `[Desktop] Restarting local API server (attempt ${attempt}/${this.policy.maxAttempts}) in ${delayMs}ms`,
        )
        await this.sleep(delayMs)
        if (this.stopped) return

        try {
          const pid = await this.opts.start({ attempt })
          this.markHealthy()
          this.log(`[Desktop] Local API server restarted (pid=${pid ?? 'unknown'})`)
          this.opts.onRestarted?.({ attempt, pid })
          return
        } catch (err) {
          this.log(
            `[Desktop] Local API restart attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      if (this.stopped || this.gaveUp) return

      this.gaveUp = true
      const error = new Error(
        `The local API server exited unexpectedly and ${this.policy.maxAttempts} restart attempts failed.`,
      )
      this.log(`[Desktop] ${error.message} Giving up — the app needs a restart.`)
      this.opts.onGiveUp?.(error)
    } finally {
      this.restarting = false
    }
  }

  private markHealthy(): void {
    this.clearAttemptsReset()
    const timer = this.setTimer(() => {
      this.attempts = 0
      this.attemptsResetTimer = null
    }, this.policy.resetAfterMs)
    // Never hold Electron's event loop open just to reset a counter.
    ;(timer as unknown as { unref?: () => void })?.unref?.()
    this.attemptsResetTimer = timer
  }

  private clearAttemptsReset(): void {
    if (this.attemptsResetTimer) {
      this.clearTimer(this.attemptsResetTimer)
      this.attemptsResetTimer = null
    }
  }
}
