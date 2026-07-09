// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Per-user open-project cap for the metal substrate.
 *
 * Knative/host modes keep only the last N project runtimes warm (WorkspaceKeepWarm
 * pings the top-N; RuntimeManager.enforceWorkspacePreviewCap stops the rest). The
 * metal open path had no equivalent, so a user opening many projects left them ALL
 * resident on the fleet (host RAM per assigned VM) until the idle reaper / disk GC
 * eventually shed them.
 *
 * This module is the metal analog, and — unlike those process-local MRUs — it is
 * PER USER and shared across API replicas (via the MetalPlacementRegistry Redis
 * ZSET): once a user has more than METAL_MAX_OPEN_PROJECTS_PER_USER projects open,
 * we suspend their least-recently-opened one(s) via stopMetalProject (suspend-to-
 * snapshot — reversible, resumes on the next open).
 *
 * Called best-effort (fire-and-forget) from the authenticated `/sandbox/url` open
 * gate; it never throws into the request path and adds no latency to the open.
 */

import { getMetalPlacementRegistry } from './metal-placement-registry'
import { stopMetalProject } from './metal-warm-pool-controller'

/**
 * Max projects a single user may keep open (running/resumed) on metal at once.
 * 0 or negative disables the cap. Default 3 (matches WORKSPACE_PREVIEW_MAX).
 */
export function maxOpenProjectsPerUser(): number {
  const n = parseInt(process.env.METAL_MAX_OPEN_PROJECTS_PER_USER || '3', 10)
  return Number.isFinite(n) ? n : 3
}

/** Result of a suspend attempt (mirrors StopResult from the controller). */
export interface StopOutcome {
  suspended: boolean
  busy?: boolean
}

export interface EnforceDeps {
  registry?: ReturnType<typeof getMetalPlacementRegistry>
  /** Suspend-to-snapshot a project (default: stopMetalProject). */
  stop?: (projectId: string) => Promise<StopOutcome>
  max?: number
  now?: () => number
  log?: (msg: string) => void
}

/**
 * Record that `userId` just opened `projectId`, then suspend enough of the
 * user's least-recently-opened projects to get back under the cap. Walks
 * candidates oldest-first (never the just-opened project) and skips any that are
 * BUSY (an active agent message) — a busy project keeps running and stays in the
 * open set so a later open retries it, while we move on to the next-oldest idle
 * project so the cap is still enforced when possible.
 *
 * Returns the projectIds that were actually suspended (for tests / metrics).
 */
export async function enforceUserMetalOpenLimit(
  userId: string,
  projectId: string,
  deps: EnforceDeps = {},
): Promise<string[]> {
  const max = deps.max ?? maxOpenProjectsPerUser()
  if (!userId || !projectId || max <= 0) return []

  const registry = deps.registry ?? getMetalPlacementRegistry()
  const stop = deps.stop ?? stopMetalProject
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? ((msg: string) => console.log(msg))

  await registry.recordUserOpen(userId, projectId, now())
  const open = await registry.listUserOpen(userId, now()) // oldest first
  let overBy = open.length - max
  if (overBy <= 0) return []

  const suspended: string[] = []
  // Oldest-first: shed idle projects until back under the cap. Never touch the
  // just-opened project (it holds the newest score anyway).
  for (const entry of open) {
    if (overBy <= 0) break
    if (entry.projectId === projectId) continue
    let res: StopOutcome
    try {
      res = await stop(entry.projectId)
    } catch (err: any) {
      log(`[MetalUserOpenLimit] suspend ${entry.projectId.slice(0, 8)} failed (non-fatal): ${err?.message ?? err}`)
      continue // leave it in the set; a later open retries
    }
    if (res.suspended) {
      await registry.removeUserOpen(userId, entry.projectId).catch(() => {})
      suspended.push(entry.projectId)
      overBy--
      log(
        `[MetalUserOpenLimit] user ${userId.slice(0, 8)} over cap (${open.length}/${max}) — ` +
          `suspended LRU project ${entry.projectId.slice(0, 8)}`,
      )
    } else if (res.busy) {
      // Active agent message — never shut it down. Keep it open and try the
      // next-oldest idle project instead.
      log(
        `[MetalUserOpenLimit] user ${userId.slice(0, 8)} — skipped busy project ` +
          `${entry.projectId.slice(0, 8)} (active message); trying next-oldest`,
      )
    }
    // res.suspended === false && !busy (host gone / already stopped-with-no-flag):
    // leave it in the set and move on; nothing was freed.
  }
  return suspended
}
