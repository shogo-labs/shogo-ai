// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { invalidateAccess } from './access-policy.service'

/**
 * Delete a Member row. Removing a workspace-scoped row also removes the
 * user's project-scoped rows in that workspace, in the same transaction, so
 * a former member never lingers as a guest on its projects.
 *
 * A removed member's own access policy goes with them (SHO-417, plan §1
 * cascade): leaving the row behind would silently re-apply the old grant if
 * they were ever re-added. The access cache is dropped either way, so the
 * removal takes effect on the next request rather than after the 30 s TTL.
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
    db.accessPolicy.deleteMany({
      where: { workspaceId: member.workspaceId, subjectType: 'member', subjectId: member.userId },
    }),
    db.member.delete({ where: { id: member.id } }),
  ])
  invalidateAccess(member.workspaceId)
}
