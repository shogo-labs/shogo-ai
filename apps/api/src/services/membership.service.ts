// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Delete a Member row. Removing a workspace-scoped row also removes the
 * user's project-scoped rows in that workspace, in the same transaction, so
 * a former member never lingers as a guest on its projects.
 */
export async function removeMembership(db: any, memberId: string): Promise<void> {
  const member = await db.member.findUnique({
    where: { id: memberId },
    select: { id: true, userId: true, workspaceId: true, projectId: true },
  })
  if (!member) return
  if (member.projectId || !member.workspaceId) {
    await db.member.delete({ where: { id: member.id } })
    return
  }
  await db.$transaction([
    db.member.deleteMany({
      where: { userId: member.userId, workspaceId: member.workspaceId, projectId: { not: null } },
    }),
    db.member.delete({ where: { id: member.id } }),
  ])
}
