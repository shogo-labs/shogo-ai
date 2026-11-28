// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Your idea is still waiting" sweep (SHO-615, growth plan §0 G9b).
 *
 * The once-only nudge for a signup with no project 24–72h after signup: the
 * window, the opt-out / no-project gates, the prompt recovery from the onboarding
 * chat, the examples fallback, and the ledger that makes a second run a no-op or
 * a retry after a failed send. Email is faked; the ledger runs for real over an
 * in-memory prisma.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test'

process.env.BETTER_AUTH_SECRET ||= 'lifecycle-nurture-test-secret'
process.env.APP_URL = 'https://app.test'

const HOUR = 60 * 60 * 1000
const NOW = new Date('2026-11-29T12:00:00.000Z')

// ─── in-memory state ─────────────────────────────────────────────────────
interface FakeUser { id: string; email: string; createdAt: Date; lifecycleEmailOptOutAt: Date | null }
let users: FakeUser[] = []
let projectOwnerIds: string[] = []
let sessions: Record<string, { id: string; inferredName: string }> = {}
let firstMessages: Record<string, string> = {}
const ledger = new Map<string, boolean>()

mock.module('../../lib/prisma', () => ({
  prisma: {
    user: {
      findMany: async ({ where, take }: any) => {
        const gte = where.createdAt.gte.getTime()
        const lte = where.createdAt.lte.getTime()
        return users
          .filter((u) => u.createdAt.getTime() >= gte && u.createdAt.getTime() <= lte)
          .filter((u) => u.lifecycleEmailOptOutAt === null)
          .slice(0, take)
          .map((u) => ({ id: u.id, email: u.email }))
      },
      findUnique: async ({ where }: any) => {
        const u = users.find((x) => x.id === where.id)
        return u ? { lifecycleEmailOptOutAt: u.lifecycleEmailOptOutAt } : null
      },
    },
    project: {
      findMany: async ({ where }: any) => {
        const ids: string[] = where.createdBy.in
        return projectOwnerIds.filter((id) => ids.includes(id)).map((createdBy) => ({ createdBy }))
      },
    },
    chatSession: {
      findFirst: async ({ where }: any) => sessions[where.createdByUserId] ?? null,
    },
    chatMessage: {
      findFirst: async ({ where }: any) => {
        const content = firstMessages[where.sessionId]
        return content ? { content } : null
      },
    },
    lifecycleEmailSend: {
      create: async ({ data }: any) => {
        if (ledger.has(data.id)) {
          const err: any = new Error('Unique constraint failed')
          err.code = 'P2002'
          throw err
        }
        ledger.set(data.id, true)
        return data
      },
      delete: async ({ where }: any) => {
        if (!ledger.has(where.id)) {
          const err: any = new Error('not found')
          err.code = 'P2025'
          throw err
        }
        ledger.delete(where.id)
        return {}
      },
    },
  },
}))

mock.module('../../lib/global-job-lock', () => ({
  withGlobalJobLock: async (_name: string, body: () => Promise<any>) => ({ acquired: true, result: await body() }),
}))

let emailConfigured = true
let failNextSend = false
let throwNextSend = false
const sentEmails: any[] = []
mock.module('../../services/email.service', () => ({
  isEmailConfigured: () => emailConfigured,
  sendFirstBuildNudgeEmail: async (params: any) => {
    if (throwNextSend) throw new Error('template render exploded')
    if (failNextSend) return { success: false, error: 'smtp down' }
    sentEmails.push(params)
    return { success: true }
  },
}))

const { runLifecycleNurture } = await import('../lifecycle-nurture')

function user(id: string, ageHours: number, email = `${id}@example.com`): FakeUser {
  return { id, email, createdAt: new Date(NOW.getTime() - ageHours * HOUR), lifecycleEmailOptOutAt: null }
}

// `now` is injected into every run, but pin the system clock too so the seeds
// above can never drift into a fixed-date bomb if the job starts reading today.
beforeAll(() => setSystemTime(NOW))
afterAll(() => setSystemTime())

beforeEach(() => {
  users = []
  projectOwnerIds = []
  sessions = {}
  firstMessages = {}
  ledger.clear()
  sentEmails.length = 0
  emailConfigured = true
  failNextSend = false
  throwNextSend = false
})

