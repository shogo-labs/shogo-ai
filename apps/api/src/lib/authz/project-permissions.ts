// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  isProjectPermission,
  permissionList,
  resolveAccess,
  type Permission,
  type ProjectVisibility,
} from '@shogo/authz'
import { accessFacts, loadAccess, loadMembershipFacts, type Principal } from './access'

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

  const facts = await loadMembershipFacts(userId, {
    workspaceIds: [...new Set(projects.map((p) => p.workspaceId))],
    projectIds: projects.map((p) => p.id),
  })
  for (const p of projects) {
    const visibility: ProjectVisibility = p.visibility === 'restricted' ? 'restricted' : 'workspace'
    const access = resolveAccess(accessFacts(facts, p.workspaceId, { id: p.id, visibility }))
    out.set(p.id, projectOnly(permissionList(access)))
  }
  return out
}

function isProjectRef(value: any): value is ProjectRef {
  return !!value && typeof value.id === 'string' && typeof value.workspaceId === 'string'
}

/** Adds `myPermissions` to each project record (used by the project route hooks). */
export async function withProjectPermissions<T>(principal: Principal, records: T[]): Promise<T[]> {
  const projects = (records as unknown[]).filter(isProjectRef)
  if (!projects.length) return records
  const perms = await projectPermissionsFor(principal, projects)
  return records.map((r) => (isProjectRef(r) ? { ...r, myPermissions: perms.get(r.id) ?? [] } : r))
}
