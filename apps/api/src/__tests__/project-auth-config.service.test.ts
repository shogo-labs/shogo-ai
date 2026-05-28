// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// End-to-end coverage for src/services/project-auth-config.service.ts.
// Uses an in-memory prisma double — every prisma method this service
// reaches into is implemented against plain Maps so we drive real
// branch logic, not just verify the mock got called.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

interface AuthConfigRow {
  projectId: string
  mode: string
  allowedEmails: string[]
  allowedDomains: string[]
  requireEmailVerification: boolean
}
interface SignInRow {
  id: string
  projectId: string
  userId: string
  firstSignInAt: Date
  lastSignInAt: Date
  signInCount: number
}
interface ProjectRow { id: string; workspaceId: string }
interface UserRow { id: string; email: string; name: string | null; emailVerified: boolean }
interface MemberRow { id: string; userId: string; workspaceId: string }
interface InvitationRow {
  id: string; email: string; workspaceId: string; status: string; expiresAt: Date
}

const db = {
  authConfigs: new Map<string, AuthConfigRow>(),
  signIns: new Map<string, SignInRow>(),
  projects: new Map<string, ProjectRow>(),
  users: new Map<string, UserRow>(),
  members: [] as MemberRow[],
  invitations: [] as InvitationRow[],
  sessions: [] as { id: string; userId: string }[],
}

let signInIdCounter = 0
const nextSignInKey = (projectId: string, userId: string) => `${projectId}:${userId}`

mock.module('../lib/prisma', () => ({
  prisma: {
    projectAuthConfig: {
      findUnique: async ({ where }: { where: { projectId: string } }) =>
        db.authConfigs.get(where.projectId) ?? null,
      upsert: async ({
        where, create, update,
      }: { where: { projectId: string }; create: AuthConfigRow; update: Partial<AuthConfigRow> }) => {
        const existing = db.authConfigs.get(where.projectId)
        if (!existing) {
          db.authConfigs.set(where.projectId, { ...create })
          return create
        }
        Object.assign(existing, update)
        return existing
      },
    },
    projectAuthSignIn: {
      upsert: async ({
        where, create, update,
      }: {
        where: { projectId_userId: { projectId: string; userId: string } }
        create: Omit<SignInRow, 'id'>
        update: { lastSignInAt: Date; signInCount: { increment: number } }
      }) => {
        const key = nextSignInKey(where.projectId_userId.projectId, where.projectId_userId.userId)
        const existing = db.signIns.get(key)
        if (!existing) {
          signInIdCounter += 1
          const row: SignInRow = { ...create, id: `si-${signInIdCounter}` }
          db.signIns.set(key, row)
          return row
        }
        existing.lastSignInAt = update.lastSignInAt
        existing.signInCount += update.signInCount.increment
        return existing
      },
      findMany: async ({
        where, include: _include, orderBy, take, cursor, skip,
      }: {
        where: { projectId: string; user?: { OR: Array<{ email?: { contains: string }; name?: { contains: string } }> } }
        include?: unknown
        orderBy?: { lastSignInAt: 'asc' | 'desc' }
        take?: number
        cursor?: { id: string }
        skip?: number
      }) => {
        let rows = Array.from(db.signIns.values()).filter((r) => r.projectId === where.projectId)
        if (where.user?.OR) {
          rows = rows.filter((r) => {
            const u = db.users.get(r.userId)
            if (!u) return false
            return where.user!.OR.some((cond) => {
              if (cond.email && u.email.toLowerCase().includes(cond.email.contains.toLowerCase())) return true
              if (cond.name && (u.name ?? '').toLowerCase().includes(cond.name.contains.toLowerCase())) return true
              return false
            })
          })
        }
        rows.sort((a, b) =>
          orderBy?.lastSignInAt === 'desc'
            ? b.lastSignInAt.getTime() - a.lastSignInAt.getTime()
            : a.lastSignInAt.getTime() - b.lastSignInAt.getTime(),
        )
        if (cursor) {
          const idx = rows.findIndex((r) => r.id === cursor.id)
          if (idx >= 0) rows = rows.slice(idx + (skip ?? 0))
        }
        const out = take !== undefined ? rows.slice(0, take) : rows
        return out.map((r) => ({
          ...r,
          user: db.users.get(r.userId) ?? { id: r.userId, email: '', name: null, emailVerified: false },
        }))
      },
      deleteMany: async ({ where }: { where: { projectId: string; userId: string } }) => {
        const key = nextSignInKey(where.projectId, where.userId)
        const had = db.signIns.delete(key)
        return { count: had ? 1 : 0 }
      },
    },
    project: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.projects.get(where.id) ?? null,
    },
    user: {
      findUnique: async ({ where }: { where: { email: string } }) => {
        for (const u of db.users.values()) if (u.email.toLowerCase() === where.email.toLowerCase()) return u
        return null
      },
    },
    member: {
      findFirst: async ({ where }: { where: { userId: string; workspaceId: string } }) =>
        db.members.find((m) => m.userId === where.userId && m.workspaceId === where.workspaceId) ?? null,
      findMany: async ({ where }: { where: { userId: { in: string[] }; workspaceId: string } }) =>
        db.members.filter((m) => where.userId.in.includes(m.userId) && m.workspaceId === where.workspaceId),
    },
    invitation: {
      findFirst: async ({
        where,
      }: { where: { email: string; workspaceId: string; status: string; expiresAt: { gt: Date } } }) =>
        db.invitations.find(
          (i) =>
            i.email.toLowerCase() === where.email.toLowerCase() &&
            i.workspaceId === where.workspaceId &&
            i.status === where.status &&
            i.expiresAt.getTime() > where.expiresAt.gt.getTime(),
        ) ?? null,
    },
    session: {
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        const before = db.sessions.length
        db.sessions = db.sessions.filter((s) => s.userId !== where.userId)
        return { count: before - db.sessions.length }
      },
    },
  },
}))