describe('runLifecycleNurture', () => {
  it('nudges a 25h-old user with no project once, and a second run sends nothing', async () => {
    users = [user('u-1', 25)]
    const first = await runLifecycleNurture({ now: NOW })
    expect(first).toMatchObject({ candidates: 1, sent: 1, failed: 0 })
    expect(sentEmails).toHaveLength(1)
    expect(sentEmails[0].to).toBe('u-1@example.com')

    const second = await runLifecycleNurture({ now: NOW })
    expect(second).toMatchObject({ sent: 0 })
    expect(sentEmails).toHaveLength(1)
  })

  it('skips a user who already has a project', async () => {
    users = [user('u-1', 25)]
    projectOwnerIds = ['u-1']
    const out = await runLifecycleNurture({ now: NOW })
    expect(out).toMatchObject({ sent: 0, skipped: 1 })
    expect(sentEmails).toHaveLength(0)
    expect(ledger.size).toBe(0)
  })

  it('respects the 24–72h window: too young and too old both get none', async () => {
    users = [user('young', 20), user('old', 80), user('justRight', 30)]
    const out = await runLifecycleNurture({ now: NOW })
    expect(out).toMatchObject({ candidates: 1, sent: 1 })
    expect(sentEmails.map((e) => e.to)).toEqual(['justRight@example.com'])
  })

  it('skips an opted-out user at the query', async () => {
    users = [user('u-1', 25)]
    users[0].lifecycleEmailOptOutAt = new Date()
    const out = await runLifecycleNurture({ now: NOW })
    expect(out).toMatchObject({ sent: 0 })
    expect(sentEmails).toHaveLength(0)
  })

  it('quotes the onboarding idea and links back to that chat session', async () => {
    users = [user('u-1', 25)]
    sessions['u-1'] = { id: 'sess-1', inferredName: 'A CRM for my bakery' }
    firstMessages['sess-1'] = '::Build Brief::\nA CRM for my bakery\n\n---\nBuild a first working version…'
    await runLifecycleNurture({ now: NOW })
    expect(sentEmails[0].prompt).toBe('A CRM for my bakery')
    expect(sentEmails[0].continueUrl).toBe('https://app.test/agent?chatSessionId=sess-1')
  })

  it('falls back to the session name when the message is not a build brief', async () => {
    users = [user('u-1', 25)]
    sessions['u-1'] = { id: 'sess-2', inferredName: 'A habit tracker' }
    firstMessages['sess-2'] = 'hello there'
    await runLifecycleNurture({ now: NOW })
    expect(sentEmails[0].prompt).toBe('A habit tracker')
  })

  it('sends the examples variant (no prompt) when there is no session', async () => {
    users = [user('u-1', 25)]
    await runLifecycleNurture({ now: NOW })
    expect(sentEmails[0].prompt).toBeNull()
    expect(sentEmails[0].examples.length).toBeGreaterThanOrEqual(3)
    expect(sentEmails[0].continueUrl).toBe('https://app.test')
  })

  it('releases the claim when a send fails, so the next run retries', async () => {
    users = [user('u-1', 25)]
    failNextSend = true
    const first = await runLifecycleNurture({ now: NOW })
    expect(first).toMatchObject({ sent: 0, failed: 1 })
    expect(ledger.size).toBe(0)

    failNextSend = false
    const retry = await runLifecycleNurture({ now: NOW })
    expect(retry).toMatchObject({ sent: 1 })
    expect(sentEmails).toHaveLength(1)
  })

  it('releases the claim when the send throws, so the next run retries', async () => {
    users = [user('u-1', 25)]
    throwNextSend = true
    const first = await runLifecycleNurture({ now: NOW })
    expect(first).toMatchObject({ sent: 0, failed: 1 })
    expect(ledger.size).toBe(0)

    throwNextSend = false
    const retry = await runLifecycleNurture({ now: NOW })
    expect(retry).toMatchObject({ sent: 1 })
    expect(sentEmails).toHaveLength(1)
  })

  it('returns skip with no query when email is not configured (local mode)', async () => {
    emailConfigured = false
    users = [user('u-1', 25)]
    const out = await runLifecycleNurture({ now: NOW })
    expect(out).toEqual({ skipped: 'email_not_configured' })
    expect(sentEmails).toHaveLength(0)
    expect(ledger.size).toBe(0)
  })
})
