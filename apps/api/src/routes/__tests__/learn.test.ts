// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { decideLearnAccess, LEARN_COACH_DAILY_LIMIT } from '../../config/learn-catalog'
import { SOLO_FOUNDER_COURSE_ID } from '../../config/solo-founder-course'
import {
  LEARN_COOKIE_NAME,
  LEARN_TOKEN_HEADER,
  LEARN_TOKEN_TTL_SECONDS,
  hostMatchesCookieDomain,
  learnTokenNeedsRenewal,
  mintLearnToken,
  safeLearnReturn,
  verifyLearnToken,
} from '../../lib/learn-token'
import { bestPlanId, learnRoutes, withLearnCookie, type LearnRoutesDeps } from '../learn'

const ENV_KEYS = ['LEARN_TOKEN_SECRET', 'BETTER_AUTH_SECRET', 'LEARN_COOKIE_DOMAIN', 'LEARN_ORIGINS', 'NODE_ENV'] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.LEARN_TOKEN_SECRET = 'test-learn-secret'
  process.env.LEARN_COOKIE_DOMAIN = '.shogo.ai'
  process.env.LEARN_ORIGINS = 'https://learn.shogo.ai'
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)

interface FakeState {
  sessions: Record<string, { userId: string; live: boolean }>
  cookieSession: { userId: string; sessionId: string } | null
  workspaces: Record<string, string[]>
  plans: Record<string, string>
  enrollments: Array<{ userId: string; workspaceId: string; courseId: string; progress: unknown; completedAt: Date | null }>
  rateAllowed: boolean
  coachCalls: Array<{ system: string; messages: unknown[] }>
}

function makeApp(state: FakeState) {
  const deps: LearnRoutesDeps = {
    getSession: async () => state.cookieSession,
    isSessionLive: async (sessionId, userId) => state.sessions[sessionId]?.userId === userId && !!state.sessions[sessionId]?.live,
    getUser: async (id) => ({ id, name: 'Ada', email: `${id}@example.com`, image: null }),
    getWorkspaceIds: async (userId) => state.workspaces[userId] ?? [],
    getEffectivePlanId: async (ws) => state.plans[ws] ?? 'free',
    getEnrollments: async (userId, wsIds) =>
      state.enrollments.filter((e) => e.userId === userId || wsIds.includes(e.workspaceId)),
    takeRateLimit: async () => ({ allowed: state.rateAllowed, retryAfterSeconds: 3600 }),
    generateCoachReply: async (input) => {
      state.coachCalls.push(input)
      return 'What do you see on the Publish dialog right now?'
    },
    frontendUrl: () => 'https://studio.shogo.ai',
    now: () => NOW,
  }
  const app = new Hono()
  app.route('/api/learn', learnRoutes(deps))
  return { app, deps }
}

function baseState(): FakeState {
  return {
    sessions: { s1: { userId: 'u1', live: true } },
    cookieSession: null,
    workspaces: { u1: ['ws-free', 'ws-biz'] },
    plans: { 'ws-free': 'free', 'ws-biz': 'business' },
    enrollments: [],
    rateAllowed: true,
    coachCalls: [],
  }
}

function tokenFor(userId = 'u1', sessionId = 's1') {
  return mintLearnToken({ userId, sessionId }, NOW).token
}

