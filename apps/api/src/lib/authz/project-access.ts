// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { governsAllProjects, isWorkspaceRole, type ProjectVisibility } from '@shogo/authz'

/**
 * Making a project Restricted must not lock out the person doing it or the
 * project's creator: both get an explicit project Admin row unless their
 * workspace role (owner/admin) already covers every project.
 */
export async function ensureRestrictedAdmins(
  db: any,
  project: { id: string; workspaceId: string; createdBy?: string | null },
  actorId?: string | null,
): Promise<void> {
  const userIds = [...new Set([actorId, project.createdBy].filter((u): u is string => !!u))]
  for (const userId of userIds) {
    const wsRow = await db.member.findFirst({
      where: { userId, workspaceId: project.workspaceId, projectId: null },
      select: { role: true },
    })
    if (!wsRow || governsAllProjects(isWorkspaceRole(wsRow.role) ? wsRow.role : null)) continue
    const existing = await db.member.findFirst({
      where: { userId, projectId: project.id },
      select: { id: true, role: true },
    })
    if (existing) {
      if (existing.role !== 'admin') await db.member.update({ where: { id: existing.id }, data: { role: 'admin' } })
    } else {
      await db.member.create({
        data: { userId, projectId: project.id, workspaceId: project.workspaceId, role: 'admin' },
      })
    }
  }
}

/**
 * Change a project's visibility. Restricting it and granting the admin rows
 * from `ensureRestrictedAdmins` happen in one transaction, so a failure
 * leaves the visibility unchanged.
 */
export async function setProjectVisibility(
  db: any,
  projectId: string,
  visibility: ProjectVisibility,
  actorId?: string | null,
): Promise<{ id: string; workspaceId: string; visibility: ProjectVisibility }> {
  return db.$transaction(async (tx: any) => {
    const project = await tx.project.update({
      where: { id: projectId },
      data: { visibility },
      select: { id: true, workspaceId: true, createdBy: true, visibility: true },
    })
    if (visibility === 'restricted') await ensureRestrictedAdmins(tx, project, actorId)
    return project
  })
}
