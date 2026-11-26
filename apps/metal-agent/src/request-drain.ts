// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * In-flight request tracking for a restart that drops nothing.
 *
 * A self-update or rootfs activation restarts the agent while the control
 * plane keeps calling it. The guests and their DNAT forwards survive the
 * restart (KillMode=process), so the only thing that can fail is a control
 * call caught mid-flight: an /assign whose boot dies with the process looks
 * like a failed open to the user.
 *
 * So on SIGTERM the server stops taking new work, answering it with a 503 the
 * control plane knows to retry (`x-metal-restarting`), and waits for the
 * calls already running to finish before the process exits.
 *
 * OPENs are waited for separately (SHO-584). A normal control call finishes in
 * milliseconds, so the 10 s drain is generous for it; a COLD OPEN hydrates an
 * 812 MB member, `.git`, data and home and takes about a minute. Cutting one off
 * at 10 s did not merely fail the open: the new agent adopted the half-hydrated
 * VM as a normal assigned one (it was already in the live registry), and it
 * could never back up or suspend again. So an open in flight gets its own,
 * longer deadline, and the drain only reports failure when even that runs out.
 */

export const RESTARTING_HEADER = 'x-metal-restarting'

export class RequestDrain {
  private inFlight = 0
  /** The subset of `inFlight` that are long calls (opens). */
  private longInFlight = 0
  private draining = false
  private idle: (() => void)[] = []

  get active(): number {
    return this.inFlight
  }

  /** Long calls (a cold open) still running. */
  get activeLong(): number {
    return this.longInFlight
  }

  get isDraining(): boolean {
    return this.draining
  }

  /**
   * Run `handler` as a tracked request, or refuse it with a retryable 503 once
   * draining. `exempt` requests (liveness probes) are always served untracked.
   * `long` marks a call whose normal duration is minutes (an open), so a drain
   * gives it its own deadline instead of the short one.
   */
  async run(
    handler: () => Promise<Response>,
    opts: { exempt?: boolean; long?: boolean } = {},
  ): Promise<Response> {
    if (opts.exempt) return handler()
    if (this.draining) {
      return Response.json(
        { error: 'restarting', retryable: true },
        { status: 503, headers: { [RESTARTING_HEADER]: '1', 'Retry-After': '1' } },
      )
    }
    this.inFlight++
    if (opts.long) this.longInFlight++
    try {
      return await handler()
    } finally {
      this.inFlight--
      if (opts.long) this.longInFlight--
      if (this.inFlight === 0) for (const resolve of this.idle.splice(0)) resolve()
    }
  }

  /**
   * Stop admitting requests and wait for the in-flight ones. Short calls get
   * `timeoutMs`; if an OPEN is still running after that, it gets the extra
   * `openTimeoutMs` on top rather than being cut off mid-hydrate.
   *
   * Resolves true when everything finished, false when a deadline ran out.
   */
  async drain(timeoutMs: number, opts: { openTimeoutMs?: number } = {}): Promise<boolean> {
    this.draining = true
    if (this.inFlight === 0) return true
    if (await this.waitFor(timeoutMs)) return true
    // The short window is up. An open still running is NOT abandoned here: its
    // deadline is the long one, and the process must outlive its hydrate.
    const openTimeoutMs = opts.openTimeoutMs ?? 0
    if (!(openTimeoutMs > 0) || this.longInFlight === 0) return this.inFlight === 0
    return this.waitFor(openTimeoutMs)
  }

  /** Resolve true when nothing is in flight, false after `ms`. */
  private async waitFor(ms: number): Promise<boolean> {
    if (this.inFlight === 0) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const finished = await Promise.race([
      new Promise<boolean>((resolve) => this.idle.push(() => resolve(true))),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
      }),
    ])
    clearTimeout(timer)
    return finished
  }
}