const svc = await import('../services/project-auth-config.service')

beforeEach(() => {
  db.authConfigs.clear()
  db.signIns.clear()
  db.projects.clear()
  db.users.clear()
  db.members = []
  db.invitations = []
  db.sessions = []
  signInIdCounter = 0
})

afterEach(() => {
  db.authConfigs.clear()
  db.signIns.clear()
  db.projects.clear()
  db.users.clear()
  db.members = []
  db.invitations = []
  db.sessions = []
})

describe('getConfig', () => {
  test('returns DEFAULT_CONFIG when no row exists', async () => {
    const cfg = await svc.getConfig('proj-missing')
    expect(cfg).toEqual({
      mode: 'anyone',
      allowedEmails: [],
      allowedDomains: [],
      requireEmailVerification: false,
    })
  })

  test('returns stored config verbatim', async () => {
    db.authConfigs.set('proj-1', {
      projectId: 'proj-1',
      mode: 'custom',
      allowedEmails: ['user@a.com'],
      allowedDomains: ['b.com'],
      requireEmailVerification: true,
    })
    const cfg = await svc.getConfig('proj-1')
    expect(cfg.mode).toBe('custom')
    expect(cfg.allowedEmails).toEqual(['user@a.com'])
    expect(cfg.allowedDomains).toEqual(['b.com'])
    expect(cfg.requireEmailVerification).toBe(true)
  })

  test('coerces an invalid mode value to "anyone"', async () => {
    db.authConfigs.set('proj-x', {
      projectId: 'proj-x',
      mode: 'bogus-mode-not-valid',
      allowedEmails: [],
      allowedDomains: [],
      requireEmailVerification: false,
    })
    const cfg = await svc.getConfig('proj-x')
    expect(cfg.mode).toBe('anyone')
  })

  test('coerces null/non-array allowedEmails/allowedDomains to []', async () => {
    db.authConfigs.set('proj-y', {
      projectId: 'proj-y',
      mode: 'custom',
      allowedEmails: null as unknown as string[],
      allowedDomains: 'not-an-array' as unknown as string[],
      requireEmailVerification: false,
    })
    const cfg = await svc.getConfig('proj-y')
    expect(cfg.allowedEmails).toEqual([])
    expect(cfg.allowedDomains).toEqual([])
  })
})

