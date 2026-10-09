// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

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
    if (!wsRow || wsRow.role === 'owner' || wsRow.role === 'admin') continue
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
