// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { Context, Next } from 'hono'
import {
  isProjectPermission,
  isWorkspaceRole,
  permissionList,
  resolveAccess,
  toProjectRole,
  type Permission,
  type ProjectVisibility,
} from '@shogo/authz'
import { loadAccess, type Principal } from './access'
import { prisma } from '../prisma'

type ProjectRef = { id: string; workspaceId: string; visibility?: string | null }

const projectOnly = (perms: Permission[]) => perms.filter(isProjectPermission)

/**
 * Effective project permissions of `principal` on each project, in two queries for
 * session principals. Other principals go through `loadAccess` per project.
 */
export async function projectPermissionsFor(
  principal: Principal,
  projects: ProjectRef[],
): Promise<Map<string, Permission[]>> {
  const out = new Map<string, Permission[]>()
  if (!projects.length) return out

  if (principal.via && principal.via !== 'session') {
    for (const p of projects) {
      out.set(p.id, projectOnly(permissionList(await loadAccess(principal, { projectId: p.id }))))
    }
    return out
  }
  const userId = principal.userId
  if (!userId) {
    for (const p of projects) out.set(p.id, [])
    return out
  }

  const workspaceIds = [...new Set(projects.map((p) => p.workspaceId))]
  const [user, rows] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { role: true } }) as Promise<{ role: string } | null>,
    prisma.member.findMany({
      where: { userId, workspaceId: { in: workspaceIds } },
      select: { role: true, workspaceId: true, projectId: true, isBillingAdmin: true },
    }) as Promise<Array<{ role: string; workspaceId: string | null; projectId: string | null; isBillingAdmin: boolean }>>,
  ])
  const wsRows = new Map(rows.filter((r) => !r.projectId).map((r) => [r.workspaceId, r]))
  const projectRoles = new Map(rows.filter((r) => r.projectId).map((r) => [r.projectId, r.role]))

  for (const p of projects) {
    const wsRow = wsRows.get(p.workspaceId)
    const access = resolveAccess({
      isSuperAdmin: user?.role === 'super_admin',
      workspaceRole: wsRow && isWorkspaceRole(wsRow.role) ? wsRow.role : null,
      isBillingAdmin: !!wsRow?.isBillingAdmin,
      project: {
        visibility: (p.visibility === 'restricted' ? 'restricted' : 'workspace') as ProjectVisibility,
        projectRole: toProjectRole(projectRoles.get(p.id)),
      },
    })
    out.set(p.id, projectOnly(permissionList(access)))
  }
  return out
}

function isProjectRef(value: any): value is ProjectRef {
  return !!value && typeof value.id === 'string' && typeof value.workspaceId === 'string'
}

/**
 * Middleware for the generated `GET /api/projects` and `GET /api/projects/:id`
 * routes: adds `myPermissions` to each project in the JSON payload.
 */
export async function attachProjectPermissions(c: Context, next: Next) {
  await next()
  if (c.req.method !== 'GET' || !c.res.ok) return
  if (!c.res.headers.get('content-type')?.includes('application/json')) return

  const res = c.res
  let payload: any
  try {
    payload = await res.clone().json()
  } catch {
    return
  }
  const projects: ProjectRef[] = Array.isArray(payload?.items)
    ? payload.items.filter(isProjectRef)
    : isProjectRef(payload?.data)
      ? [payload.data]
      : []
  if (!projects.length) return

  const perms = await projectPermissionsFor((c.get('auth') as Principal | undefined) ?? {}, projects)
  for (const p of projects as any[]) p.myPermissions = perms.get(p.id) ?? []

  const headers = new Headers(res.headers)
  headers.delete('content-length')
  c.res = new Response(JSON.stringify(payload), { status: res.status, headers })
}