describe('upsertConfig — happy paths', () => {
  test('creates row from empty input (defaults to anyone)', async () => {
    const cfg = await svc.upsertConfig('proj-new', {})
    expect(cfg.mode).toBe('anyone')
    expect(cfg.allowedEmails).toEqual([])
    expect(cfg.allowedDomains).toEqual([])
    expect(cfg.requireEmailVerification).toBe(false)
    expect(db.authConfigs.get('proj-new')).toBeDefined()
  })

  test('creates row with mode=custom and dedupe/lowercase email + domain lists', async () => {
    const cfg = await svc.upsertConfig('proj-2', {
      mode: 'custom',
      allowedEmails: ['Foo@Example.com', 'foo@example.com', 'BAR@ex.com'],
      allowedDomains: ['Acme.com', 'acme.com', '@OtherCo.io'],
      requireEmailVerification: true,
    })
    expect(cfg.mode).toBe('custom')
    expect(cfg.allowedEmails).toEqual(['foo@example.com', 'bar@ex.com'])
    expect(cfg.allowedDomains).toEqual(['acme.com', 'otherco.io'])
    expect(cfg.requireEmailVerification).toBe(true)
  })

  test('update preserves prior fields when input omits them', async () => {
    await svc.upsertConfig('proj-3', {
      mode: 'custom',
      allowedEmails: ['a@b.com'],
      allowedDomains: ['b.com'],
      requireEmailVerification: true,
    })
    const cfg = await svc.upsertConfig('proj-3', { allowedEmails: ['c@d.com'] })
    expect(cfg.mode).toBe('custom')
    expect(cfg.allowedEmails).toEqual(['c@d.com'])
    expect(cfg.allowedDomains).toEqual(['b.com'])
    expect(cfg.requireEmailVerification).toBe(true)
  })

  test('mode=workspace round-trips', async () => {
    const cfg = await svc.upsertConfig('proj-4', { mode: 'workspace' })
    expect(cfg.mode).toBe('workspace')
  })
})

describe('upsertConfig — validation errors', () => {
  test('invalid mode value', async () => {
    await expect(svc.upsertConfig('p', { mode: 'bogus' })).rejects.toMatchObject({
      code: 'invalid_mode',
    })
  })

  test('mode is not a string', async () => {
    await expect(svc.upsertConfig('p', { mode: 42 })).rejects.toMatchObject({
      code: 'invalid_mode',
    })
  })

  test('allowedEmails not array', async () => {
    await expect(
      svc.upsertConfig('p', { allowedEmails: 'foo@bar.com' as unknown as unknown[] }),
    ).rejects.toMatchObject({ code: 'invalid_emails' })
  })

  test('allowedEmails contains a non-string', async () => {
    await expect(
      svc.upsertConfig('p', { allowedEmails: [42] as unknown as unknown[] }),
    ).rejects.toMatchObject({ code: 'invalid_email' })
  })

  test('allowedEmails contains a bad email', async () => {
    await expect(
      svc.upsertConfig('p', { allowedEmails: ['not-an-email'] }),
    ).rejects.toMatchObject({ code: 'invalid_email' })
  })

  test('allowedDomains not array', async () => {
    await expect(
      svc.upsertConfig('p', { allowedDomains: 'acme.com' as unknown as unknown[] }),
    ).rejects.toMatchObject({ code: 'invalid_domains' })
  })

  test('allowedDomains contains non-string', async () => {
    await expect(
      svc.upsertConfig('p', { allowedDomains: [123] as unknown as unknown[] }),
    ).rejects.toMatchObject({ code: 'invalid_domain' })
  })

  test('allowedDomains contains a bad domain', async () => {
    await expect(
      svc.upsertConfig('p', { allowedDomains: ['nodot'] }),
    ).rejects.toMatchObject({ code: 'invalid_domain' })
  })

  test('requireEmailVerification not boolean', async () => {
    await expect(
      svc.upsertConfig('p', { requireEmailVerification: 'true' as unknown as boolean }),
    ).rejects.toMatchObject({ code: 'invalid_require_email_verification' })
  })

  test('ProjectAuthConfigError shape: name, code, message', async () => {
    try {
      await svc.upsertConfig('p', { mode: 'bogus' })
      expect(false).toBe(true)
    } catch (e) {
      const err = e as { name: string; code: string; message: string }
      expect(err.name).toBe('ProjectAuthConfigError')
      expect(err.code).toBe('invalid_mode')
      expect(err.message).toMatch(/anyone/)
    }
  })
})

