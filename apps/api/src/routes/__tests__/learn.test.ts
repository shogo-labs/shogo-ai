// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { decideLearnAccess, gradeLearnCheck, learnPurchaseCourseId, LEARN_CERTIFICATES, LEARN_COACH_DAILY_LIMIT } from '../../config/learn-catalog'
import { LEARN_COURSE_OFFER, buildLearnCheckoutParams, handleLearnRefund, learnStandaloneOffer, recordLearnPurchase } from '../../lib/learn-purchase'
import { SOLO_FOUNDER_COURSE_ID } from '../../config/solo-founder-course'
import {
  LEARN_COOKIE_NAME,
  LEARN_TOKEN_HEADER,
  LEARN_TOKEN_TTL_SECONDS,
  certificateSubject,
  cleanCertificateName,
  hostMatchesCookieDomain,
  learnTokenNeedsRenewal,
  mintLearnCertificate,
  mintLearnToken,
  safeLearnReturn,
  verifyLearnCertificate,
  verifyLearnToken,
} from '../../lib/learn-token'
import { bestPlanId, learnRoutes, withLearnCookie, type LearnRoutesDeps } from '../learn'
import {
  LEARN_BADGES,
  LEARN_LESSONS,
  SELF_PACED_COURSES,
  computeLearnStats,
  learnerDay,
  levelFor,
  qualifyingBadges,
  streakOf,
} from '../../config/learn-gamification'
import { mintLearnBadgeShare, verifyLearnBadgeShare } from '../../lib/learn-token'

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
  checkoutCalls?: any[]
  checkoutResult?: { url: string } | { error: 'price_not_provisioned' }
  completions?: Array<{ userId: string; courseId: string; lessonId: string; day: string; completedAt: Date }>
  badges?: Array<{ userId: string; badgeId: string; earnedAt: Date }>
  clock?: number
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
    createCourseCheckout: async (input) => {
      ;(state.checkoutCalls ??= []).push(input)
      return state.checkoutResult ?? { url: 'https://checkout.stripe.com/c/pay/cs_test_1' }
    },
    listCompletions: async (userId) => (state.completions ?? []).filter((r) => r.userId === userId),
    recordCompletions: async (userId, rows) => {
      state.completions ??= []
      let added = 0
      for (const r of rows) {
        if (state.completions.some((x) => x.userId === userId && x.courseId === r.courseId && x.lessonId === r.lessonId)) continue
        state.completions.push({ userId, ...r, completedAt: new Date(state.clock ?? NOW) })
        added++
      }
      return added
    },
    listBadges: async (userId) => (state.badges ?? []).filter((b) => b.userId === userId),
    awardBadges: async (userId, ids) => {
      state.badges ??= []
      for (const badgeId of ids) {
        if (!state.badges.some((b) => b.userId === userId && b.badgeId === badgeId)) state.badges.push({ userId, badgeId, earnedAt: new Date(state.clock ?? NOW) })
      }
    },
    now: () => state.clock ?? NOW,
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
    expect(body.courses['ai-teammates']).toEqual({ hasAccess: false, reason: 'signed_out' })
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
    expect(body.courses['ai-teammates']).toEqual({ hasAccess: true, reason: 'account' })
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

