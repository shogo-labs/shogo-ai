// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Resolve the `x-runtime-token` the API must present when calling a
 * *project's* runtime.
 *
 * Two runtime topologies exist, and they authenticate with DIFFERENT
 * token types:
 *
 *   - Legacy single-project runtime → PROJECT token
 *     `rt_v1_<projectId>_…` (`deriveRuntimeToken`).
 *   - Universal workspace runtime (`SHOGO_WORKSPACE_RUNTIME=true`) →
 *     every project is served by a merged-root "unified" runtime whose
 *     `RUNTIME_AUTH_SECRET` is the WORKSPACE token
 *     `wrt_v1_<workspaceId>_…` (`deriveWorkspaceRuntimeToken`, keyed by
 *     the project's `workspaceId`). Sending the project token to it
 *     yields 401 — which is exactly what broke `/agent-proxy/*`
 *     (config, quick-actions, workspace tree/search, chat) once the flag
 *     was enabled locally.
 *
 * This helper centralizes the choice so every API→runtime caller
 * (agent-proxy, project chat, local heartbeat, …) authenticates
 * correctly under whichever topology is active. When the flag is OFF the
 * result is byte-for-byte identical to calling `deriveRuntimeToken`
 * directly, so cloud / non-flag behavior is unchanged.
 *
 * IMPORTANT — the workspace token applies to PROJECT callers in HOST mode
 * only. `resolveProjectPodUrl` (the single source of truth for
 * agent-proxy / project-chat / runtime routes) only reaches a workspace
 * runtime on the host path, where it calls `RuntimeManager.start` — which,
 * under the flag, anchors the project on its merged-root workspace runtime
 * (workspace token). In Kubernetes and VM-isolation that same resolver
 * returns a *project* pod / VM (`getProjectPodUrl` / `getVMProjectUrl`)
 * whose `RUNTIME_AUTH_SECRET` is still the PROJECT token, so the workspace
 * token would 401 there. (Workspace-scoped K8s traffic has its own path —
 * `resolve-workspace-runtime-url` + `deriveWorkspaceRuntimeToken` — and
 * never flows through this helper.) Hence the host-mode gate below.
 */

import { deriveRuntimeToken } from './runtime-token'
import { deriveWorkspaceRuntimeToken } from './workspace-runtime-token'

/**
 * True only when a *project* caller should present the WORKSPACE token:
 * the flag is on AND we're in host/desktop mode (not K8s, not VM). See the
 * module doc for why K8s/VM keep the project token even with the flag on.
 */
function shouldUseWorkspaceToken(): boolean {
  if (process.env.SHOGO_WORKSPACE_RUNTIME !== 'true') return false
  if (process.env.KUBERNETES_SERVICE_HOST) return false
  if (process.env.SHOGO_VM_ISOLATION === 'true') return false
  return true
}

/** projectId → workspaceId is effectively immutable; cache briefly. */
const WS_CACHE_TTL_MS = 60_000
const wsCache = new Map<string, { workspaceId: string | null; expiresAt: number }>()

/**
 * Resolve (and briefly cache) a project's `workspaceId`.
 *
 * Cached because the runtime token is derived on every proxied request
 * and the mapping never changes for the life of a project. Transient
 * lookup failures are NOT cached so a DB hiccup self-heals on retry.
 */
export async function resolveProjectWorkspaceId(projectId: string): Promise<string | null> {
  const cached = wsCache.get(projectId)
  if (cached && cached.expiresAt > Date.now()) return cached.workspaceId

  let workspaceId: string | null = null
  try {
    const { prisma } = await import('./prisma')
    const row = await prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    })
    workspaceId = row?.workspaceId ?? null
  } catch (err: any) {
    console.warn(
      `[ProjectRuntimeToken] workspaceId lookup failed for ${projectId}: ${err?.message ?? err}`,
    )
    return null // don't cache a transient failure
  }

  wsCache.set(projectId, { workspaceId, expiresAt: Date.now() + WS_CACHE_TTL_MS })
  return workspaceId
}

/**
 * The `x-runtime-token` to send when proxying to project `projectId`'s
 * runtime. Pass `workspaceId` when the caller already has it (e.g. from
 * `verifyProjectAccess`) to skip the lookup.
 */
export async function deriveProjectRuntimeToken(
  projectId: string,
  opts?: { workspaceId?: string | null },
): Promise<string> {
  if (shouldUseWorkspaceToken()) {
    const workspaceId = opts?.workspaceId ?? (await resolveProjectWorkspaceId(projectId))
    if (workspaceId) return deriveWorkspaceRuntimeToken(workspaceId)
    // No workspace mapping (project deleted mid-flight, DB hiccup). The
    // project token will 401 against a workspace runtime, but that's
    // strictly better than throwing inside a proxy hot path.
    console.warn(
      `[ProjectRuntimeToken] SHOGO_WORKSPACE_RUNTIME on but no workspaceId for ${projectId}; ` +
        `falling back to project token`,
    )
  }
  return deriveRuntimeToken(projectId)
}
