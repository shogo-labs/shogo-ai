// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloud (k8s) "keep the last N workspace runtimes warm" controller.
 *
 * The host keeps the last N project previews warm by NOT stopping their
 * agent-runtime child processes until a 4th is opened (see
 * RuntimeManager.enforceWorkspacePreviewCap). Cloud can't keep processes
 * resident the same way — Knative owns scale-to-zero. The equivalent there is
 * to periodically ping the top-N most-recently-opened workspace runtimes'
 * `/health` endpoints so their `scale-to-zero-pod-retention-period` window
 * keeps refreshing (the pod stays warm / cold-starts on the ping); everything
 * older than N gets no pings and naturally scales to zero.
 *
 * This mirrors `warm-pool-controller.keepAliveWarmPods()` but is keyed by an
 * MRU of *resolved workspace runtimes* rather than a pre-provisioned pool. The
 * resolver records each successful k8s resolution via `recordOpened`.
 *
 * Pure + dependency-injected (fetch, clock) so the MRU/selection logic is unit
 * tested without real timers or network.
 */

export interface WorkspaceKeepWarmEntry {
  /** Stable key (anchor `proj:<id>` or workspaceId) — MRU identity. */
  key: string
  /** Internal cluster URL of the workspace runtime to ping. */
  url: string
  /** Unix-ms this entry was last opened/resolved. */
  lastOpenedAt: number
}

export interface WorkspaceKeepWarmDeps {
  /** Max runtimes to keep warm (default WORKSPACE_PREVIEW_MAX or 3). */
  max?: number
  fetchFn?: (url: string, init?: any) => Promise<{ ok: boolean; status: number }>
  now?: () => number
  pingTimeoutMs?: number
  log?: (msg: string) => void
}

/**
 * MRU of resolved workspace runtimes with a periodic keep-warm ping over the
 * top-N. Construct once per process; call `recordOpened` from the resolver and
 * `start`/`stop` from the server lifecycle.
 */
export class WorkspaceKeepWarm {
  private mru: WorkspaceKeepWarmEntry[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly max: number
  private readonly fetchFn: (url: string, init?: any) => Promise<{ ok: boolean; status: number }>
  private readonly now: () => number
  private readonly pingTimeoutMs: number
  private readonly log: (msg: string) => void

  constructor(deps: WorkspaceKeepWarmDeps = {}) {
    const envMax = parseInt(process.env.WORKSPACE_PREVIEW_MAX || '3', 10)
    this.max = deps.max ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : 3)
    this.fetchFn =
      deps.fetchFn ??
      ((url, init) => fetch(url, init) as unknown as Promise<{ ok: boolean; status: number }>)
    this.now = deps.now ?? (() => Date.now())
    this.pingTimeoutMs = deps.pingTimeoutMs ?? 5000
    this.log = deps.log ?? ((msg) => console.log(msg))
  }

  /** Record a freshly-resolved workspace runtime as most-recently-opened. */
  recordOpened(key: string, url: string): void {
    if (!key || !url) return
    const existing = this.mru.findIndex((e) => e.key === key)
    if (existing >= 0) this.mru.splice(existing, 1)
    this.mru.unshift({ key, url, lastOpenedAt: this.now() })
    // Bound memory: we only ever ping the top `max`, but keep a little history
    // so an entry that briefly drops to N+1 and is re-opened doesn't churn.
    const cap = this.max * 4
    if (this.mru.length > cap) this.mru.length = cap
  }

  /** The top-N entries that should be kept warm (most-recent first). */
  topN(): WorkspaceKeepWarmEntry[] {
    return this.mru.slice(0, this.max)
  }

  /** Ping the top-N runtimes' `/health` to refresh scale-to-zero retention. */
  async pingTopN(): Promise<{ pinged: string[]; failed: string[] }> {
    const targets = this.topN()
    const pinged: string[] = []
    const failed: string[] = []
    await Promise.allSettled(
      targets.map(async (entry) => {
        try {
          const res = await this.fetchFn(`${entry.url}/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(this.pingTimeoutMs),
          })
          if (res.ok) {
            entry.lastOpenedAt = this.now()
            pinged.push(entry.key)
          } else {
            this.log(`[WorkspaceKeepWarm] ${entry.key} → HTTP ${res.status}`)
            failed.push(entry.key)
          }
        } catch (err: any) {
          this.log(`[WorkspaceKeepWarm] ${entry.key} ping failed: ${err?.message ?? err}`)
          failed.push(entry.key)
        }
      }),
    )
    return { pinged, failed }
  }

  /** Begin the periodic keep-warm sweep. Idempotent. */
  start(intervalMs = parseInt(process.env.WORKSPACE_KEEP_WARM_INTERVAL_MS || '60000', 10)): void {
    if (this.timer) return
    const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60000
    this.timer = setInterval(() => {
      this.pingTopN().catch((err) =>
        this.log(`[WorkspaceKeepWarm] sweep failed (non-fatal): ${err?.message ?? err}`),
      )
    }, interval)
    // Don't keep the event loop alive solely for keep-warm.
    if (typeof this.timer === 'object' && 'unref' in (this.timer as any)) {
      ;(this.timer as any).unref()
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

let _instance: WorkspaceKeepWarm | null = null

/** Process-wide singleton used by the resolver + server lifecycle. */
export function getWorkspaceKeepWarm(): WorkspaceKeepWarm {
  if (!_instance) _instance = new WorkspaceKeepWarm()
  return _instance
}