describe('certificates', () => {
  const PASS = { q1: 'b', q2: 'c', q3: 'b', q4: 'c', q5: 'd', q6: 'b' }

  async function post(app: Hono, body: unknown, token: string | null = tokenFor()) {
    return app.request('/api/learn/certificate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { [LEARN_TOKEN_HEADER]: token } : {}) },
      body: JSON.stringify(body),
    })
  }

  test('a pass returns a certificate that verifies publicly, with the chosen name and no email', async () => {
    const { app } = makeApp(baseState())
    const res = await post(app, { courseId: 'agents-for-everyone', answers: { ...PASS, q6: 'a' }, name: '  Grace\u0000 Hopper ' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toMatchObject({ passed: true, score: 5, total: 6, wrong: ['q6'], passMark: 5 })
    expect(body.certificate.name).toBe('Grace Hopper')

    const check = await app.request(`/api/learn/certificate/${body.certificate.id}`)
    expect(check.status).toBe(200)
    const cert = (await check.json()) as any
    expect(cert).toEqual({
      valid: true,
      name: 'Grace Hopper',
      courseId: 'agents-for-everyone',
      courseTitle: 'AI agents for everyone',
      issuedAt: new Date(Math.floor(NOW / 1000) * 1000).toISOString(),
      score: 5,
      total: 6,
    })
    expect(JSON.stringify(cert)).not.toContain('@example.com')
    expect(JSON.stringify(cert)).not.toContain('u1')
    const payload = Buffer.from(body.certificate.id.split('.')[1], 'base64url').toString('utf8')
    expect(payload).not.toContain('u1')
    expect(JSON.parse(payload).h).toBe(certificateSubject('u1'))
  })

  test('falls back to the account name when none is given', async () => {
    const { app } = makeApp(baseState())
    const body = (await (await post(app, { courseId: 'agents-for-everyone', answers: PASS })).json()) as any
    expect(body.certificate.name).toBe('Ada')
  })

  test('a fail returns the score and which questions missed, but no certificate and no answer key', async () => {
    const { app } = makeApp(baseState())
    const res = await post(app, { courseId: 'agents-for-everyone', answers: { q1: 'a', q2: 'c' } })
    const body = (await res.json()) as any
    expect(body).toMatchObject({ passed: false, score: 1, total: 6 })
    expect(body.wrong).toEqual(['q1', 'q3', 'q4', 'q5', 'q6'])
    expect(body.certificate).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('"d"')
  })

  test('requires sign-in, a known course, answers, and respects the daily cap', async () => {
    const state = baseState()
    const { app } = makeApp(state)
    expect((await post(app, { courseId: 'agents-for-everyone', answers: PASS }, null)).status).toBe(401)
    expect((await post(app, { courseId: 'start-here', answers: PASS })).status).toBe(404)
    expect((await post(app, { courseId: 'agents-for-everyone' })).status).toBe(400)
    state.rateAllowed = false
    const limited = await post(app, { courseId: 'agents-for-everyone', answers: PASS })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('3600')
  })

  test('rejects forged, tampered and cross-purpose ids', async () => {
    const { app } = makeApp(baseState())
    const real = mintLearnCertificate({ userId: 'u1', courseId: 'agents-for-everyone', name: 'Ada', issuedAt: 1, score: 6, total: 6 })
    expect(verifyLearnCertificate(real)?.name).toBe('Ada')
    const [v, , sig] = real.split('.')
    const forged = Buffer.from(JSON.stringify({ h: certificateSubject('u1'), c: 'agents-for-everyone', n: 'Mallory', t: 1, s: 6, o: 6 })).toString('base64url')
    expect(verifyLearnCertificate(`${v}.${forged}.${sig}`)).toBeNull()
    expect(verifyLearnCertificate(tokenFor())).toBeNull()
    expect(verifyLearnToken(real, NOW)).toBeNull()
    process.env.LEARN_TOKEN_SECRET = 'another-secret'
    expect(verifyLearnCertificate(real)).toBeNull()
    process.env.LEARN_TOKEN_SECRET = 'test-learn-secret'
    expect((await app.request(`/api/learn/certificate/${v}.${forged}.${sig}`)).status).toBe(404)
    expect((await app.request('/api/learn/certificate/garbage')).status).toBe(404)
  })

  test('names are single-line, printable and capped', () => {
    expect(cleanCertificateName('a\nb\tc')).toBe('a b c')
    expect(cleanCertificateName('x'.repeat(200))).toHaveLength(80)
    expect(cleanCertificateName('\u202eevil')).toBe('evil')
    expect(cleanCertificateName(42)).toBe('')
  })

  test('the new courses are on the catalog with the right access', () => {
    expect(decideLearnAccess({ kind: 'public' }, { signedIn: false, planId: 'free', enrolledCourseIds: new Set() }).hasAccess).toBe(true)
    expect(gradeLearnCheck(LEARN_CERTIFICATES['agents-for-everyone'], PASS)).toEqual({ score: 6, total: 6, wrong: [], passed: true })
  })
})


describe('standalone course purchases', () => {
  const RETURN = 'https://learn.shogo.ai/courses/first-client/the-offer/'

  function freeState(): FakeState {
    const st = baseState()
    st.workspaces = { u1: ['ws-free'] }
    return st
  }

  async function checkout(app: Hono, body: unknown, token: string | null = tokenFor()) {
    return app.request('/api/learn/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { [LEARN_TOKEN_HEADER]: token } : {}) },
      body: JSON.stringify(body),
    })
  }

  test('a plan course with a standalone offer: plan or purchase opens it, and the price is shown otherwise', () => {
    const rule = { kind: 'plan', minPlan: 'basic', standalone: { courseId: 'first-client', title: 'x', priceUsd: 49, lookupKey: 'k' } } as const
    expect(decideLearnAccess(rule, { signedIn: false, planId: 'free', enrolledCourseIds: new Set() })).toEqual({
      hasAccess: false, reason: 'signed_out', requiredPlan: 'basic', standalone: { priceUsd: 49 },
    })
    expect(decideLearnAccess(rule, { signedIn: true, planId: 'free', enrolledCourseIds: new Set() })).toEqual({
      hasAccess: false, reason: 'plan_required', requiredPlan: 'basic', standalone: { priceUsd: 49 },
    })
    expect(decideLearnAccess(rule, { signedIn: true, planId: 'free', enrolledCourseIds: new Set([learnPurchaseCourseId('first-client')]) }))
      .toEqual({ hasAccess: true, reason: 'purchased' })
    expect(decideLearnAccess(rule, { signedIn: true, planId: 'basic', enrolledCourseIds: new Set() }))
      .toEqual({ hasAccess: true, reason: 'plan' })
  })

  test('/me: a purchase unlocks the course for the buyer only, never their teammates', async () => {
    const st = freeState()
    st.workspaces.u2 = ['ws-free']
    st.sessions.s2 = { userId: 'u2', live: true }
    st.enrollments = [{ userId: 'u2', workspaceId: 'ws-free', courseId: 'learn:first-client', progress: null, completedAt: null }]
    const { app } = makeApp(st)
    const me = async (token: string) =>
      (await (await app.request('/api/learn/me', { headers: { [LEARN_TOKEN_HEADER]: token } })).json()) as any
    expect((await me(tokenFor('u2', 's2'))).courses['first-client']).toEqual({ hasAccess: true, reason: 'purchased' })
    expect((await me(tokenFor('u1', 's1'))).courses['first-client']).toMatchObject({ hasAccess: false, standalone: { priceUsd: 49 } })
    expect((await me(tokenFor('u1', 's1'))).courses['paid-app']).toMatchObject({ hasAccess: false, standalone: { priceUsd: 49 } })
  })

  test('POST /checkout creates a Stripe checkout for a free learner, with a learn.shogo.ai return', async () => {
    const st = freeState()
    const { app } = makeApp(st)
    const res = await checkout(app, { courseId: 'first-client', returnUrl: RETURN })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' })
    expect(st.checkoutCalls).toHaveLength(1)
    expect(st.checkoutCalls![0]).toMatchObject({
      userId: 'u1',
      email: 'u1@example.com',
      workspaceId: 'ws-free',
      cancelUrl: RETURN,
      successUrl: `${RETURN}?purchased=first-client`,
      offer: { courseId: 'first-client', priceUsd: 49, lookupKey: 'learn_course_first_client_v1' },
    })
  })

  test('POST /checkout refuses what it should', async () => {
    const st = freeState()
    const { app } = makeApp(st)
    expect((await checkout(app, { courseId: 'first-client', returnUrl: RETURN }, null)).status).toBe(401)
    expect((await checkout(app, { courseId: 'start-here', returnUrl: RETURN })).status).toBe(404)
    expect((await checkout(app, { courseId: 'solo-founder', returnUrl: RETURN })).status).toBe(404)
    expect((await checkout(app, { courseId: 'first-client', returnUrl: 'https://evil.example/x' })).status).toBe(400)
    st.checkoutResult = { error: 'price_not_provisioned' }
    expect((await checkout(app, { courseId: 'first-client', returnUrl: RETURN })).status).toBe(503)
    st.rateAllowed = false
    expect((await checkout(app, { courseId: 'first-client', returnUrl: RETURN })).status).toBe(429)
  })

  test('POST /checkout is a 409 when the learner already has the course', async () => {
    const st = baseState()
    const { app } = makeApp(st)
    const res = await checkout(app, { courseId: 'first-client', returnUrl: RETURN })
    expect(res.status).toBe(409)
    expect(st.checkoutCalls ?? []).toHaveLength(0)
  })

  function fakeDb() {
    const rows: any[] = []
    return {
      rows,
      courseEnrollment: {
        findUnique: async ({ where }: any) => rows.find((r) => r.stripeCheckoutSessionId === where.stripeCheckoutSessionId) ?? null,
        create: async ({ data }: any) => {
          const row = { id: `e${rows.length + 1}`, ...data }
          rows.push(row)
          return row
        },
        updateMany: async ({ where, data }: any) => {
          const hit = rows.filter((r) => where.stripeCheckoutSessionId.in.includes(r.stripeCheckoutSessionId) && r.status === where.status)
          for (const r of hit) Object.assign(r, data)
          return { count: hit.length }
        },
      },
    }
  }

  const PAID = {
    id: 'cs_1',
    payment_status: 'paid' as const,
    metadata: { offer: LEARN_COURSE_OFFER, learnCourseId: 'paid-app', userId: 'u1', workspaceId: 'ws-free' },
  }

  test('the webhook records one active enrollment per paid session, and ignores everything else', async () => {
    const db = fakeDb()
    expect(await recordLearnPurchase(db, PAID, new Date(NOW))).toEqual({ recorded: true, enrollmentId: 'e1', courseId: 'learn:paid-app' })
    expect(db.rows[0]).toMatchObject({ courseId: 'learn:paid-app', userId: 'u1', status: 'active', source: 'stripe', stripeCheckoutSessionId: 'cs_1' })
    expect(await recordLearnPurchase(db, PAID)).toEqual({ recorded: false, reason: 'duplicate' })
    expect(await recordLearnPurchase(db, { ...PAID, id: 'cs_2', payment_status: 'unpaid' })).toEqual({ recorded: false, reason: 'unpaid' })
    expect(await recordLearnPurchase(db, { ...PAID, id: 'cs_3', metadata: { offer: 'solo_founder' } })).toEqual({ recorded: false, reason: 'not_learn' })
    expect(await recordLearnPurchase(db, { ...PAID, id: 'cs_4', metadata: { ...PAID.metadata, learnCourseId: 'start-here' } }))
      .toEqual({ recorded: false, reason: 'unknown_course' })
    expect(db.rows).toHaveLength(1)
  })

  test('a full refund closes the enrollment; a partial refund does not', async () => {
    const db = fakeDb()
    await recordLearnPurchase(db, PAID)
    const stripe: any = { checkout: { sessions: { list: async () => ({ data: [{ id: 'cs_1', metadata: PAID.metadata }] }) } } }
    expect(await handleLearnRefund({ db, stripe, charge: { amount: 4900, amount_refunded: 1000, payment_intent: 'pi_1', metadata: {} } }))
      .toEqual({ closed: 0 })
    expect(db.rows[0].status).toBe('active')
    expect(await handleLearnRefund({ db, stripe, charge: { amount: 4900, amount_refunded: 4900, payment_intent: 'pi_1', metadata: {} } }))
      .toEqual({ closed: 1 })
    expect(db.rows[0].status).toBe('refunded')
    expect(await handleLearnRefund({ db, stripe, charge: { amount: 4900, amount_refunded: 4900, payment_intent: 'pi_1', metadata: {} } }))
      .toEqual({ closed: 0 })
  })

  test('checkout params: one-time card payment, offer metadata on the session and the payment', () => {
    const p = buildLearnCheckoutParams({
      offer: learnStandaloneOffer('paid-app')!,
      priceId: 'price_1',
      userId: 'u1',
      workspaceId: 'ws1',
      userEmail: 'a@b.c',
      successUrl: 's',
      cancelUrl: 'c',
    })
    expect(p.mode).toBe('payment')
    expect(p.line_items).toEqual([{ price: 'price_1', quantity: 1 }])
    expect(p.metadata).toEqual({ offer: 'learn_course', learnCourseId: 'paid-app', userId: 'u1', workspaceId: 'ws1' })
    expect(p.payment_intent_data?.metadata).toEqual(p.metadata)
    expect(learnStandaloneOffer('start-here')).toBeNull()
  })
})


