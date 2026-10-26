// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { deleteE2eTestUsers, e2eOnlyWorkspaceIds, isE2eTestEmail } from '../e2e-test-accounts'

const NOOP = { log: () => {}, warn: () => {} }

function fakeDb(seed: {
  users: Array<{ id: string; email: string }>
  members: Array<{ userId: string; workspaceId: string }>
  projects: Array<{ id: string; workspaceId: string }>
  failWorkspace?: string
}) {
  const users = new Map(seed.users.map((u) => [u.id, u]))
  let members = [...seed.members]
  let projects = [...seed.projects]
  const workspaces = new Set(seed.members.map((m) => m.workspaceId))
  const db = {
    user: {
      findMany: async ({ where }: any) => [...users.values()].filter((u) => where.id.in.includes(u.id)),
      delete: async ({ where }: any) => {
        users.delete(where.id)
        members = members.filter((m) => m.userId !== where.id)
      },
    },
    member: {
      findMany: async ({ where, select }: any) => {
        const rows = members.filter((m) =>
          where.userId ? where.userId.in.includes(m.userId) : where.workspaceId.in.includes(m.workspaceId),
        )
        return rows.map((m) =>
          select.user ? { workspaceId: m.workspaceId, user: { email: users.get(m.userId)?.email } } : { workspaceId: m.workspaceId },
        )
      },
    },
    project: {
      findMany: async ({ where }: any) => projects.filter((p) => p.workspaceId === where.workspaceId).map(({ id }) => ({ id })),
    },
    workspace: {
      delete: async ({ where }: any) => {
        if (where.id === seed.failWorkspace) throw new Error('fk violation')
        workspaces.delete(where.id)
        members = members.filter((m) => m.workspaceId !== where.id)
        projects = projects.filter((p) => p.workspaceId !== where.id)
      },
    },
  }
  return { db: db as any, users, workspaces, projects: () => projects }
}

describe('isE2eTestEmail', () => {
  test('matches only the e2e signup shape', () => {
    expect(isE2eTestEmail('e2e-durability-1792@mailnull.com')).toBe(true)
    expect(isE2eTestEmail('E2E-Gating-1@MailNull.com')).toBe(true)
    expect(isE2eTestEmail('someone@mailnull.com')).toBe(false)
    expect(isE2eTestEmail('e2e-x@gmail.com')).toBe(false)
    expect(isE2eTestEmail('notice-e2e-x@mailnull.com')).toBe(false)
    expect(isE2eTestEmail(null)).toBe(false)
  })
})

describe('e2eOnlyWorkspaceIds', () => {
  test('a workspace counts only when every member is an e2e account', async () => {
    const { db } = fakeDb({
      users: [
        { id: 'e1', email: 'e2e-a-1@mailnull.com' },
        { id: 'e2', email: 'e2e-b-2@mailnull.com' },
        { id: 'r1', email: 'dev@shogo.ai' },
      ],
      members: [
        { userId: 'e1', workspaceId: 'w-e2e' },
        { userId: 'e2', workspaceId: 'w-e2e' },
        { userId: 'e1', workspaceId: 'w-mixed' },
        { userId: 'r1', workspaceId: 'w-mixed' },
      ],
      projects: [],
    })
    expect([...(await e2eOnlyWorkspaceIds(['w-e2e', 'w-mixed', 'w-empty'], db))]).toEqual(['w-e2e'])
  })
})

describe('deleteE2eTestUsers', () => {
  test('deletes the user and its e2e-only workspaces, tearing down runtimes first', async () => {
    const f = fakeDb({
      users: [
        { id: 'e1', email: 'e2e-a-1@mailnull.com' },
        { id: 'r1', email: 'dev@shogo.ai' },
      ],
      members: [
        { userId: 'e1', workspaceId: 'w-personal' },
        { userId: 'e1', workspaceId: 'w-team' },
        { userId: 'e1', workspaceId: 'w-shared' },
        { userId: 'r1', workspaceId: 'w-shared' },
      ],
      projects: [
        { id: 'p1', workspaceId: 'w-team' },
        { id: 'p2', workspaceId: 'w-team' },
        { id: 'p-real', workspaceId: 'w-shared' },
      ],
    })
    const destroyed: string[] = []
    const out = await deleteE2eTestUsers(['e1'], {
      db: f.db,
      logger: NOOP,
      destroyRuntime: async (id) => {
        destroyed.push(id)
      },
    })
    expect(out).toEqual({ users: 1, workspaces: 2, projects: 2, failed: [] })
    expect(destroyed.sort()).toEqual(['p1', 'p2'])
    expect(f.users.has('e1')).toBe(false)
    expect(f.users.has('r1')).toBe(true)
    expect([...f.workspaces].sort()).toEqual(['w-shared'])
    expect(f.projects().map((p) => p.id)).toEqual(['p-real'])
  })

  test('never deletes a non-e2e user, even when asked by id', async () => {
    const f = fakeDb({
      users: [{ id: 'r1', email: 'dev@shogo.ai' }],
      members: [{ userId: 'r1', workspaceId: 'w1' }],
      projects: [{ id: 'p1', workspaceId: 'w1' }],
    })
    const out = await deleteE2eTestUsers(['r1'], { db: f.db, logger: NOOP, destroyRuntime: async () => {} })
    expect(out).toEqual({ users: 0, workspaces: 0, projects: 0, failed: [] })
    expect(f.users.has('r1')).toBe(true)
    expect(f.workspaces.has('w1')).toBe(true)
  })

  test('a failed runtime teardown or workspace delete is reported, not thrown', async () => {
    const f = fakeDb({
      users: [{ id: 'e1', email: 'e2e-a-1@mailnull.com' }],
      members: [
        { userId: 'e1', workspaceId: 'w-ok' },
        { userId: 'e1', workspaceId: 'w-bad' },
      ],
      projects: [{ id: 'p1', workspaceId: 'w-ok' }],
      failWorkspace: 'w-bad',
    })
    const out = await deleteE2eTestUsers(['e1'], {
      db: f.db,
      logger: NOOP,
      destroyRuntime: async () => {
        throw new Error('host unreachable')
      },
    })
    expect(out.workspaces).toBe(1)
    expect(out.users).toBe(1)
    expect(out.failed).toEqual(['workspace:w-bad'])
  })
})