describe('learn token', () => {
  test('round-trips and binds user + session', () => {
    const { token, exp } = mintLearnToken({ userId: 'u1', sessionId: 's1' }, NOW)
    expect(verifyLearnToken(token, NOW)).toEqual({ userId: 'u1', sessionId: 's1', exp })
    expect(exp).toBe(Math.floor(NOW / 1000) + LEARN_TOKEN_TTL_SECONDS)
  })

  test('rejects a tampered payload, a wrong secret, and an expired token', () => {
    const { token } = mintLearnToken({ userId: 'u1', sessionId: 's1' }, NOW)
    const [v, , sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ u: 'admin', s: 's1', e: 9_999_999_999 })).toString('base64url')
    expect(verifyLearnToken(`${v}.${forged}.${sig}`, NOW)).toBeNull()
    process.env.LEARN_TOKEN_SECRET = 'another-secret'
    expect(verifyLearnToken(token, NOW)).toBeNull()
    process.env.LEARN_TOKEN_SECRET = 'test-learn-secret'
    expect(verifyLearnToken(token, NOW + (LEARN_TOKEN_TTL_SECONDS + 1) * 1000)).toBeNull()
    expect(verifyLearnToken('garbage', NOW)).toBeNull()
  })

  test('is renewed only past half-life', () => {
    const { token } = mintLearnToken({ userId: 'u1', sessionId: 's1' }, NOW)
    expect(learnTokenNeedsRenewal(token, NOW + 1000)).toBe(false)
    expect(learnTokenNeedsRenewal(token, NOW + (LEARN_TOKEN_TTL_SECONDS * 1000 * 2) / 3)).toBe(true)
    expect(learnTokenNeedsRenewal(null, NOW)).toBe(true)
  })

  test('return URLs must be on an allowed learn origin exactly', () => {
    const origins = ['https://learn.shogo.ai']
    expect(safeLearnReturn('https://learn.shogo.ai/courses/solo-founder', origins)).toBe('https://learn.shogo.ai/courses/solo-founder')
    expect(safeLearnReturn('https://learn.shogo.ai.evil.com/', origins)).toBeNull()
    expect(safeLearnReturn('https://evil.com/?https://learn.shogo.ai', origins)).toBeNull()
    expect(safeLearnReturn('https://user:pw@learn.shogo.ai/', origins)).toBeNull()
    expect(safeLearnReturn('javascript:alert(1)', origins)).toBeNull()
    expect(safeLearnReturn('http://learn.shogo.ai/', origins)).toBeNull()
  })

  test('cookie domain matching', () => {
    expect(hostMatchesCookieDomain('studio.shogo.ai', '.shogo.ai')).toBe(true)
    expect(hostMatchesCookieDomain('eu.studio.shogo.ai:443', '.shogo.ai')).toBe(true)
    expect(hostMatchesCookieDomain('shogo.ai.evil.com', '.shogo.ai')).toBe(false)
    expect(hostMatchesCookieDomain('localhost', '.shogo.ai')).toBe(false)
  })
})

describe('course access rules', () => {
  const learner = (planId: any, enrolled: string[] = []) => ({ signedIn: true, planId, enrolledCourseIds: new Set(enrolled) })

  test('plan courses go by rank, so a legacy Pro seat counts as Basic+', () => {
    const rule = { kind: 'plan', minPlan: 'basic' } as const
    expect(decideLearnAccess(rule, learner('free')).hasAccess).toBe(false)
    expect(decideLearnAccess(rule, learner('basic')).hasAccess).toBe(true)
    expect(decideLearnAccess(rule, learner('pro')).hasAccess).toBe(true)
    expect(decideLearnAccess(rule, learner('business')).hasAccess).toBe(true)
  })

  test('purchase-only courses ignore the plan', () => {
    const rule = { kind: 'purchase', enrollmentCourseId: SOLO_FOUNDER_COURSE_ID, offer: 'solo_founder' } as const
    expect(decideLearnAccess(rule, learner('enterprise'))).toEqual({ hasAccess: false, reason: 'purchase_required', offer: 'solo_founder' })
    expect(decideLearnAccess(rule, learner('free', [SOLO_FOUNDER_COURSE_ID])).hasAccess).toBe(true)
  })

  test('bestPlanId picks the highest tier across workspaces', () => {
    expect(bestPlanId(['free', 'Business-Annual', 'basic'])).toBe('business')
    expect(bestPlanId([])).toBe('free')
    expect(bestPlanId(['pro_200'])).toBe('pro')
  })
})

