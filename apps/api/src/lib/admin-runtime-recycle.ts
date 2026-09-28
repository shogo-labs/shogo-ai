// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Super-admin runtime recycle: restart a user's runtime from a clean cold boot
 * without touching their code, schema, database or data.
 *
 * Use this — not `DELETE /api/admin/pods/:projectId` — when a runtime is stuck
 * (e.g. its API server crash-loops on EADDRINUSE). A stop suspends to a memory
 * snapshot and the next open resumes the same stuck processes; the pod DELETE
 * drops the snapshot, which may hold the only copy of recent work. A recycle
 * backs everything up from the live guest first and aborts, removing nothing,
 * if any backup fails (unless `force`).
 */

import type { RecycleResult } from './metal-warm-pool-controller'
import type { AnchoredProjectRuntimeArgs } from './resolve-pod-url'

export interface RecycleRequest {
  projectId?: string
  workspaceId?: string
  force?: boolean
  reason?: string
  /** Boot the project again afterwards and wait for its API server (default true). */
  coldBoot?: boolean
}

export interface RecycleActor {
  id: string
  email?: string
}

export interface RecyclePreviewStatus {
  apiReady?: boolean
  apiServerPhase?: string
  running?: boolean
}

export interface RecycleDeps {
  recycle(
    key: string,
    opts: { force?: boolean; reason?: string; buildEnv?: () => Promise<Record<string, string>> },
  ): Promise<RecycleResult>
  loadAnchorArgs(projectId: string): Promise<AnchoredProjectRuntimeArgs | null>
  buildWorkspaceEnv(
    workspaceId: string,
    attachedProjectIds: string[],
    opts: { forMetal: boolean; anchorProjectId?: string; readonlyProjectIds?: string[] },
  ): Promise<Record<string, string>>
  /** Open the project again (cold boot) and return its runtime URL. */
  coldBoot(projectId: string): Promise<string>
  previewStatus(url: string, token: string | undefined): Promise<RecyclePreviewStatus | null>
  audit(entry: Record<string, unknown>): void
  sleep(ms: number): Promise<void>
  now(): number
}

export interface RecycleResponse {
  status: number
  body: Record<string, unknown>
}

/** The real metal controller, runtime manager and pod resolver, wired for a route. */
export async function defaultRecycleDeps(auditTag: string): Promise<RecycleDeps> {
  const { recycleMetalRuntime } = await import('./metal-warm-pool-controller')
  const { buildWorkspaceEnv } = await import('./runtime/build-workspace-env')
  const { getRuntimeManager } = await import('./runtime/index')
  const { resolveProjectPodUrl } = await import('./resolve-pod-url')
  return {
    recycle: recycleMetalRuntime,
    loadAnchorArgs: async (projectId) => {
      const manager = getRuntimeManager() as any
      return typeof manager.resolveAnchorSpawnOpts === 'function' ? manager.resolveAnchorSpawnOpts(projectId) : null
    },
    buildWorkspaceEnv,
    coldBoot: async (projectId) => (await resolveProjectPodUrl(projectId, { logTag: 'AdminRecycle' })).url,
    previewStatus: async (url, token) => {
      const res = await fetch(`${url.replace(/\/+$/, '')}/preview/status`, {
        headers: token ? { 'x-runtime-token': token } : {},
        signal: AbortSignal.timeout(5000),
      })
      return res.ok ? ((await res.json()) as RecyclePreviewStatus) : null
    },
    audit: (entry) => console.log(`[${auditTag}] ${JSON.stringify(entry)}`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  }
}

const POST_BOOT_WAIT_MS = 120_000
const POST_BOOT_POLL_MS = 3_000

export async function recycleRuntimes(
  req: RecycleRequest,
  actor: RecycleActor,
  deps: RecycleDeps,
): Promise<RecycleResponse> {
  const { projectId, workspaceId } = req
  if (!projectId && !workspaceId) {
    return { status: 400, body: { ok: false, error: 'projectId or workspaceId is required' } }
  }
  const force = req.force === true
  const reason = req.reason?.slice(0, 500) || `admin recycle by ${actor.email ?? actor.id}`

  // The anchored canvas runtime is what users open today; the bare project key
  // is the pre-workspace topology, still present on older snapshots.
  let runtimeToken: string | undefined
  const targets: Array<{ key: string; buildEnv?: () => Promise<Record<string, string>> }> = []
  if (projectId) {
    targets.push({
      key: `ws:proj:${projectId}`,
      buildEnv: async () => {
        const args = await deps.loadAnchorArgs(projectId)
        if (!args) throw new Error(`project ${projectId} has no workspace spawn options`)
        const env = await deps.buildWorkspaceEnv(args.workspaceId, args.attachedProjectIds, {
          forMetal: true,
          anchorProjectId: projectId,
          readonlyProjectIds: args.readonlyProjectIds,
        })
        runtimeToken = env.RUNTIME_AUTH_SECRET
        return env
      },
    })
    targets.push({ key: projectId })
  }
  if (workspaceId) targets.push({ key: `ws:${workspaceId}` })

  const results: Array<RecycleResult & { key: string }> = []
  for (const t of targets) {
    results.push({ key: t.key, ...(await deps.recycle(t.key, { force, reason, buildEnv: t.buildEnv })) })
  }
  const found = results.filter((r) => r.found)
  const failed = found.filter((r) => !r.ok)

  const auditBase = {
    event: 'admin.runtime.recycle',
    actorId: actor.id,
    actorEmail: actor.email,
    projectId,
    workspaceId,
    force,
    reason,
    results: results.map((r) => ({
      key: r.key,
      found: r.found,
      ok: r.ok,
      hostId: r.hostId,
      error: r.error,
      steps: r.report?.steps,
    })),
  }

  if (found.length === 0) {
    deps.audit({ ...auditBase, outcome: 'not-found' })
    return { status: 404, body: { ok: false, error: 'no metal runtime found for this project/workspace', results } }
  }
  if (failed.length > 0) {
    deps.audit({ ...auditBase, outcome: 'aborted' })
    return {
      status: 409,
      body: {
        ok: false,
        error: 'recycle aborted: a backup step failed and nothing was removed (retry, or pass force: true to accept the loss)',
        results,
      },
    }
  }

  let coldBoot: Record<string, unknown> | undefined
  if (projectId && req.coldBoot !== false) {
    coldBoot = await bootAndWait(projectId, () => runtimeToken, deps)
  }
  deps.audit({ ...auditBase, outcome: 'recycled', coldBoot })
  return { status: 200, body: { ok: true, results, ...(coldBoot ? { coldBoot } : {}) } }
}

async function bootAndWait(
  projectId: string,
  token: () => string | undefined,
  deps: RecycleDeps,
): Promise<Record<string, unknown>> {
  const started = deps.now()
  let url: string
  try {
    url = await deps.coldBoot(projectId)
  } catch (err: any) {
    return { ok: false, error: `cold boot failed: ${err?.message ?? err}` }
  }
  let last: RecyclePreviewStatus | null = null
  while (deps.now() - started < POST_BOOT_WAIT_MS) {
    last = await deps.previewStatus(url, token()).catch(() => null)
    if (last?.apiReady) break
    await deps.sleep(POST_BOOT_POLL_MS)
  }
  return {
    ok: !!last?.apiReady,
    url,
    apiReady: !!last?.apiReady,
    apiServerPhase: last?.apiServerPhase ?? null,
    waitedMs: deps.now() - started,
  }
}
