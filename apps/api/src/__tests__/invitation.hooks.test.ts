// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage for the invitation beforeCreate duplicate check. Uses an in-memory
// prisma double so we exercise the real branch logic (active pending blocks,
// expired pending is ignored and cleaned up).

import { beforeEach, describe, expect, test } from 'bun:test'
import { invitationHooks } from '../generated/invitation.hooks'

interface InvitationRow {
  id: string
  email: string
  workspaceId?: string | null
  projectId?: string | null
  status: string
  expiresAt: Date
}

const WORKSPACE_ID = 'ws-1'
const ADMIN_USER_ID = 'user-admin'

let invitations: InvitationRow[]
let idCounter: number

function matchesScope(row: InvitationRow, where: any): boolean {
  if (where.email !== undefined && row.email !== where.email) return false
  if (where.workspaceId !== undefined && row.workspaceId !== where.workspaceId) return false
  if (where.projectId !== undefined && row.projectId !== where.projectId) return false
  if (where.status !== undefined && row.status !== where.status) return false
  if (where.expiresAt?.gt !== undefined && !(row.expiresAt > where.expiresAt.gt)) return false
  if (where.expiresAt?.lte !== undefined && !(row.expiresAt <= where.expiresAt.lte)) return false
  return true
}

function makeCtx() {
  const prisma = {
    member: {
      findFirst: async ({ where }: { where: any }) => {
        if (where.userId === ADMIN_USER_ID && where.workspaceId === WORKSPACE_ID) {
          return { id: 'm-1', userId: ADMIN_USER_ID, workspaceId: WORKSPACE_ID, role: 'owner' }
        }
        return null
      },
    },
    project: {
      findUnique: async () => null,
    },
    invitation: {
      findFirst: async ({ where }: { where: any }) =>
        invitations.find((row) => matchesScope(row, where)) ?? null,
      deleteMany: async ({ where }: { where: any }) => {
        const before = invitations.length
        invitations = invitations.filter((row) => !matchesScope(row, where))
        return { count: before - invitations.length }
      },
    },
  }
  return { body: {}, params: {}, query: {}, userId: ADMIN_USER_ID, prisma }
}

beforeEach(() => {
  invitations = []
  idCounter = 0
})

function seedInvitation(overrides: Partial<InvitationRow>): InvitationRow {
  const row: InvitationRow = {
    id: `inv-${idCounter++}`,
    email: 'invitee@example.com',
    workspaceId: WORKSPACE_ID,
    projectId: null,
    status: 'pending',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ...overrides,
  }
  invitations.push(row)
  return row
}

describe('invitationHooks.beforeCreate duplicate check', () => {
  test('active pending invite blocks a re-invite', async () => {
    seedInvitation({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) })

    const result = await invitationHooks.beforeCreate!(
      { email: 'Invitee@example.com', workspaceId: WORKSPACE_ID, role: 'member' },
      makeCtx() as any,
    )

    expect(result?.ok).toBe(false)
    expect(result?.error?.code).toBe('invitation_exists')
    expect(invitations).toHaveLength(1)
  })

  test('expired pending invite does not block and is cleaned up', async () => {
    seedInvitation({ expiresAt: new Date(Date.now() - 60 * 60 * 1000) })

    const result = await invitationHooks.beforeCreate!(
      { email: 'Invitee@example.com', workspaceId: WORKSPACE_ID, role: 'member' },
      makeCtx() as any,
    )

    expect(result?.ok).toBe(true)
    expect(result?.data?.email).toBe('invitee@example.com')
    // Stale expired row should have been removed before the new row is created.
    expect(invitations).toHaveLength(0)
  })

  test('no existing invite proceeds normally', async () => {
    const result = await invitationHooks.beforeCreate!(
      { email: 'invitee@example.com', workspaceId: WORKSPACE_ID, role: 'member' },
      makeCtx() as any,
    )

    expect(result?.ok).toBe(true)
    expect(result?.data?.expiresAt).toBeInstanceOf(Date)
  })
})
