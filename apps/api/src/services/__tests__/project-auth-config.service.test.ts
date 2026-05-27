// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProjectAuthConfig service unit tests.
 *
 * Mocks the Prisma module surface via withPrismaExports so every named
 * export in `../lib/prisma` is satisfied. Uses in-memory stores for
 * projectAuthConfig / projectAuthSignIn / project / user / member /
 * invitation / session.
 *
 * Run: bun test apps/api/src/services/__tests__/project-auth-config.service.test.ts
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from '../../__tests__/helpers/prisma-mock-exports'

type Row = Record<string, any>

let cfgRows: Map<string, Row>
let signInRows: Row[]
let projects: Map<string, Row>
let users: Map<string, Row>
let members: Row[]
let invitations: Row[]
let sessions: Row[]
let nextId = 0
function genId(prefix = 'id'): string { nextId++; return `${prefix}_${nextId}` }

const prismaStub = {
  $transaction: async (fn: any) => fn(prismaStub),
  projectAuthConfig: {
    findUnique: async ({ where }: any) => cfgRows.get(where.projectId) ?? null,
    upsert: async ({ where, create, update }: any) => {
      const existing = cfgRows.get(where.projectId)
      if (existing) {
        Object.assign(existing, update)
        return existing
      }
      const row = { id: genId('cfg'), ...create }
      cfgRows.set(where.projectId, row)
      return row
    },
  },
  projectAuthSignIn: {
    findMany: async ({ where, include, orderBy, take, cursor, skip }: any) => {
      let rows = signInRows.filter((r) => {
        if (where.projectId && r.projectId !== where.projectId) return false
        if (where.user?.OR) {
          const q = where.user.OR[0].email?.contains?.toLowerCase() ?? ''
          if (q) {
            const u = users.get(r.userId)
            const email = (u?.email ?? '').toLowerCase()
            const name = (u?.name ?? '').toLowerCase()
            if (!email.includes(q) && !name.includes(q)) return false
          }
        }
        return true
      })
      rows = [...rows].sort((a, b) => (b.lastSignInAt as Date).getTime() - (a.lastSignInAt as Date).getTime())
      if (cursor) {
        const idx = rows.findIndex((r) => r.id === cursor.id)
        if (idx >= 0) rows = rows.slice(idx + (skip ?? 0))
      }
      if (take) rows = rows.slice(0, take)
      if (include?.user) {
        return rows.map((r) => ({
          ...r,
          user: { id: r.userId, email: users.get(r.userId)?.email ?? null,
                  name: users.get(r.userId)?.name ?? null,
                  emailVerified: !!users.get(r.userId)?.emailVerified },
        }))
      }
      return rows
    },
    upsert: async ({ where, create, update }: any) => {
      const key = `${where.projectId_userId.projectId}:${where.projectId_userId.userId}`
      const existing = signInRows.find((r) => `${r.projectId}:${r.userId}` === key)
      if (existing) {
        if (update.lastSignInAt) existing.lastSignInAt = update.lastSignInAt
        if (update.signInCount?.increment) existing.signInCount += update.signInCount.increment
        return existing
      }
      const row = { id: genId('si'), ...create }
      signInRows.push(row)
      return row
    },
    deleteMany: async ({ where }: any) => {
      const before = signInRows.length
      signInRows = signInRows.filter(
        (r) => !(r.projectId === where.projectId && r.userId === where.userId),
      )
      return { count: before - signInRows.length }
    },
  },
  project: {
    findUnique: async ({ where }: any) => projects.get(where.id) ?? null,
  },
  user: {
    findUnique: async ({ where }: any) => {
      if (where.email) {
        for (const u of users.values()) if (u.email === where.email) return u
        return null
      }
      return users.get(where.id) ?? null
    },
  },
  member: {
    findFirst: async ({ where }: any) =>
      members.find((m) => m.userId === where.userId && m.workspaceId === where.workspaceId) ?? null,
    findMany: async ({ where }: any) => {
      const ids: string[] = where.userId?.in ?? []
      return members.filter((m) => ids.includes(m.userId) && m.workspaceId === where.workspaceId)
    },
  },
  invitation: {
    findFirst: async ({ where }: any) => {
      const now = where.expiresAt?.gt ?? new Date()
      return invitations.find(
        (i) =>
          i.email === where.email &&
          i.workspaceId === where.workspaceId &&
          i.status === where.status &&
          (i.expiresAt as Date) > now,
      ) ?? null
    },
  },
  session: {
    deleteMany: async ({ where }: any) => {
      const before = sessions.length
      sessions = sessions.filter((s) => s.userId !== where.userId)
      return { count: before - sessions.length }
    },
  },
}