describe('evaluateAllowlist', () => {
  test('rejects malformed email', async () => {
    const r = await svc.evaluateAllowlist('p', 'not-an-email')
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('email_invalid')
  })

  test('mode=anyone (no row) -> allowed', async () => {
    const r = await svc.evaluateAllowlist('p-no-row', 'someone@example.com')
    expect(r.allowed).toBe(true)
  })

  test('mode=custom with email in allowlist -> allowed', async () => {
    db.authConfigs.set('p1', {
      projectId: 'p1', mode: 'custom',
      allowedEmails: ['ok@example.com'], allowedDomains: [],
      requireEmailVerification: false,
    })
    const r = await svc.evaluateAllowlist('p1', 'OK@example.com')
    expect(r.allowed).toBe(true)
  })

  test('mode=custom with domain in allowlist -> allowed', async () => {
    db.authConfigs.set('p2', {
      projectId: 'p2', mode: 'custom',
      allowedEmails: [], allowedDomains: ['acme.com'],
      requireEmailVerification: false,
    })
    const r = await svc.evaluateAllowlist('p2', 'who@acme.com')
    expect(r.allowed).toBe(true)
  })

  test('mode=custom not listed -> custom_not_listed', async () => {
    db.authConfigs.set('p3', {
      projectId: 'p3', mode: 'custom',
      allowedEmails: ['a@b.com'], allowedDomains: ['c.com'],
      requireEmailVerification: false,
    })
    const r = await svc.evaluateAllowlist('p3', 'who@elsewhere.io')
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('custom_not_listed')
  })

  test('mode=workspace no project row -> workspace_not_member', async () => {
    db.authConfigs.set('p4', {
      projectId: 'p4', mode: 'workspace',
      allowedEmails: [], allowedDomains: [], requireEmailVerification: false,
    })
    const r = await svc.evaluateAllowlist('p4', 'user@x.com')
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('workspace_not_member')
  })

  test('mode=workspace user is a member -> allowed', async () => {
    db.authConfigs.set('p5', {
      projectId: 'p5', mode: 'workspace',
      allowedEmails: [], allowedDomains: [], requireEmailVerification: false,
    })
    db.projects.set('p5', { id: 'p5', workspaceId: 'ws-5' })
    db.users.set('u-5', { id: 'u-5', email: 'member@x.com', name: 'M', emailVerified: true })
    db.members.push({ id: 'm-5', userId: 'u-5', workspaceId: 'ws-5' })
    const r = await svc.evaluateAllowlist('p5', 'member@x.com')
    expect(r.allowed).toBe(true)
  })

  test('mode=workspace user exists but no membership -> workspace_not_member', async () => {
    db.authConfigs.set('p6', {
      projectId: 'p6', mode: 'workspace',
      allowedEmails: [], allowedDomains: [], requireEmailVerification: false,
    })
    db.projects.set('p6', { id: 'p6', workspaceId: 'ws-6' })
    db.users.set('u-6', { id: 'u-6', email: 'nope@x.com', name: null, emailVerified: false })
    const r = await svc.evaluateAllowlist('p6', 'nope@x.com')
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('workspace_not_member')
  })

  test('mode=workspace pending invitation -> allowed', async () => {
    db.authConfigs.set('p7', {
      projectId: 'p7', mode: 'workspace',
      allowedEmails: [], allowedDomains: [], requireEmailVerification: false,
    })
    db.projects.set('p7', { id: 'p7', workspaceId: 'ws-7' })
    db.invitations.push({
      id: 'inv-7', email: 'invited@x.com', workspaceId: 'ws-7',
      status: 'pending', expiresAt: new Date(Date.now() + 86400e3),
    })
    const r = await svc.evaluateAllowlist('p7', 'INVITED@x.com')
    expect(r.allowed).toBe(true)
  })

  test('mode=workspace expired invitation -> workspace_not_member', async () => {
    db.authConfigs.set('p8', {
      projectId: 'p8', mode: 'workspace',
      allowedEmails: [], allowedDomains: [], requireEmailVerification: false,
    })
    db.projects.set('p8', { id: 'p8', workspaceId: 'ws-8' })
    db.invitations.push({
      id: 'inv-8', email: 'expired@x.com', workspaceId: 'ws-8',
      status: 'pending', expiresAt: new Date(Date.now() - 86400e3),
    })
    const r = await svc.evaluateAllowlist('p8', 'expired@x.com')
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('workspace_not_member')
  })
})

