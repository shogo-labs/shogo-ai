// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Resolve the `x-runtime-token` the API must present when calling a
 * *project's* runtime.
 *
 * Every project is served by a project-anchored merged-root workspace runtime.
 * Its `RUNTIME_AUTH_SECRET` is therefore always the workspace token
 * `wrt_v1_<workspaceId>_…` (`deriveWorkspaceRuntimeToken`), regardless of
 * whether the runtime is hosted locally, on metal, or in Kubernetes.
 */

import { deriveRuntimeToken } from './runtime-token'
import { deriveWorkspaceRuntimeToken } from './workspace-runtime-token'

/**
 * True only when a *project* caller should present the WORKSPACE token:
 * the flag is on AND we're in host/desktop mode (not K8s). See the module
 * doc for why K8s keeps the project token even with the flag on.
 */
function shouldUseWorkspaceToken(): boolean {
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
    throw new Error(
      `[ProjectRuntimeToken] project ${projectId} has no workspaceId; ` +
        'workspace runtime authentication cannot be resolved',
    )
  }
  return deriveRuntimeToken(projectId)
}
