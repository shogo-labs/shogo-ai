// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Metal suspend/resume hooks for project API sidecars.
 *
 * The host snapshots a VM's memory on suspend and restores it on resume, so a
 * sidecar running at snapshot time comes back mid-flight: dead sockets, and —
 * if it was wedged — still holding its port, so every restart after the resume
 * fails with EADDRINUSE. `POST /pool/quiesce` stops the sidecars before the
 * snapshot; `POST /pool/rehydrate` restarts them after the resume.
 */

import type { ApiServerPhase } from './preview-manager'

/** The slice of PreviewManager these hooks use. */
export interface SidecarControl {
  readonly apiServerPhase: ApiServerPhase
  quiesceApiServer(): Promise<boolean>
  rehydrateApiServer(): { restarting: boolean; restart: Promise<void> }
}

export interface QuiesceReport {
  projectId: string
  stopped: boolean
  error?: string
}

export interface RehydrateReport {
  projectId: string
  restarting: boolean
  phase: ApiServerPhase
  error?: string
}

/** Stop every sidecar in parallel. One failing never blocks the others. */
export async function quiesceSidecars(
  managers: ReadonlyMap<string, SidecarControl>,
): Promise<QuiesceReport[]> {
  return Promise.all(
    [...managers].map(async ([projectId, pm]) => {
      try {
        return { projectId, stopped: await pm.quiesceApiServer() }
      } catch (err: any) {
        return { projectId, stopped: false, error: err?.message ?? String(err) }
      }
    }),
  )
}

/**
 * Restart every sidecar quiesce stopped (or that came back broken). Waits up to
 * `waitMs` for the restarts, then reports whatever phase each is in; restarts
 * still running carry on in the background. Never throws: a sidecar that fails
 * to come back is reported, and surfaces through `/pool/activity` health.
 */
export async function rehydrateSidecars(
  managers: ReadonlyMap<string, SidecarControl>,
  waitMs: number,
): Promise<RehydrateReport[]> {
  const started = [...managers].map(([projectId, pm]) => {
    let error: string | undefined
    let restarting = false
    let restart: Promise<void> = Promise.resolve()
    try {
      const r = pm.rehydrateApiServer()
      restarting = r.restarting
      restart = r.restart.catch((err: any) => {
        error = err?.message ?? String(err)
      })
    } catch (err: any) {
      error = err?.message ?? String(err)
    }
    return { projectId, pm, restarting, restart, error: () => error }
  })
  if (waitMs > 0) {
    await Promise.race([
      Promise.all(started.map((s) => s.restart)),
      new Promise((resolve) => setTimeout(resolve, waitMs)),
    ])
  }
  return started.map((s) => ({
    projectId: s.projectId,
    restarting: s.restarting,
    phase: s.pm.apiServerPhase,
    ...(s.error() ? { error: s.error() } : {}),
  }))
}

/** Per-project sidecar phase, for `/pool/activity`. */
export function sidecarHealth(
  managers: ReadonlyMap<string, SidecarControl & { getStatus?(): { apiReady: boolean } }>,
): Array<{ projectId: string; apiPhase: ApiServerPhase; apiReady: boolean }> {
  return [...managers].map(([projectId, pm]) => ({
    projectId,
    apiPhase: pm.apiServerPhase,
    apiReady: pm.getStatus ? pm.getStatus().apiReady : pm.apiServerPhase === 'healthy',
  }))
}
