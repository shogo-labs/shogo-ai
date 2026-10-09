// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Loads the membership facts for a principal + scope and resolves them into
 * effective permissions with `@shogo/authz`.
 *
 * Principals mirror `AuthContext.via`:
 *   session       the user's own memberships
 *   apiKey        the key owner's *current* memberships, only inside the
 *                 key's workspace (a key never outlives a demotion)
 *   runtimeToken  fixed project-scoped capability on the token's project
 *   tunnel        trusted: the cloud proxy already authorized the caller
 */

import {
  ALL_PERMISSIONS,
  resolveAccess,
  toProjectRole,
  isWorkspaceRole,
  type EffectiveAccess,
  type Permission,
  type ProjectVisibility,
} from '@shogo/authz'
import { prisma } from '../prisma'

export interface Principal {
  userId?: string
  isAuthenticated?: boolean
  via?: 'apiKey' | 'session' | 'tunnel' | 'runtimeToken'
  /** API key / runtime token workspace. */
  workspaceId?: string
  /** Runtime token project. */
  projectId?: string
  tunnelAuthenticated?: boolean
}

export type AccessScope = { workspaceId: string; projectId?: undefined } | { projectId: string; workspaceId?: undefined }

export interface AccessContext extends EffectiveAccess {
  /** Workspace the scope resolves to (null when the project does not exist). */
  workspaceId: string | null
  projectId: string | null
  /** False when a project scope names a project that does not exist. */
  exists: boolean
  visibility: ProjectVisibility | null
  /**
   * What the pre-RBAC checks would have answered: super admin, tunnel,
   * matching token/key, or any workspace-scoped membership. Used by shadow
   * mode. Project-only (guest) rows never counted, so guest isolation is
   * enforced regardless of mode.
   */
  legacyAllowed: boolean
}

export type AccessCache = Map<string, Promise<AccessContext>>

export const RUNTIME_TOKEN_PROJECT_PERMISSIONS: readonly Permission[] = ['project:read', 'project:update']
export const RUNTIME_TOKEN_WORKSPACE_PERMISSIONS: readonly Permission[] = ['workspace:read', 'workspace.members:read']

function cacheKey(principal: Principal, scope: AccessScope): string {
  const who = `${principal.via ?? 'anon'}:${principal.userId ?? ''}:${principal.workspaceId ?? ''}:${principal.projectId ?? ''}`
  return scope.projectId ? `${who}|p:${scope.projectId}` : `${who}|w:${scope.workspaceId}`
}

function none(base: Partial<AccessContext>): AccessContext {
  return {
    permissions: new Set(),
    workspaceRole: null,
    projectRole: null,
    isGuest: false,
    isSuperAdmin: false,
    workspaceId: null,
    projectId: null,
    exists: true,
    visibility: null,
    legacyAllowed: false,
    ...base,
  }
}

function normalizeVisibility(v: unknown): ProjectVisibility {
  return v === 'restricted' ? 'restricted' : 'workspace'
}

async function loadProject(projectId: string) {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, visibility: true },
  }) as Promise<{ id: string; workspaceId: string; visibility: string } | null>
}

/**
 * Resolve effective access. Pass a per-request `cache` so repeated checks in
 * one request share a single round-trip.
 */
export function loadAccess(
  principal: Principal | null | undefined,
  scope: AccessScope,
  cache?: AccessCache,
): Promise<AccessContext> {
  const p = principal ?? {}
  if (!cache) return computeAccess(p, scope)
  const key = cacheKey(p, scope)
  let hit = cache.get(key)
  if (!hit) {
    hit = computeAccess(p, scope)
    cache.set(key, hit)
  }
  return hit
}

async function computeAccess(principal: Principal, scope: AccessScope): Promise<AccessContext> {
  let workspaceId: string | null = scope.workspaceId ?? null
  const projectId: string | null = scope.projectId ?? null
  let visibility: ProjectVisibility | null = null

  if (projectId) {
    const project = await loadProject(projectId)
    if (!project) return none({ projectId, exists: false })
    workspaceId = project.workspaceId
    visibility = normalizeVisibility(project.visibility)
  }
  const base = { workspaceId, projectId, visibility, exists: true }

  if (!principal.userId && principal.via !== 'tunnel') return none(base)

  if (principal.via === 'tunnel' || principal.tunnelAuthenticated) {
    return {
      ...none(base),
      permissions: new Set(ALL_PERMISSIONS),
      projectRole: projectId ? 'admin' : null,
      legacyAllowed: true,
    }
  }

  if (principal.via === 'runtimeToken') {
    const inScope = projectId
      ? principal.projectId === projectId
      : !!workspaceId && principal.workspaceId === workspaceId
    if (!inScope) return none(base)
    return {
      ...none(base),
      permissions: new Set(projectId ? RUNTIME_TOKEN_PROJECT_PERMISSIONS : RUNTIME_TOKEN_WORKSPACE_PERMISSIONS),
      projectRole: projectId ? 'member' : null,
      legacyAllowed: true,
    }
  }

  if (principal.via === 'apiKey' && (!principal.workspaceId || principal.workspaceId !== workspaceId)) {
    return none(base)
  }

  const userId = principal.userId!
  const [user, rows] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { role: true } }) as Promise<{ role: string } | null>,
    prisma.member.findMany({
      where: {
        userId,
        OR: [
          { workspaceId: workspaceId!, projectId: null },
          ...(projectId ? [{ projectId }] : []),
        ],
      },
      select: { role: true, projectId: true, isBillingAdmin: true },
    }) as Promise<Array<{ role: string; projectId: string | null; isBillingAdmin: boolean }>>,
  ])

  const wsRow = rows.find((r) => r.projectId === null)
  const projectRow = projectId ? rows.find((r) => r.projectId === projectId) : undefined
  const isSuperAdmin = user?.role === 'super_admin'

  const access = resolveAccess({
    isSuperAdmin,
    workspaceRole: wsRow && isWorkspaceRole(wsRow.role) ? wsRow.role : null,
    isBillingAdmin: !!wsRow?.isBillingAdmin,
    project: projectId ? { visibility: visibility!, projectRole: toProjectRole(projectRow?.role) } : null,
  })

  if (isSuperAdmin && !wsRow) {
    console.info('[rbac] super_admin access without membership', { userId, workspaceId, projectId })
  }

  return {
    ...access,
    ...base,
    legacyAllowed: isSuperAdmin || !!wsRow,
  }
}