describe('GET /api/learn/me', () => {
  test('signed out: only public courses are open', async () => {
    const { app } = makeApp(baseState())
    const res = await app.request('/api/learn/me')
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.signedIn).toBe(false)
    expect(body.courses.library.hasAccess).toBe(true)
    expect(body.courses['start-here']).toEqual({ hasAccess: false, reason: 'signed_out' })
    expect(body.courses['solo-founder'].offer).toBe('solo_founder')
  })

  test('learn token: best plan across workspaces, purchase access with progress', async () => {
    const state = baseState()
    state.enrollments.push({
      userId: 'someone-else',
      workspaceId: 'ws-biz',
      courseId: SOLO_FOUNDER_COURSE_ID,
      progress: { completedLessons: ['m0', 'm1'] },
      completedAt: null,
    })
    const { app } = makeApp(state)
    const res = await app.request('/api/learn/me', { headers: { [LEARN_TOKEN_HEADER]: tokenFor() } })
    const body: any = await res.json()
    expect(body.signedIn).toBe(true)
    expect(body.plan.id).toBe('business')
    expect(body.coach.dailyLimit).toBe(LEARN_COACH_DAILY_LIMIT.business)
    expect(body.courses['agent-team-playbook'].hasAccess).toBe(true)
    expect(body.courses['solo-founder']).toMatchObject({
      hasAccess: true,
      reason: 'purchased',
      progress: { completedLessons: ['m0', 'm1'], completedAt: null },
    })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('the cookie works the same as the header', async () => {
    const { app } = makeApp(baseState())
    const res = await app.request('/api/learn/me', { headers: { cookie: `a=b; ${LEARN_COOKIE_NAME}=${tokenFor()}` } })
    expect(((await res.json()) as any).signedIn).toBe(true)
  })

  test('signing out of Studio ends the learn token (session row gone)', async () => {
    const state = baseState()
    state.sessions.s1.live = false
    const { app } = makeApp(state)
    const res = await app.request('/api/learn/me', { headers: { [LEARN_TOKEN_HEADER]: tokenFor() } })
    expect(((await res.json()) as any).signedIn).toBe(false)
  })

  test('a token for one user cannot borrow another user\'s session', async () => {
    const { app } = makeApp(baseState())
    const res = await app.request('/api/learn/me', { headers: { [LEARN_TOKEN_HEADER]: tokenFor('u2', 's1') } })
    expect(((await res.json()) as any).signedIn).toBe(false)
  })
})

describe('GET /api/learn/sso', () => {
  const ret = encodeURIComponent('https://learn.shogo.ai/courses/start-here')

  test('rejects a return URL off the learn origin', async () => {
    const { app } = makeApp(baseState())
    const res = await app.request(`/api/learn/sso?return=${encodeURIComponent('https://evil.com/')}`)
    expect(res.status).toBe(400)
  })

  test('signed out: to Studio sign-in carrying the return, or straight back with prompt=none', async () => {
    const { app } = makeApp(baseState())
    const res = await app.request(`/api/learn/sso?return=${ret}`)
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('location')!)
    expect(loc.origin + loc.pathname).toBe('https://studio.shogo.ai/sign-in')
    expect(loc.searchParams.get('learn_return')).toBe('https://learn.shogo.ai/courses/start-here')

    const silent = await app.request(`/api/learn/sso?return=${ret}&prompt=none`)
    expect(silent.headers.get('location')).toBe('https://learn.shogo.ai/courses/start-here?learn_sso=none')
    expect(silent.headers.get('set-cookie')).toBeNull()
  })

  test('signed in: sets the learn cookie on .shogo.ai (never the session) and returns', async () => {
    const state = baseState()
    state.cookieSession = { userId: 'u1', sessionId: 's1' }
    const { app } = makeApp(state)
    const res = await app.request(`/api/learn/sso?return=${ret}`, { headers: { host: 'studio.shogo.ai' } })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://learn.shogo.ai/courses/start-here')
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toStartWith(`${LEARN_COOKIE_NAME}=v1.`)
    expect(cookie).toContain('Domain=.shogo.ai')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).not.toContain('session_token')
    const token = cookie.split(';')[0].slice(LEARN_COOKIE_NAME.length + 1)
    expect(verifyLearnToken(token, NOW)).toMatchObject({ userId: 'u1', sessionId: 's1' })
  })
})