mock.module('../../lib/prisma', () => withPrismaExports({ prisma: prismaStub as any }))

import {
  getConfig,
  upsertConfig,
  evaluateAllowlist,
  recordSignIn,
  listUsers,
  revokeUser,
  ProjectAuthConfigError,
} from '../project-auth-config.service'

beforeEach(() => {
  cfgRows = new Map()
  signInRows = []
  projects = new Map()
  users = new Map()
  members = []
  invitations = []
  sessions = []
  nextId = 0
})

describe('getConfig', () => {
  test('returns default config when no row exists', async () => {
    const r = await getConfig('p1')
    expect(r).toEqual({ mode: 'anyone', allowedEmails: [], allowedDomains: [], requireEmailVerification: false })
  })

  test('returns stored config verbatim', async () => {
    cfgRows.set('p1', {
      id: 'c1', projectId: 'p1', mode: 'custom',
      allowedEmails: ['a@b.com'], allowedDomains: ['c.com'],
      requireEmailVerification: true,
    })
    const r = await getConfig('p1')
    expect(r).toEqual({
      mode: 'custom', allowedEmails: ['a@b.com'], allowedDomains: ['c.com'],
      requireEmailVerification: true,
    })
  })

  test('falls back to anyone when stored mode is invalid', async () => {
    cfgRows.set('p1', {
      id: 'c1', projectId: 'p1', mode: 'bogus',
      allowedEmails: ['a@b.com'], allowedDomains: [],
      requireEmailVerification: false,
    })
    expect((await getConfig('p1')).mode).toBe('anyone')
  })

  test('coerces non-array email/domain fields to []', async () => {
    cfgRows.set('p1', {
      id: 'c1', projectId: 'p1', mode: 'custom',
      allowedEmails: null, allowedDomains: 'oops',
      requireEmailVerification: 0,
    })
    const r = await getConfig('p1')
    expect(r.allowedEmails).toEqual([])
    expect(r.allowedDomains).toEqual([])
    expect(r.requireEmailVerification).toBe(false)
  })
})

describe('upsertConfig — validation', () => {
  test('rejects invalid mode', async () => {
    await expect(upsertConfig('p1', { mode: 'xxx' })).rejects.toBeInstanceOf(ProjectAuthConfigError)
  })
  test('rejects non-string mode', async () => {
    await expect(upsertConfig('p1', { mode: 42 })).rejects.toBeInstanceOf(ProjectAuthConfigError)
  })
  test('rejects non-array allowedEmails', async () => {
    await expect(upsertConfig('p1', { allowedEmails: 'not-array' as any })).rejects.toBeInstanceOf(ProjectAuthConfigError)
  })
  test('rejects non-array allowedDomains', async () => {
    await expect(upsertConfig('p1', { allowedDomains: {} })).rejects.toBeInstanceOf(ProjectAuthConfigError)
  })
  test('rejects non-string email in allowedEmails', async () => {
    await expect(upsertConfig('p1', { allowedEmails: [42] as any })).rejects.toBeInstanceOf(ProjectAuthConfigError)
  })
  test('rejects malformed email', async () => {
    await expect(upsertConfig('p1', { allowedEmails: ['not-an-email'] })).rejects.toBeInstanceOf(ProjectAuthConfigError)
  })
  test('rejects malformed domain', async () => {
    await expect(upsertConfig('p1', { allowedDomains: ['..no-dot'] })).rejects.toBeInstanceOf(ProjectAuthConfigError)
  })
  test('rejects non-string domain', async () => {
    await expect(upsertConfig('p1', { allowedDomains: [42] as any })).rejects.toBeInstanceOf(ProjectAuthConfigError)
  })
  test('rejects non-boolean requireEmailVerification', async () => {
    await expect(upsertConfig('p1', { requireEmailVerification: 'true' })).rejects.toBeInstanceOf(ProjectAuthConfigError)
  })
})