describe('recordSignIn', () => {
  test('creates first sign-in row', async () => {
    await svc.recordSignIn('proj-r', 'user-r')
    const row = db.signIns.get('proj-r:user-r')
    expect(row).toBeDefined()
    expect(row?.signInCount).toBe(1)
  })

  test('increments on subsequent sign-in', async () => {
    await svc.recordSignIn('proj-r', 'user-r')
    await svc.recordSignIn('proj-r', 'user-r')
    await svc.recordSignIn('proj-r', 'user-r')
    expect(db.signIns.get('proj-r:user-r')?.signInCount).toBe(3)
  })
})

describe('listUsers', () => {
  beforeEach(() => {
    db.projects.set('proj-L', { id: 'proj-L', workspaceId: 'ws-L' })
    db.users.set('u-a', { id: 'u-a', email: 'a@a.com', name: 'Alpha', emailVerified: true })
    db.users.set('u-b', { id: 'u-b', email: 'b@acme.com', name: 'Bravo', emailVerified: false })
    db.users.set('u-c', { id: 'u-c', email: 'c@c.com', name: null, emailVerified: false })
    db.members.push({ id: 'm-a', userId: 'u-a', workspaceId: 'ws-L' })
    db.authConfigs.set('proj-L', {
      projectId: 'proj-L', mode: 'custom',
      allowedEmails: ['c@c.com'], allowedDomains: ['acme.com'],
      requireEmailVerification: false,
    })
    const t0 = new Date('2026-01-01T00:00:00Z').getTime()
    signInIdCounter = 0
    for (const [uid, offset] of [['u-a', 0], ['u-b', 1000], ['u-c', 2000]] as const) {
      signInIdCounter += 1
      db.signIns.set(`proj-L:${uid}`, {
        id: `si-${signInIdCounter}`,
        projectId: 'proj-L',
        userId: uid,
        firstSignInAt: new Date(t0 + offset),
        lastSignInAt: new Date(t0 + offset),
        signInCount: 1,
      })
    }
  })

  test('returns empty when project missing', async () => {
    const r = await svc.listUsers('proj-missing')
    expect(r.items).toEqual([])
    expect(r.nextCursor).toBeNull()
  })

  test('lists users with membership + allowlist flags', async () => {
    const r = await svc.listUsers('proj-L')
    expect(r.items).toHaveLength(3)
    const byEmail = Object.fromEntries(r.items.map((i) => [i.email, i]))
    expect(byEmail['a@a.com']!.isWorkspaceMember).toBe(true)
    expect(byEmail['a@a.com']!.isAllowlisted).toBe(false)
    expect(byEmail['b@acme.com']!.isWorkspaceMember).toBe(false)
    expect(byEmail['b@acme.com']!.isAllowlisted).toBe(true)
    expect(byEmail['c@c.com']!.isAllowlisted).toBe(true)
  })

  test('respects limit + sets nextCursor when more pages exist', async () => {
    const r = await svc.listUsers('proj-L', { limit: 2 })
    expect(r.items).toHaveLength(2)
    expect(r.nextCursor).not.toBeNull()
  })

  test('limit is clamped to [1,100]', async () => {
    const r = await svc.listUsers('proj-L', { limit: 999 })
    expect(r.items.length).toBeLessThanOrEqual(100)
    const r2 = await svc.listUsers('proj-L', { limit: 0 })
    expect(r2.items.length).toBeGreaterThanOrEqual(1)
  })

  test('query filter narrows to matching email/name (case-insensitive)', async () => {
    const r = await svc.listUsers('proj-L', { query: 'BRAVO' })
    expect(r.items.map((i) => i.userId)).toEqual(['u-b'])
  })
})

describe('revokeUser', () => {
  test('deletes sign-in row + all sessions for user', async () => {
    db.signIns.set('proj-rv:u-rv', {
      id: 'si-1', projectId: 'proj-rv', userId: 'u-rv',
      firstSignInAt: new Date(), lastSignInAt: new Date(), signInCount: 5,
    })
    db.sessions.push({ id: 's1', userId: 'u-rv' }, { id: 's2', userId: 'u-rv' }, { id: 's3', userId: 'other' })
    await svc.revokeUser('proj-rv', 'u-rv')
    expect(db.signIns.has('proj-rv:u-rv')).toBe(false)
    expect(db.sessions.find((s) => s.userId === 'u-rv')).toBeUndefined()
    expect(db.sessions.find((s) => s.userId === 'other')).toBeDefined()
  })

  test('idempotent — no row to delete is fine', async () => {
    await expect(svc.revokeUser('proj-rv', 'u-missing')).resolves.toBeUndefined()
  })
})