describe('POST /api/learn/coach', () => {
  const body = (courseId: string) =>
    JSON.stringify({
      courseId,
      courseTitle: 'Start here',
      lessonTitle: 'Share your first app',
      lessonContext: 'Open the preview and share the link.',
      messages: [{ role: 'user', content: 'Just publish it for me' }],
    })
  const post = (app: Hono, courseId: string, token?: string) =>
    app.request('/api/learn/coach', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { [LEARN_TOKEN_HEADER]: token } : {}) },
      body: body(courseId),
    })

  test('401 signed out, 403 without access, 429 over the daily cap', async () => {
    const state = baseState()
    const { app } = makeApp(state)
    expect((await post(app, 'start-here')).status).toBe(401)
    expect((await post(app, 'solo-founder', tokenFor())).status).toBe(403)
    state.rateAllowed = false
    const limited = await post(app, 'start-here', tokenFor())
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('3600')
    expect(state.coachCalls).toHaveLength(0)
  })

  test('answers with the guarded, lesson-scoped prompt', async () => {
    const state = baseState()
    const { app } = makeApp(state)
    const res = await post(app, 'start-here', tokenFor())
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).reply).toContain('Publish dialog')
    expect(state.coachCalls).toHaveLength(1)
    const { system, messages } = state.coachCalls[0]
    expect(system).toContain('"Share your first app"')
    expect(system).toContain('Give the single next step, not the whole solution')
    expect(system).toContain('<lesson>\nOpen the preview and share the link.\n</lesson>')
    expect(messages).toEqual([{ role: 'user', content: 'Just publish it for me' }])
  })

  test('400 when the last message is not from the learner', async () => {
    const { app } = makeApp(baseState())
    const res = await app.request('/api/learn/coach', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [LEARN_TOKEN_HEADER]: tokenFor() },
      body: JSON.stringify({ courseId: 'start-here', messages: [{ role: 'assistant', content: 'hi' }] }),
    })
    expect(res.status).toBe(400)
  })
})

describe('withLearnCookie (Studio keeps the learn cookie in step)', () => {
  const session = { userId: 'u1', sessionId: 's1' }
  const deps = { getSession: async () => session, now: () => NOW }

  test('get-session on a Studio host mints the cookie when it is missing', async () => {
    const req = new Request('https://studio.shogo.ai/api/auth/get-session', { headers: { host: 'studio.shogo.ai' } })
    const res = await withLearnCookie(req, new Response('{}', { status: 200 }), deps)
    expect(res.headers.get('set-cookie')).toContain(`${LEARN_COOKIE_NAME}=v1.`)
    expect(await res.text()).toBe('{}')
  })

  test('a fresh cookie is left alone', async () => {
    const req = new Request('https://studio.shogo.ai/api/auth/get-session', {
      headers: { host: 'studio.shogo.ai', cookie: `${LEARN_COOKIE_NAME}=${tokenFor()}` },
    })
    const res = await withLearnCookie(req, new Response('{}'), deps)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  test('sign-out clears it', async () => {
    const req = new Request('https://studio.shogo.ai/api/auth/sign-out', {
      method: 'POST',
      headers: { host: 'studio.shogo.ai', cookie: `${LEARN_COOKIE_NAME}=${tokenFor()}` },
    })
    const res = await withLearnCookie(req, new Response('{}'), deps)
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  test('no-op off the cookie domain, or when the feature is not configured', async () => {
    const offHost = new Request('http://localhost:8002/api/auth/get-session', { headers: { host: 'localhost:8002' } })
    expect((await withLearnCookie(offHost, new Response('{}'), deps)).headers.get('set-cookie')).toBeNull()
    delete process.env.LEARN_COOKIE_DOMAIN
    const onHost = new Request('https://studio.shogo.ai/api/auth/get-session', { headers: { host: 'studio.shogo.ai' } })
    expect((await withLearnCookie(onHost, new Response('{}'), deps)).headers.get('set-cookie')).toBeNull()
  })
})