describe('upsertConfig — normalization', () => {
  test('lowercases + dedupes emails', async () => {
    const r = await upsertConfig('p1', { mode: 'custom', allowedEmails: ['A@B.com', 'a@b.com', 'C@d.com'] })
    expect(r.allowedEmails).toEqual(['a@b.com', 'c@d.com'])
  })
  test('strips leading @ + lowercases + dedupes domains', async () => {
    const r = await upsertConfig('p1', {
      mode: 'custom',
      allowedDomains: ['@Example.com', 'example.com', 'OTHER.org'],
    })
    expect(r.allowedDomains).toEqual(['example.com', 'other.org'])
  })
  test('persists requireEmailVerification', async () => {
    const r = await upsertConfig('p1', { requireEmailVerification: true })
    expect(r.requireEmailVerification).toBe(true)
  })
  test('preserves existing fields when input is partial', async () => {
    cfgRows.set('p1', {
      id: 'c1', projectId: 'p1', mode: 'custom',
      allowedEmails: ['old@x.com'], allowedDomains: ['x.com'],
      requireEmailVerification: true,
    })
    const r = await upsertConfig('p1', { mode: 'anyone' })
    expect(r).toEqual({
      mode: 'anyone',
      allowedEmails: ['old@x.com'],
      allowedDomains: ['x.com'],
      requireEmailVerification: true,
    })
  })
  test('defaults mode to anyone when no input + no existing', async () => {
    const r = await upsertConfig('p1', {})
    expect(r.mode).toBe('anyone')
  })
})

