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
 */

export const RESTARTING_HEADER = 'x-metal-restarting'

export class RequestDrain {
  private inFlight = 0
  private draining = false
  private idle: (() => void)[] = []

  get active(): number {
    return this.inFlight
  }

  get isDraining(): boolean {
    return this.draining
  }

  /**
   * Run `handler` as a tracked request, or refuse it with a retryable 503 once
   * draining. `exempt` requests (liveness probes) are always served untracked.
   */
  async run(handler: () => Promise<Response>, opts: { exempt?: boolean } = {}): Promise<Response> {
    if (opts.exempt) return handler()
    if (this.draining) {
      return Response.json(
        { error: 'restarting', retryable: true },
        { status: 503, headers: { [RESTARTING_HEADER]: '1', 'Retry-After': '1' } },
      )
    }
    this.inFlight++
    try {
      return await handler()
    } finally {
      this.inFlight--
      if (this.inFlight === 0) for (const resolve of this.idle.splice(0)) resolve()
    }
  }

  /**
   * Stop admitting requests and wait (up to `timeoutMs`) for the in-flight
   * ones. Resolves true when all finished, false on timeout.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    this.draining = true
    if (this.inFlight === 0) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const finished = await Promise.race([
      new Promise<boolean>((resolve) => this.idle.push(() => resolve(true))),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
    clearTimeout(timer)
    return finished
  }
}
