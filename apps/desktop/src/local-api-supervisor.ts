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
 * SHO-60 adds the *other* half: a child that is alive but not serving (blocked
 * event loop, a stuck SQLite lock, a handler that never returns) never fires
 * `exit`, so the respawn policy above never sees it and the app keeps
 * broadcasting "healthy" while every agent stalls. The liveness watchdog below
 * probes `/health` on an interval and, after N consecutive failures, kills the
 * child so the *existing* exit → respawn path recovers it. One restart loop,
 * two ways in.
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

/**
 * Liveness policy for a child that is up but not serving. A busy API is not a
 * hung one: under a heavy agent load `/health` can take seconds to answer, and
 * restarting then kills every running agent turn. So only a probe that gets no
 * answer at all within `timeoutMs` (or is refused) counts as a failure; a late
 * answer proves the API is alive and resets the count. Three misses in a row
 * means the API has been silent for at least ~90 s.
 */
export interface HealthWatchdogPolicy {
  /** Gap between probes while the API is supposed to be serving. */
  intervalMs: number
  /** A probe with no answer after this long counts as a failure. */
  timeoutMs: number
  /** An answer slower than this is logged as slow; it still counts as alive. */
  slowMs: number
  /** Consecutive failed probes before the child is treated as wedged. */
  failureThreshold: number
}

export const DEFAULT_HEALTH_WATCHDOG: HealthWatchdogPolicy = {
  intervalMs: 15_000,
  timeoutMs: 30_000,
  slowMs: 3_000,
  failureThreshold: 3,
}