describe('evaluateAllowlist', () => {
  test('email_invalid for malformed email', async () => {
    expect(await evaluateAllowlist('p1', 'not-an-email')).toEqual({ allowed: false, reason: 'email_invalid' })
  })
  test('anyone mode → always allowed', async () => {
    expect(await evaluateAllowlist('p1', 'user@x.com')).toEqual({ allowed: true })
  })
  test('custom mode → allowed via allowedEmails', async () => {
    cfgRows.set('p1', { id: 'c', projectId: 'p1', mode: 'custom', allowedEmails: ['u@x.com'], allowedDomains: [], requireEmailVerification: false })
    expect(await evaluateAllowlist('p1', 'U@X.com')).toEqual({ allowed: true })
  })
  test('custom mode → allowed via allowedDomains', async () => {
    cfgRows.set('p1', { id: 'c', projectId: 'p1', mode: 'custom', allowedEmails: [], allowedDomains: ['x.com'], requireEmailVerification: false })
    expect(await evaluateAllowlist('p1', 'u@x.com')).toEqual({ allowed: true })
  })
  test('custom mode → rejected when neither match', async () => {
    cfgRows.set('p1', { id: 'c', projectId: 'p1', mode: 'custom', allowedEmails: ['other@y.com'], allowedDomains: ['y.com'], requireEmailVerification: false })
    expect(await evaluateAllowlist('p1', 'u@z.com')).toEqual({ allowed: false, reason: 'custom_not_listed' })
  })
  test('workspace mode → rejected when project does not exist', async () => {
    cfgRows.set('p1', { id: 'c', projectId: 'p1', mode: 'workspace', allowedEmails: [], allowedDomains: [], requireEmailVerification: false })
    expect(await evaluateAllowlist('p1', 'u@x.com')).toEqual({ allowed: false, reason: 'workspace_not_member' })
  })
  test('workspace mode → allowed when user is a member', async () => {
    projects.set('p1', { id: 'p1', workspaceId: 'w1' })
    cfgRows.set('p1', { id: 'c', projectId: 'p1', mode: 'workspace', allowedEmails: [], allowedDomains: [], requireEmailVerification: false })
    users.set('u1', { id: 'u1', email: 'u@x.com' })
    members.push({ userId: 'u1', workspaceId: 'w1' })
    expect(await evaluateAllowlist('p1', 'u@x.com')).toEqual({ allowed: true })
  })
  test('workspace mode → allowed via pending invitation when no member row', async () => {
    projects.set('p1', { id: 'p1', workspaceId: 'w1' })
    cfgRows.set('p1', { id: 'c', projectId: 'p1', mode: 'workspace', allowedEmails: [], allowedDomains: [], requireEmailVerification: false })
    invitations.push({
      email: 'pending@x.com', workspaceId: 'w1', status: 'pending',
      expiresAt: new Date(Date.now() + 86400000),
    })
    expect(await evaluateAllowlist('p1', 'pending@x.com')).toEqual({ allowed: true })
  })
  test('workspace mode → rejected when invitation is expired', async () => {
    projects.set('p1', { id: 'p1', workspaceId: 'w1' })
    cfgRows.set('p1', { id: 'c', projectId: 'p1', mode: 'workspace', allowedEmails: [], allowedDomains: [], requireEmailVerification: false })
    invitations.push({
      email: 'expired@x.com', workspaceId: 'w1', status: 'pending',
      expiresAt: new Date(Date.now() - 1000),
    })
    expect(await evaluateAllowlist('p1', 'expired@x.com')).toEqual({ allowed: false, reason: 'workspace_not_member' })
  })
  test('workspace mode → rejected when user exists but no member + no invite', async () => {
    projects.set('p1', { id: 'p1', workspaceId: 'w1' })
    cfgRows.set('p1', { id: 'c', projectId: 'p1', mode: 'workspace', allowedEmails: [], allowedDomains: [], requireEmailVerification: false })
    users.set('u1', { id: 'u1', email: 'u@x.com' })
    expect(await evaluateAllowlist('p1', 'u@x.com')).toEqual({ allowed: false, reason: 'workspace_not_member' })
  })
})

describe('recordSignIn', () => {
  test('creates a row on first sign-in', async () => {
    await recordSignIn('p1', 'u1')
    expect(signInRows.length).toBe(1)
    expect(signInRows[0]).toMatchObject({ projectId: 'p1', userId: 'u1', signInCount: 1 })
  })
  test('increments signInCount and bumps lastSignInAt on subsequent calls', async () => {
    await recordSignIn('p1', 'u1')
    const t1 = signInRows[0].lastSignInAt
    await new Promise(r => setTimeout(r, 5))
    await recordSignIn('p1', 'u1')
    expect(signInRows.length).toBe(1)
    expect(signInRows[0].signInCount).toBe(2)
    expect((signInRows[0].lastSignInAt as Date).getTime()).toBeGreaterThan((t1 as Date).getTime())
  })
})

