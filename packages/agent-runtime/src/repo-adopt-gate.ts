// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Lets the metal host swap the durable `.git` in AFTER the runtime has started
 * serving, without ever doing it under someone's feet.
 *
 * A cold open used to wait for the whole git history download before the
 * project could be used (2.5 minutes on 2026-10-25, for a download that then
 * failed). The host now hands the project out on the source's own `.git` once
 * its foreground budget runs out and asks for the swap later with `ifIdle`.
 * The swap may reset tracked files to the durable HEAD, which is only safe
 * while nothing has used the workspace. This gate is the "nothing" check:
 *
 *   - every request that can write the workspace calls {@link enter} first;
 *   - {@link adoptIfIdle} runs the swap only if no such request has entered,
 *     and holds new ones until it finishes.
 *
 * The check and the claim happen in the same tick, so a request and an adopt
 * can never both believe they went first.
 */
export class RepoAdoptGate {
  private used = false
  private adopting: Promise<void> | null = null

  /** Mark the workspace as in use. Waits out an adopt already in progress. */
  async enter(): Promise<void> {
    if (this.adopting) await this.adopting
    this.used = true
  }

  /** True once a workspace-writing request has entered since the last reset. */
  get inUse(): boolean {
    return this.used
  }

  /** A fresh assignment starts unused. */
  reset(): void {
    this.used = false
  }

  /**
   * Run `fn` unless the workspace has been used or `busy()` says work is in
   * flight; null when declined. Requests that enter meanwhile wait for it.
   */
  async adoptIfIdle<T>(fn: () => Promise<T>, busy: () => boolean = () => false): Promise<T | null> {
    if (this.used || this.adopting || busy()) return null
    const run = fn()
    this.adopting = run.then(
      () => undefined,
      () => undefined,
    )
    try {
      return await run
    } finally {
      this.adopting = null
    }
  }
}

/** Requests that cannot change the workspace, so never count as using it. */
export function isWorkspaceNeutralRequest(method: string, path: string): boolean {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true
  return path === '/health' || path.startsWith('/health/') || path.startsWith('/ready') || path.startsWith('/pool/')
}