describe('gamification rules', () => {
  test('streaks: current run ending today or yesterday, and the longest run', () => {
    expect(streakOf(['2026-11-18', '2026-11-19', '2026-11-20'], '2026-11-20')).toEqual({ current: 3, longest: 3, activeToday: true })
    expect(streakOf(['2026-11-18', '2026-11-19'], '2026-11-20')).toEqual({ current: 2, longest: 2, activeToday: false })
    expect(streakOf(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-19'], '2026-11-21')).toEqual({ current: 0, longest: 3, activeToday: false })
    expect(streakOf(['2026-12-31', '2027-01-01'], '2027-01-01').current).toBe(2)
  })

  test('learnerDay uses the learner time zone and falls back to UTC', () => {
    const at = new Date(Date.UTC(2026, 10, 20, 3, 0, 0))
    expect(learnerDay(at, 'America/Los_Angeles')).toBe('2026-11-19')
    expect(learnerDay(at, 'Asia/Seoul')).toBe('2026-11-20')
    expect(learnerDay(at, 'Not/AZone')).toBe('2026-11-20')
  })

  test('XP: 10 a lesson, 50 a finished course, badge XP on top; levels follow', () => {
    const course = 'start-here'
    const completions = LEARN_LESSONS[course].map((lessonId) => ({ courseId: course, lessonId, day: '2026-11-20' }))
    const stats = computeLearnStats({ completions, badgeIds: ['first-lesson', 'course-start-here'], today: '2026-11-20' })
    expect(stats.lessonsCompleted).toBe(5)
    expect(stats.coursesCompleted).toEqual(['start-here'])
    expect(stats.xp).toBe(5 * 10 + 50 + 20 + 20)
    expect(stats.level.name).toBe('Builder')
    expect(levelFor(0).next).toEqual({ name: 'Explorer', min: 40 })
    expect(levelFor(99999).next).toBeNull()
  })

  test('finishing everything reaches the top level', () => {
    const completions = Object.entries(LEARN_LESSONS).flatMap(([courseId, ls]) => ls.map((lessonId) => ({ courseId, lessonId, day: '2026-11-20' })))
    const all = computeLearnStats({ completions, badgeIds: LEARN_BADGES.map((b) => b.id), today: '2026-11-20' })
    expect(all.level.next).toBeNull()
  })

  test('badges come from progress: first lesson, course graduate, foundations, founding learner', () => {
    const free = ['agents-for-everyone', 'start-here', 'ai-teammates']
    const completions = free.flatMap((courseId) => LEARN_LESSONS[courseId].map((lessonId) => ({ courseId, lessonId, day: '2026-11-20' })))
    const stats = computeLearnStats({ completions, badgeIds: [], today: '2026-11-20' })
    const got = qualifyingBadges(stats, { certified: ['agents-for-everyone'], firstActivityDay: '2026-11-20' })
    for (const b of ['first-lesson', 'lessons-10', 'course-start-here', 'course-ai-teammates', 'course-agents-for-everyone', 'certified-agents-for-everyone', 'foundations', 'founding-learner']) {
      expect(got).toContain(b)
    }
    expect(qualifyingBadges(stats, { firstActivityDay: '2027-02-01' })).not.toContain('founding-learner')
    for (const id of got) expect(LEARN_BADGES.some((b) => b.id === id)).toBe(true)
  })

  test('every self-paced course has lessons; solo founder is board-tracked', () => {
    for (const c of SELF_PACED_COURSES) expect(LEARN_LESSONS[c].length).toBeGreaterThan(0)
    expect(SELF_PACED_COURSES).not.toContain('solo-founder')
  })
})

describe('progress, XP and badges on the account', () => {
  const H = (userId = 'u1', sessionId = 's1') => ({ 'content-type': 'application/json', [LEARN_TOKEN_HEADER]: tokenFor(userId, sessionId) })
  const post = (app: Hono, path: string, body: unknown, headers: Record<string, string> = H()) =>
    app.request(`/api/learn${path}`, { method: 'POST', headers, body: JSON.stringify(body) })

  function freeLearner(): FakeState {
    const st = baseState()
    st.workspaces = { u1: ['ws-free'], u2: ['ws-free'] }
    st.sessions.s2 = { userId: 'u2', live: true }
    return st
  }

  test('marking a lesson complete saves it to the account and awards first badges', async () => {
    const st = freeLearner()
    const { app } = makeApp(st)
    const res = await post(app, '/progress', { courseId: 'start-here', lessonId: 'first-app', tz: 'America/Los_Angeles' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.added).toBe(true)
    expect(body.completedLessons).toEqual(['first-app'])
    expect(body.newBadges.map((b: any) => b.id).sort()).toEqual(['first-lesson', 'founding-learner'])
    expect(body.stats.xp).toBe(10 + 20 + 20)
    expect(body.levelUp).toBe(true)
    expect(st.completions).toEqual([{ userId: 'u1', courseId: 'start-here', lessonId: 'first-app', day: '2026-11-20', completedAt: new Date(NOW) }])

    const again = (await (await post(app, '/progress', { courseId: 'start-here', lessonId: 'first-app' })).json()) as any
    expect(again.added).toBe(false)
    expect(again.newBadges).toEqual([])
    expect(again.levelUp).toBe(false)
    expect(st.badges).toHaveLength(2)
  })

  test('progress is per learner: a teammate in the same workspace starts at zero', async () => {
    const st = freeLearner()
    const { app } = makeApp(st)
    await post(app, '/progress', { courseId: 'start-here', lessonId: 'first-app' })
    const me2 = (await (await app.request('/api/learn/me', { headers: H('u2', 's2') })).json()) as any
    expect(me2.stats.lessonsCompleted).toBe(0)
    expect(me2.badges).toEqual([])
  })

  test('refuses what it should', async () => {
    const st = freeLearner()
    const { app } = makeApp(st)
    expect((await post(app, '/progress', { courseId: 'start-here', lessonId: 'first-app' }, { 'content-type': 'application/json' })).status).toBe(401)
    expect((await post(app, '/progress', { courseId: 'start-here', lessonId: 'nope' })).status).toBe(404)
    expect((await post(app, '/progress', { courseId: 'solo-founder', lessonId: 'm1' })).status).toBe(404)
    expect((await post(app, '/progress', { courseId: 'agents-for-everyone', lessonId: 'final-check' })).status).toBe(400)
    expect((await post(app, '/progress', { courseId: 'paid-app', lessonId: 'day-1-pick' })).status).toBe(403)
    st.rateAllowed = false
    expect((await post(app, '/progress', { courseId: 'start-here', lessonId: 'first-app' })).status).toBe(429)
    expect(st.completions ?? []).toHaveLength(0)
  })

  test('finishing a course awards its graduate badge; /me returns progress, stats, badges and the catalog', async () => {
    const st = freeLearner()
    const { app } = makeApp(st)
    let last: any
    for (const lessonId of LEARN_LESSONS['start-here']) last = await (await post(app, '/progress', { courseId: 'start-here', lessonId })).json()
    expect(last.newBadges.map((b: any) => b.id)).toContain('course-start-here')
    const me = (await (await app.request('/api/learn/me', { headers: H() })).json()) as any
    expect(me.courses['start-here'].progress.completedLessons).toEqual(LEARN_LESSONS['start-here'])
    expect(me.courses['start-here'].progress.completedAt).toBe(new Date(NOW).toISOString())
    expect(me.stats.coursesCompleted).toEqual(['start-here'])
    expect(me.badges.map((b: any) => b.id)).toEqual(expect.arrayContaining(['first-lesson', 'course-start-here', 'founding-learner']))
    expect(me.catalog.badges.length).toBe(LEARN_BADGES.length)
    expect(me.newBadges).toEqual([])
  })

  test('a streak builds across days in the learner time zone and earns its badge', async () => {
    const st = freeLearner()
    const { app } = makeApp(st)
    const lessons = LEARN_LESSONS['ai-teammates']
    for (let d = 0; d < 3; d++) {
      st.clock = NOW + d * 86_400_000
      const r = (await (await post(app, '/progress', { courseId: 'ai-teammates', lessonId: lessons[d], tz: 'UTC' })).json()) as any
      if (d === 2) {
        expect(r.stats.streak).toEqual({ current: 3, longest: 3, activeToday: true })
        expect(r.newBadges.map((b: any) => b.id)).toContain('streak-3')
      }
    }
  })

  test('import merges signed-out progress: valid, accessible, deduped, capped and dated sanely', async () => {
    const st = freeLearner()
    const { app } = makeApp(st)
    const items = [
      { courseId: 'agents-for-everyone', lessonId: 'what-is-an-agent', day: '2026-11-18' },
      { courseId: 'agents-for-everyone', lessonId: 'what-is-an-agent', day: '2026-11-18' },
      { courseId: 'agents-for-everyone', lessonId: 'good-at-bad-at', day: '2031-01-01' },
      { courseId: 'agents-for-everyone', lessonId: 'final-check' },
      { courseId: 'paid-app', lessonId: 'day-1-pick' },
      { courseId: 'nope', lessonId: 'x' },
    ]
    const r = (await (await post(app, '/progress/import', { items, tz: 'UTC' })).json()) as any
    expect(r.imported).toBe(2)
    expect(st.completions!.map((c) => [c.lessonId, c.day])).toEqual([['what-is-an-agent', '2026-11-18'], ['good-at-bad-at', '2026-11-20']])
    expect((await post(app, '/progress/import', { items: 'x' })).status).toBe(400)
  })

  test('passing the final check completes its lesson and awards the certificate badge (+100 XP)', async () => {
    const st = freeLearner()
    const { app } = makeApp(st)
    const rule = LEARN_CERTIFICATES['agents-for-everyone']
    const answers = { ...rule.answers }
    const r = (await (await post(app, '/certificate', { courseId: 'agents-for-everyone', answers, tz: 'UTC' })).json()) as any
    expect(r.passed).toBe(true)
    expect(r.newBadges.map((b: any) => b.id)).toEqual(expect.arrayContaining(['certified-agents-for-everyone', 'first-lesson']))
    expect(r.stats.completedLessons['agents-for-everyone']).toEqual(['final-check'])
    expect(r.stats.xp).toBe(10 + 100 + 20 + 20)
  })

  test('badge share links: only for held badges, publicly verifiable, tamper-proof', async () => {
    const st = freeLearner()
    const { app } = makeApp(st)
    expect((await post(app, '/badge-share', { badgeId: 'first-lesson' })).status).toBe(404)
    await post(app, '/progress', { courseId: 'start-here', lessonId: 'first-app' })
    const share = (await (await post(app, '/badge-share', { badgeId: 'first-lesson', name: 'Ada Lovelace' })).json()) as any
    expect(share.name).toBe('Ada Lovelace')
    const v = (await (await app.request(`/api/learn/badge/${share.id}`)).json()) as any
    expect(v).toMatchObject({ valid: true, name: 'Ada Lovelace', badge: { id: 'first-lesson', name: 'First step' } })
    expect(JSON.stringify(v)).not.toContain('u1')
    const [ver, , sig] = share.id.split('.')
    const forged = Buffer.from(JSON.stringify({ h: 'x', b: 'lessons-all', n: 'Mallory', t: 1 })).toString('base64url')
    expect((await app.request(`/api/learn/badge/${ver}.${forged}.${sig}`)).status).toBe(404)
    expect(verifyLearnBadgeShare(mintLearnBadgeShare({ userId: 'u1', badgeId: 'streak-7', name: 'A', earnedAt: 5 }))?.badgeId).toBe('streak-7')
  })

  test('GET /lessons publishes the lesson ids and badge catalog for the site', async () => {
    const { app } = makeApp(baseState())
    const r = (await (await app.request('/api/learn/lessons')).json()) as any
    expect(r.lessons['start-here']).toEqual(LEARN_LESSONS['start-here'])
    expect(r.badges.length).toBe(LEARN_BADGES.length)
  })
})