describe('listUsers', () => {
  beforeEach(() => {
    projects.set('p1', { id: 'p1', workspaceId: 'w1' })
    users.set('u1', { id: 'u1', email: 'a@x.com', name: 'Alice', emailVerified: true })
    users.set('u2', { id: 'u2', email: 'b@y.com', name: 'Bob', emailVerified: false })
    users.set('u3', { id: 'u3', email: 'c@z.com', name: 'Carol', emailVerified: true })
    signInRows.push({ id: 's1', projectId: 'p1', userId: 'u1', firstSignInAt: new Date(2026, 0, 1), lastSignInAt: new Date(2026, 0, 5), signInCount: 3 })
    signInRows.push({ id: 's2', projectId: 'p1', userId: 'u2', firstSignInAt: new Date(2026, 0, 2), lastSignInAt: new Date(2026, 0, 7), signInCount: 1 })
    signInRows.push({ id: 's3', projectId: 'p1', userId: 'u3', firstSignInAt: new Date(2026, 0, 3), lastSignInAt: new Date(2026, 0, 9), signInCount: 5 })
    members.push({ userId: 'u1', workspaceId: 'w1' })
  })

  test('returns empty when project does not exist', async () => {
    const r = await listUsers('missing')
    expect(r).toEqual({ items: [], nextCursor: null })
  })

  test('lists users sorted by lastSignInAt desc', async () => {
    const r = await listUsers('p1')
    expect(r.items.map(i => i.userId)).toEqual(['u3', 'u2', 'u1'])
    expect(r.nextCursor).toBeNull()
  })

  test('flags isWorkspaceMember based on member rows', async () => {
    const r = await listUsers('p1')
    const u1 = r.items.find(i => i.userId === 'u1')!
    const u2 = r.items.find(i => i.userId === 'u2')!
    expect(u1.isWorkspaceMember).toBe(true)
    expect(u2.isWorkspaceMember).toBe(false)
  })

  test('flags isAllowlisted via email + domain', async () => {
    cfgRows.set('p1', {
      id: 'c', projectId: 'p1', mode: 'custom',
      allowedEmails: ['a@x.com'], allowedDomains: ['z.com'],
      requireEmailVerification: false,
    })
    const r = await listUsers('p1')
    expect(r.items.find(i => i.userId === 'u1')!.isAllowlisted).toBe(true)
    expect(r.items.find(i => i.userId === 'u2')!.isAllowlisted).toBe(false)
    expect(r.items.find(i => i.userId === 'u3')!.isAllowlisted).toBe(true)
  })

  test('respects limit and returns nextCursor when more rows exist', async () => {
    const r = await listUsers('p1', { limit: 2 })
    expect(r.items.length).toBe(2)
    expect(r.nextCursor).not.toBeNull()
  })

  test('clamps limit to [1, 100]', async () => {
    expect((await listUsers('p1', { limit: 0 })).items.length).toBeLessThanOrEqual(3)
    expect((await listUsers('p1', { limit: 999 })).items.length).toBeLessThanOrEqual(3)
  })

  test('query filters by email containment', async () => {
    const r = await listUsers('p1', { query: 'y.com' })
    expect(r.items.map(i => i.userId)).toEqual(['u2'])
  })

  test('query filters by name containment', async () => {
    const r = await listUsers('p1', { query: 'arol' })
    expect(r.items.map(i => i.userId)).toEqual(['u3'])
  })

  test('whitespace-only query is treated as no filter', async () => {
    const r = await listUsers('p1', { query: '   ' })
    expect(r.items.length).toBe(3)
  })
})

describe('revokeUser', () => {
  test('deletes the audit row + invalidates sessions for the user', async () => {
    signInRows.push({ id: 's1', projectId: 'p1', userId: 'u1', firstSignInAt: new Date(), lastSignInAt: new Date(), signInCount: 1 })
    signInRows.push({ id: 's2', projectId: 'p1', userId: 'u2', firstSignInAt: new Date(), lastSignInAt: new Date(), signInCount: 1 })
    sessions.push({ id: 'sess1', userId: 'u1' })
    sessions.push({ id: 'sess2', userId: 'u2' })
    await revokeUser('p1', 'u1')
    expect(signInRows.map(r => r.userId)).toEqual(['u2'])
    expect(sessions.map(s => s.userId)).toEqual(['u2'])
  })

  test('is idempotent when user has no rows', async () => {
    await revokeUser('p1', 'nonexistent')
  })
})
