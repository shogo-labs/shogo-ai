// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Server-side RBAC engine. Every authorization decision goes through here;
 * the role -> permission rules live in `@shogo/authz`.
 *
 *   can(c, perm, scope)        strict boolean (use where an existing role
 *                              check is being replaced)
 *   authorize(c, perm, scope)  decision honoring the enforcement mode (use
 *                              where the check is stricter than pre-RBAC)
 *   requirePermission(perm)    Hono middleware built on `authorize`
 *   accessibleProjectsWhere()  Prisma filter for project listings
 */

import type { Context, Next } from 'hono'
import type { Permission } from '@shogo/authz'
import { loadAccess, type AccessCache, type AccessContext, type AccessScope, type Principal } from './access'
import { getRbacMode } from './mode'
import { prisma } from '../prisma'

export { loadAccess, type AccessContext, type AccessScope, type Principal, type AccessCache } from './access'
export { getRbacMode, invalidateRbacMode, _setRbacModeForTests, RBAC_MODE_SETTING_KEY, type RbacMode } from './mode'

declare module 'hono' {
  interface ContextVariableMap {
    authzCache?: AccessCache
  }
}

export type Denial = { ok: false; status: 401 | 403 | 404; code: string; message: string }
export type Decision = { ok: true; access: AccessContext } | Denial

function requestCache(c: Context): AccessCache {
  let cache = c.get('authzCache')
  if (!cache) {
    cache = new Map()
    c.set('authzCache', cache)
  }
  return cache
}

export function principalOf(c: Context): Principal {
  return (c.get('auth') as Principal | undefined) ?? {}
}

/** Effective access for the request's principal, memoized per request. */
export function getAccess(c: Context, scope: AccessScope): Promise<AccessContext> {
  return loadAccess(principalOf(c), scope, requestCache(c))
}

export async function can(c: Context, permission: Permission, scope: AccessScope): Promise<boolean> {
  return (await getAccess(c, scope)).permissions.has(permission)
}

/**
 * Shape a denial. Restricted or missing projects answer 404 to callers who
 * cannot read them, so existence does not leak.
 */
export function denial(access: AccessContext, permission: Permission, principal?: Principal): Denial {
  if (principal && !principal.userId && principal.via !== 'tunnel') {
    return { ok: false, status: 401, code: 'unauthorized', message: 'Authentication required' }
  }
  if (!access.exists) {
    return { ok: false, status: 404, code: 'not_found', message: 'Project not found' }
  }
  if (access.projectId && !access.permissions.has('project:read') && access.visibility === 'restricted') {
    return { ok: false, status: 404, code: 'not_found', message: 'Project not found' }
  }
  return {
    ok: false,
    status: 403,
    code: 'forbidden',
    message: `Missing permission: ${permission}`,
  }
}

/**
 * Apply the enforcement mode to a resolved access context. Pure apart from
 * logging; usable from hooks that do not have a Hono context.
 */
export async function decide(
  access: AccessContext,
  permission: Permission,
  principal?: Principal,
  where?: string,
): Promise<Decision> {
  if (access.permissions.has(permission)) return { ok: true, access }
  const deny = denial(access, permission, principal)
  if (deny.status === 401 || !access.exists || !access.legacyAllowed) return deny
  // Restricted visibility is new, so there is no legacy access to preserve.
  if (access.visibility === 'restricted' && !access.permissions.has('project:read')) return deny
  const mode = await getRbacMode()
  if (mode === 'on') return deny
  if (mode === 'shadow') {
    console.warn('[rbac] shadow-deny', {
      permission,
      where,
      userId: principal?.userId,
      via: principal?.via,
      workspaceId: access.workspaceId,
      projectId: access.projectId,
      workspaceRole: access.workspaceRole,
      projectRole: access.projectRole,
    })
  }
  return { ok: true, access }
}

export async function authorize(c: Context, permission: Permission, scope: AccessScope): Promise<Decision> {
  const access = await getAccess(c, scope)
  return decide(access, permission, principalOf(c), `${c.req.method} ${c.req.path}`)
}

/** JSON error response for a denial, in the API's standard envelope. */
export function denialResponse(c: Context, d: Denial) {
  return c.json({ error: { code: d.code, message: d.message } }, d.status)
}

/**
 * Middleware: require `permission` on the scope derived from the request.
 * Defaults to the `:projectId` route param.
 */
export function requirePermission(
  permission: Permission,
  scopeOf: (c: Context) => AccessScope | null = (c) => {
    const projectId = c.req.param('projectId')
    return projectId ? { projectId } : null
  },
) {
  return async (c: Context, next: Next) => {
    const scope = scopeOf(c)
    if (!scope) {
      return c.json({ error: { code: 'bad_request', message: 'Missing scope for authorization' } }, 400)
    }
    const d = await authorize(c, permission, scope)
    if (!d.ok) return denialResponse(c, d)
    await next()
  }
}

/**
 * Prisma `where` fragment selecting the projects in `workspaceId` the user can
 * read: every open project for workspace members, every project for owners,
 * admins and super admins, plus any project they hold a project role on.
 * Without `workspaceId`, spans the workspaces and projects the user belongs
 * to (super admins included, so unscoped lists stay personal).
 */
export async function accessibleProjectsWhere(
  principal: Principal,
  workspaceId?: string,
): Promise<Record<string, unknown>> {
  const nothing = { id: { in: [] as string[] } }
  if (principal.via === 'tunnel' || principal.tunnelAuthenticated) {
    return workspaceId ? { workspaceId } : {}
  }
  if (principal.via === 'runtimeToken') {
    return principal.projectId ? { id: principal.projectId } : nothing
  }
  const userId = principal.userId
  if (!userId) return nothing
  if (principal.via === 'apiKey') {
    if (!principal.workspaceId || (workspaceId && workspaceId !== principal.workspaceId)) return nothing
    workspaceId = principal.workspaceId
  }

  const user = (await prisma.user.findUnique({ where: { id: userId }, select: { role: true } })) as
    | { role: string }
    | null
  if (user?.role === 'super_admin' && workspaceId) return { workspaceId }

  const rows = (await prisma.member.findMany({
    where: { userId, ...(workspaceId ? { workspaceId } : {}) },
    select: { role: true, workspaceId: true, projectId: true },
  })) as Array<{ role: string; workspaceId: string | null; projectId: string | null }>

  const governed: string[] = []
  const memberOf: string[] = []
  const projectIds: string[] = []
  for (const r of rows) {
    if (r.projectId) projectIds.push(r.projectId)
    else if (r.workspaceId) (r.role === 'owner' || r.role === 'admin' ? governed : memberOf).push(r.workspaceId)
  }

  const or: Record<string, unknown>[] = []
  if (governed.length) or.push({ workspaceId: { in: governed } })
  if (memberOf.length) or.push({ workspaceId: { in: memberOf }, visibility: 'workspace' })
  if (projectIds.length) or.push({ id: { in: projectIds } })
  if (!or.length) return nothing
  const filter = or.length === 1 ? or[0] : { OR: or }
  return workspaceId ? { AND: [{ workspaceId }, filter] } : filter
}
