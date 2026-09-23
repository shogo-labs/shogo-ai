// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `bootstrapLocalDatabase`'s local-user + free-workspace seeding:
 *  - fresh install: signs up the local user (existing behavior).
 *  - every boot: backfills whichever of the free `personal` / `team`
 *    workspaces the local user doesn't already own, since desktop has no
 *    "Create new workspace" UI to reach either flow otherwise.
 *  - the two kinds are checked independently (not "assume personal exists,
 *    only backfill team") because old local builds predate
 *    `createPersonalWorkspace` being wired into the signup hook — their
 *    original (and only) workspace was created with the schema default,
 *    `kind: 'team'`, leaving them with *no* personal workspace at all.
 *    Newer builds' signup hook creates `personal` up front, so those users
 *    are only ever missing `team`.
 *  - idempotency: skips a kind's backfill once the user already owns one
 *    (covers fresh installs after their first backfill runs, and
 *    pre-existing installs that already have one for other reasons).
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

// --- Mocked dependencies -----------------------------------------------------
let users: { id: string; name: string; createdAt: string }[] = []
let localConfigRows: { key: string; value: string }[] = []
let ownedPersonalCountByUser: Record<string, number> = {}
let ownedTeamCountByUser: Record<string, number> = {}
const createPaidWorkspaceCalls: { userId: string; name: string }[] = []
const createPersonalWorkspaceCalls: { userId: string; name: string }[] = []
let signUpEmailCalls = 0
let signUpEmailResult: { user: { id: string; name: string } } | null = null

mock.module('../auth', () => ({
  auth: {
    api: {
      signUpEmail: async (_opts: any) => {
        signUpEmailCalls++
        return signUpEmailResult
      },
    },
  },
}))

mock.module('../services/workspace.service', () => ({
  getUserOwnedWorkspaceCount: async (userId: string, kind?: 'personal' | 'team') => {
    if (kind === 'team') return ownedTeamCountByUser[userId] ?? 0
    if (kind === 'personal') return ownedPersonalCountByUser[userId] ?? 0
    return 0
  },
  createPaidWorkspace: async (userId: string, name: string) => {
    createPaidWorkspaceCalls.push({ userId, name })
    return {
      workspace: { id: `ws-team-${userId}`, name, slug: `slug-team-${userId}` },
      member: { id: `mem-team-${userId}`, userId, role: 'owner', workspaceId: `ws-team-${userId}` },
    }
  },
  createDefaultTeamWorkspace: async () => {
    throw new Error('createDefaultTeamWorkspace is cloud-only')
  },
  createPersonalWorkspace: async (userId: string, userName: string) => {
    createPersonalWorkspaceCalls.push({ userId, name: userName })
    return {
      workspace: { id: `ws-personal-${userId}`, name: `${userName} Personal`, slug: `slug-personal-${userId}` },
      member: { id: `mem-personal-${userId}`, userId, role: 'owner', workspaceId: `ws-personal-${userId}` },
    }
  },
}))

mock.module('../lib/prisma', () => ({
  prisma: {
    user: {
      findFirst: async ({ orderBy }: any) => {
        if (users.length === 0) return null
        const sorted = [...users].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        return orderBy?.createdAt === 'asc' ? sorted[0] : sorted[sorted.length - 1]
      },
      findUnique: async ({ where }: any) => users.find((u) => u.id === where.id) ?? null,
    },
    localConfig: {
      findMany: async () => localConfigRows,
      deleteMany: async ({ where }: any) => {
        localConfigRows = localConfigRows.filter((r) => r.key !== where.key)
      },
      upsert: async ({ where, create }: any) => {
        const existing = localConfigRows.find((r) => r.key === where.key)
        if (existing) existing.value = create.value
        else localConfigRows.push({ key: where.key, value: create.value })
      },
    },
  },
}))

const { bootstrapLocalDatabase } = await import('../lib/local-bootstrap')

beforeEach(() => {
  users = []
  localConfigRows = []
  ownedPersonalCountByUser = {}
  ownedTeamCountByUser = {}
  createPaidWorkspaceCalls.length = 0
  createPersonalWorkspaceCalls.length = 0
  signUpEmailCalls = 0
  signUpEmailResult = null
})

describe('bootstrapLocalDatabase — local user seeding', () => {
  it('signs up a local user on a fresh install (no existing users)', async () => {
    signUpEmailResult = { user: { id: 'new-user-1', name: 'Local User' } }

    await bootstrapLocalDatabase()

    expect(signUpEmailCalls).toBe(1)
  })

  it('does not sign up again when a user already exists', async () => {
    users = [{ id: 'existing-1', name: 'Russell', createdAt: '2026-01-01T00:00:00.000Z' }]
    ownedPersonalCountByUser['existing-1'] = 1
    ownedTeamCountByUser['existing-1'] = 1 // already has both workspace kinds too

    await bootstrapLocalDatabase()

    expect(signUpEmailCalls).toBe(0)
  })
})

describe('bootstrapLocalDatabase — free team-workspace backfill', () => {
  it('seeds a free team workspace for a freshly signed-up user (who already got personal via the signup hook)', async () => {
    signUpEmailResult = { user: { id: 'new-user-2', name: 'Local User' } }
    // findUnique needs the user to exist for the name lookup after signup.
    users = [{ id: 'new-user-2', name: 'Local User', createdAt: '2026-01-01T00:00:00.000Z' }]
    ownedPersonalCountByUser['new-user-2'] = 1 // simulates the signup hook's createPersonalWorkspace call

    await bootstrapLocalDatabase()

    expect(createPaidWorkspaceCalls).toEqual([{ userId: 'new-user-2', name: 'Local User Team' }])
    expect(createPersonalWorkspaceCalls).toEqual([])
  })

  it('backfills a free team workspace for a pre-existing user who has none (upgrade path)', async () => {
    users = [{ id: 'existing-1', name: 'Russell', createdAt: '2026-01-01T00:00:00.000Z' }]
    ownedPersonalCountByUser['existing-1'] = 1
    ownedTeamCountByUser['existing-1'] = 0

    await bootstrapLocalDatabase()

    expect(createPaidWorkspaceCalls).toEqual([{ userId: 'existing-1', name: 'Russell Team' }])
  })

  it('is idempotent — skips creation when the user already owns a team workspace', async () => {
    users = [{ id: 'existing-1', name: 'Russell', createdAt: '2026-01-01T00:00:00.000Z' }]
    ownedPersonalCountByUser['existing-1'] = 1
    ownedTeamCountByUser['existing-1'] = 1

    await bootstrapLocalDatabase()

    expect(createPaidWorkspaceCalls).toEqual([])
  })

  it('falls back to "Local User Team" when the user has no name', async () => {
    users = [{ id: 'existing-1', name: '', createdAt: '2026-01-01T00:00:00.000Z' }]
    ownedPersonalCountByUser['existing-1'] = 1
    ownedTeamCountByUser['existing-1'] = 0

    await bootstrapLocalDatabase()

    expect(createPaidWorkspaceCalls).toEqual([{ userId: 'existing-1', name: 'Local User Team' }])
  })
})

describe('bootstrapLocalDatabase — free personal-workspace backfill (legacy team-only installs)', () => {
  it('backfills a free personal workspace for a pre-existing user whose only workspace is `team` (pre-createPersonalWorkspace-hook installs)', async () => {
    users = [{ id: 'legacy-1', name: 'Russell', createdAt: '2025-01-01T00:00:00.000Z' }]
    ownedPersonalCountByUser['legacy-1'] = 0
    ownedTeamCountByUser['legacy-1'] = 1 // their original signup workspace, created at the `kind: 'team'` schema default

    await bootstrapLocalDatabase()

    expect(createPersonalWorkspaceCalls).toEqual([{ userId: 'legacy-1', name: 'Russell' }])
    // They already own a team workspace — must not create a second one.
    expect(createPaidWorkspaceCalls).toEqual([])
  })

  it('is idempotent — skips creation when the user already owns a personal workspace', async () => {
    users = [{ id: 'existing-1', name: 'Russell', createdAt: '2026-01-01T00:00:00.000Z' }]
    ownedPersonalCountByUser['existing-1'] = 1
    ownedTeamCountByUser['existing-1'] = 1

    await bootstrapLocalDatabase()

    expect(createPersonalWorkspaceCalls).toEqual([])
  })

  it('falls back to "Local User" when the user has no name', async () => {
    users = [{ id: 'legacy-1', name: '', createdAt: '2025-01-01T00:00:00.000Z' }]
    ownedPersonalCountByUser['legacy-1'] = 0
    ownedTeamCountByUser['legacy-1'] = 1

    await bootstrapLocalDatabase()

    expect(createPersonalWorkspaceCalls).toEqual([{ userId: 'legacy-1', name: 'Local User' }])
  })

  it('backfills both kinds when a pre-existing user somehow has neither (defensive edge case)', async () => {
    users = [{ id: 'orphan-1', name: 'Orphan', createdAt: '2025-01-01T00:00:00.000Z' }]
    ownedPersonalCountByUser['orphan-1'] = 0
    ownedTeamCountByUser['orphan-1'] = 0

    await bootstrapLocalDatabase()

    expect(createPersonalWorkspaceCalls).toEqual([{ userId: 'orphan-1', name: 'Orphan' }])
    expect(createPaidWorkspaceCalls).toEqual([{ userId: 'orphan-1', name: 'Orphan Team' }])
  })
})
