// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `memberHooks.beforeDelete` (removing a workspace member):
 *  - owners/admins can remove members, members/viewers cannot
 *  - only owners can remove owners (mirrors the beforeUpdate rule)
 *  - anyone can remove themselves, except the last owner
 */

import { describe, expect, it, mock } from 'bun:test'

mock.module('../services/email.service', () => ({
  sendMemberJoinedEmail: async () => {},
  sendMemberRemovedEmail: async () => {},
}))
mock.module('../services/billing.service', () => ({
  syncSeatsFromMembership: async () => {},
}))

const { memberHooks } = await import('../generated/member.hooks')

type Role = 'owner' | 'admin' | 'member' | 'viewer'

/** Workspace "ws" with the given members; the target is the member with id `target`. */
function makeCtx(userId: string, roles: Record<string, Role>) {
  const workspaceMembers = Object.entries(roles).map(([id, role]) => ({
    id: `m-${id}`,
    userId: id,
    role,
    workspaceId: 'ws',
    projectId: null,
  }))
  const byId = Object.fromEntries(workspaceMembers.map((m) => [m.id, m]))
  return {
    body: {},
    params: {},
    query: {},
    userId,
    prisma: {
      member: {
        findUnique: async ({ where }: any) => {
          const m = byId[where.id]
          return m
            ? { ...m, workspace: { members: workspaceMembers }, user: { email: 'x@example.com', name: 'X' } }
            : null
        },
        findFirst: async () => null,
        count: async ({ where }: any) =>
          workspaceMembers.filter(
            (m) => m.role === where.role && m.workspaceId === where.workspaceId && m.id !== where.id.not,
          ).length,
      },
    },
  } as any
}

describe('memberHooks.beforeDelete', () => {
  it('lets an admin remove a regular member', async () => {
    const res = await memberHooks.beforeDelete!('m-bob', makeCtx('amy', { amy: 'admin', bob: 'member', olga: 'owner' }))
    expect(res).toEqual({ ok: true })
  })

  it('rejects a member removing someone else', async () => {
    const res = await memberHooks.beforeDelete!('m-bob', makeCtx('mia', { mia: 'member', bob: 'member', olga: 'owner' }))
    expect(res?.ok).toBe(false)
    expect(res?.error?.code).toBe('forbidden')
  })

  it('rejects an admin removing an owner', async () => {
    const res = await memberHooks.beforeDelete!('m-olga', makeCtx('amy', { amy: 'admin', olga: 'owner' }))
    expect(res?.ok).toBe(false)
    expect(res?.error?.message).toBe('Only owners can remove owners')
  })

  it('lets an owner remove another owner', async () => {
    const res = await memberHooks.beforeDelete!('m-olga', makeCtx('otto', { otto: 'owner', olga: 'owner' }))
    expect(res).toEqual({ ok: true })
  })

  it('lets a non-owner member remove themselves', async () => {
    const res = await memberHooks.beforeDelete!('m-bob', makeCtx('bob', { bob: 'member', olga: 'owner' }))
    expect(res).toEqual({ ok: true })
  })

  it('blocks the last owner from removing themselves', async () => {
    const res = await memberHooks.beforeDelete!('m-olga', makeCtx('olga', { olga: 'owner', bob: 'member' }))
    expect(res?.ok).toBe(false)
    expect(res?.error?.code).toBe('last_owner')
  })
})