export interface HealthFailureInfo {
  failures: number
  maxFailures: number
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
  /**
   * Probe `<apiUrl>/health`. Resolves true when the API answered, false (or
   * rejects) otherwise. Omitted → the watchdog is off, which is what the
   * SHO-26 tests rely on.
   */
  fetchHealth?: () => Promise<boolean>
  /**
   * Kill the current child. The watchdog uses this so recovery stays on the
   * one path the restart policy already owns: kill → `exit` → `notifyExit()`.
   */
  kill?: () => void | Promise<void>
  /** Reached 1..failureThreshold failed probe; still below the trip point. */
  onHealthFailure?: (info: HealthFailureInfo) => void
  /** A probe answered, but slower than `slowMs`. The API counts as alive. */
  onSlowHealth?: (info: { elapsedMs: number }) => void
  /** The child is wedged: about to be killed so the restart loop takes over. */
  onWatchdogTripped?: (info: { failures: number }) => void
  log?: (message: string) => void
  policy?: Partial<RestartPolicy>
  watchdog?: Partial<HealthWatchdogPolicy>
  sleep?: (ms: number) => Promise<void>
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export class LocalApiSupervisor {
  private readonly policy: RestartPolicy
  private readonly watchdogPolicy: HealthWatchdogPolicy
  private readonly log: (message: string) => void
  private readonly sleep: (ms: number) => Promise<void>
  private readonly setTimer: NonNullable<LocalApiSupervisorOptions['setTimer']>
  private readonly clearTimer: NonNullable<LocalApiSupervisorOptions['clearTimer']>

  private stopped = false
  private gaveUp = false
  private restarting = false
  private attempts = 0
  private attemptsResetTimer: ReturnType<typeof setTimeout> | null = null

  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  private probing = false
  private healthFailures = 0
  /** Set while `restartNow()` owns the child, so its own kill cannot respawn. */
  private manualRestart = false

  constructor(private readonly opts: LocalApiSupervisorOptions) {
    this.policy = { ...DEFAULT_RESTART_POLICY, ...opts.policy }
    this.watchdogPolicy = { ...DEFAULT_HEALTH_WATCHDOG, ...opts.watchdog }
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
    this.clearWatchdog()
    this.clearAttemptsReset()
  }

  get isStopped(): boolean {
    return this.stopped
  }

  get hasGivenUp(): boolean {
    return this.gaveUp
  }

  /**
   * Start a fresh child right now, clearing the give-up state. This is the
   * renderer's Retry button: after the policy has exhausted itself the only
   * recovery used to be quitting the app.
   */
  async restartNow(): Promise<{ pid?: number }> {
    this.manualRestart = true
    this.clearWatchdog()
    this.clearAttemptsReset()
    this.healthFailures = 0
    try {
      try {
        await this.opts.kill?.()
      } catch (err) {
        this.log(
          `[Desktop] Manual restart could not kill the old API child: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      this.stopped = false
      this.gaveUp = false
      this.attempts = 0
      const pid = await this.opts.start({ attempt: 0 })
      this.markHealthy()
      this.opts.onRestarted?.({ attempt: 0, pid })
      return { pid }
    } finally {
      this.manualRestart = false
    }
  }

  /**
   * Wire to the API child's `exit` event.
   *
   * Returns the in-flight restart loop (or undefined when the exit is ours or
   * a loop is already running) so callers and tests can await it.
   */
  notifyExit(code: number | null, signal: string | null): Promise<void> | undefined {
    this.opts.onExit?.(code, signal)
    if (this.stopped || this.gaveUp || this.manualRestart) return undefined
    // A child that has gone away cannot answer a probe; drop the timer and let
    // the loop below bring up the replacement that will re-arm it.
    this.clearWatchdog()
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
      this.clearWatchdog()
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
    this.healthFailures = 0
    this.clearAttemptsReset()
    const timer = this.setTimer(() => {
      this.attempts = 0
      this.attemptsResetTimer = null
    }, this.policy.resetAfterMs)
    // Never hold Electron's event loop open just to reset a counter.
    ;(timer as unknown as { unref?: () => void })?.unref?.()
    this.attemptsResetTimer = timer
    this.startWatchdog()
  }

  private clearAttemptsReset(): void {
    if (this.attemptsResetTimer) {
      this.clearTimer(this.attemptsResetTimer)
      this.attemptsResetTimer = null
    }
  }

  /**
   * Arm the liveness probe. Only one watch runs at a time: the next tick is
   * scheduled from the previous one finishing, so a slow probe can never pile
   * ticks up behind it.
   */
  private startWatchdog(): void {
    this.clearWatchdog()
    if (!this.opts.fetchHealth || this.stopped || this.gaveUp) return
    this.scheduleWatchdogTick()
  }

  private scheduleWatchdogTick(): void {
    if (this.stopped || this.gaveUp || !this.opts.fetchHealth) return
    const timer = this.setTimer(() => {
      void this.runWatchdogTick()
    }, this.watchdogPolicy.intervalMs)
    // A probe timer must never be the reason the app refuses to quit.
    ;(timer as unknown as { unref?: () => void })?.unref?.()
    this.watchdogTimer = timer
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      this.clearTimer(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  private async runWatchdogTick(): Promise<void> {
    this.watchdogTimer = null
    if (this.stopped || this.gaveUp || !this.opts.fetchHealth) return
    if (this.probing) {
      this.scheduleWatchdogTick()
      return
    }

    this.probing = true
    let healthy = false
    const startedAt = Date.now()
    try {
      healthy = await this.probeWithTimeout()
    } catch {
      healthy = false
    } finally {
      this.probing = false
    }

    // The child may have exited (and a restart succeeded) while we waited.
    if (this.stopped || this.gaveUp || !this.opts.fetchHealth) return

    if (healthy) {
      const elapsedMs = Date.now() - startedAt
      if (elapsedMs > this.watchdogPolicy.slowMs) this.opts.onSlowHealth?.({ elapsedMs })
      this.healthFailures = 0
      this.scheduleWatchdogTick()
      return
    }

    this.healthFailures += 1
    this.opts.onHealthFailure?.({
      failures: this.healthFailures,
      maxFailures: this.watchdogPolicy.failureThreshold,
    })

    if (this.healthFailures < this.watchdogPolicy.failureThreshold) {
      this.scheduleWatchdogTick()
      return
    }

    await this.tripWatchdog()
  }

  /**
   * A probe that never returns is the wedged-API case itself, so it has to be
   * bounded here: `AbortSignal.timeout` in the caller's probe covers the
   * socket, this covers a `fetch` that resolves nothing at all.
   */
  private async probeWithTimeout(): Promise<boolean> {
    const fetchHealth = this.opts.fetchHealth
    if (!fetchHealth) return false

    const probe = fetchHealth().catch(() => false)
    let handle: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<boolean>((resolve) => {
      handle = this.setTimer(() => resolve(false), this.watchdogPolicy.timeoutMs)
      ;(handle as unknown as { unref?: () => void })?.unref?.()
    })
    try {
      return await Promise.race([probe, timeout])
    } finally {
      if (handle) this.clearTimer(handle)
    }
  }

  /**
   * The child is up but not serving. Kill it and let the restart loop above do
   * what it already does on `exit` — there is exactly one recovery path.
   */
  private async tripWatchdog(): Promise<void> {
    this.clearWatchdog()
    const failures = this.healthFailures

    // A probe that was in flight when the process died would otherwise kill the
    // *replacement*. A successful restart resets the counter before we get here.
    if (this.stopped || this.gaveUp || failures < this.watchdogPolicy.failureThreshold) return
    // One kill per unhealthy window; further probes resume after markHealthy().
    this.healthFailures = 0

    this.log(
      `[Desktop] Local API failed ${failures} consecutive health probes — killing it so the restart policy can recover it`,
    )
    this.opts.onWatchdogTripped?.({ failures })

    try {
      await this.opts.kill?.()
    } catch (err) {
      this.log(
        `[Desktop] Could not kill the wedged API child: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // If the kill produced no `exit` (a pid we never got, a wedged process that
    // ignores both signals) nothing would ever re-arm the probe, and the app
    // would go back to silently serving a dead API. Watch it again; a real
    // restart re-arms through markHealthy() anyway.
    if (!this.stopped && !this.gaveUp && !this.restarting && !this.watchdogTimer) {
      this.scheduleWatchdogTick()
    }
  }
}
