// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { decideLearnAccess, gradeLearnCheck, learnCourseById, unlockedLessons, LEARN_CERTIFICATES, LEARN_COACH_DAILY_LIMIT } from '../../config/learn-catalog'
import { LEARN_LEVELS, heldLevel, type LevelEvidence } from '../../config/learn-levels'
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
  CERTIFICATE_LESSON,
  DEPARTMENTS,
  LEARN_BADGES,
  LEARN_LESSONS,
  SELF_PACED_COURSES,
  computeLearnStats,
  learnBadgeById,
  learnerDay,
  rankFor,
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
  evidence?: LevelEvidence
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
    getLevelEvidence: async () => state.evidence ?? { publishedApps: 0, agentCardsDone: 0, agentsWithDoneCards: 0 },
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

/** Give a learner Shogo Certified levels 1..n. */
function grantLevels(state: FakeState, userId: string, n: number) {
  state.badges ??= []
  for (let i = 1; i <= n; i++) state.badges.push({ userId, badgeId: `level-${i}`, earnedAt: new Date(NOW - 86_400_000) })
}

/** Mark every lesson before a course's final check as done, so the check can be taken. */
function finishLessons(state: FakeState, userId = 'u1', courseId = 'agents-for-everyone'): FakeState {
  state.completions ??= []
  for (const lessonId of LEARN_LESSONS[courseId]!.filter((l) => l !== CERTIFICATE_LESSON[courseId])) {
    state.completions.push({ userId, courseId, lessonId, day: '2026-11-19', completedAt: new Date(NOW - 86_400_000) })
  }
  return state
}

function res_noStore(res: Response) {
  return res.headers.get('cache-control')
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
  test('every course is free: public, or opened by the level below its track', () => {
    const rule = (id: string) => learnCourseById(id)!.access
    expect(rule('library')).toEqual({ kind: 'public' })
    expect(rule('agents-for-everyone')).toEqual({ kind: 'public' })
    expect(rule('start-here')).toEqual({ kind: 'level', requires: 1 })
    expect(rule('ai-teammates')).toEqual({ kind: 'level', requires: 1 })
    expect(rule('agent-team-playbook')).toEqual({ kind: 'level', requires: 2 })
    for (const id of ['paid-app', 'first-client', 'solo-founder']) expect(rule(id)).toEqual({ kind: 'level', requires: 3 })
  })

  test('department certificates: every one opens at Level 1, has the six shared lessons, a 6-question key and a badge', () => {
    expect(DEPARTMENTS.map((d) => d.id)).toEqual([
      'ai-for-marketing', 'ai-for-sales', 'ai-for-support', 'ai-for-people',
      'ai-for-finance', 'ai-for-operations', 'ai-for-engineering', 'ai-for-devops',
    ])
    for (const d of DEPARTMENTS) {
      expect(learnCourseById(d.id)!.access).toEqual({ kind: 'level', requires: 1 })
      expect(LEARN_LESSONS[d.id]).toEqual(['jobs', 'set-up', 'workflow', 'guardrails', 'measure', 'final-check'])
      expect(CERTIFICATE_LESSON[d.id]).toBe('final-check')
      const rule = LEARN_CERTIFICATES[d.id]!
      expect(rule.courseTitle).toBe(d.title)
      expect(Object.keys(rule.answers)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6'])
      expect(rule.passMark).toBe(5)
      expect(learnBadgeById(`certified-${d.id}`)?.name).toBe(`Certified: ${d.title}`)
      expect(learnBadgeById(`course-${d.id}`)).toBeDefined()
    }
    // Every course with a final check has an answer key, and the reverse.
    expect(Object.keys(LEARN_CERTIFICATES).sort()).toEqual(Object.keys(CERTIFICATE_LESSON).sort())
  })

  test('a level rule: signed out, below, at and above the level', () => {
    const rule = { kind: 'level', requires: 2 } as const
    expect(decideLearnAccess(rule, { signedIn: false, level: 5 })).toEqual({ hasAccess: false, reason: 'signed_out', requiredLevel: 2 })
    expect(decideLearnAccess(rule, { signedIn: true, level: 1 })).toEqual({ hasAccess: false, reason: 'level_required', requiredLevel: 2 })
    expect(decideLearnAccess(rule, { signedIn: true, level: 2 })).toEqual({ hasAccess: true, reason: 'level' })
    expect(decideLearnAccess(rule, { signedIn: true, level: 6 })).toEqual({ hasAccess: true, reason: 'level' })
    expect(decideLearnAccess({ kind: 'public' }, { signedIn: false, level: 0 })).toEqual({ hasAccess: true, reason: 'public' })
  })

  test('lessons open in order: everything finished plus the next one', () => {
    const l = LEARN_LESSONS['start-here']
    expect(unlockedLessons('start-here', [])).toEqual([l[0]])
    expect(unlockedLessons('start-here', [l[0]])).toEqual([l[0], l[1]])
    expect(unlockedLessons('start-here', l)).toEqual(l)
    // A lesson finished out of order (old progress) stays open; the gap is next.
    expect(unlockedLessons('start-here', [l[0], l[2]])).toEqual([l[0], l[1], l[2]])
    expect(unlockedLessons('nope', [])).toEqual([])
  })

  test('Start here: the Shogo words come before the first app; planning comes after the review loop', () => {
    expect(LEARN_LESSONS['start-here']).toEqual(['what-an-agent-is', 'shogo-words', 'first-app', 'review-loop', 'plan-first', 'save-data', 'share-it'])
    expect(unlockedLessons('start-here', ['what-an-agent-is'])).toEqual(['what-an-agent-is', 'shogo-words'])
    // A learner who finished the old five lessons keeps them all open and is sent to the first new lesson.
    const old = ['what-an-agent-is', 'first-app', 'review-loop', 'save-data', 'share-it']
    expect(unlockedLessons('start-here', old)).toEqual(['what-an-agent-is', 'shogo-words', 'first-app', 'review-loop', 'save-data', 'share-it'])
  })

  test('held level has no gaps', () => {
    expect(heldLevel([])).toBe(0)
    expect(heldLevel(['level-1', 'level-2'])).toBe(2)
    expect(heldLevel(['level-1', 'level-3'])).toBe(1)
    expect(heldLevel(['level-2', 'level-3'])).toBe(0)
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
    expect(body.courses['agents-for-everyone']).toEqual({ hasAccess: true, reason: 'public' })
    expect(body.courses['start-here']).toEqual({ hasAccess: false, reason: 'signed_out', requiredLevel: 1 })
    expect(body.courses['solo-founder']).toEqual({ hasAccess: false, reason: 'signed_out', requiredLevel: 3 })
    expect(body.catalog.levels).toHaveLength(6)
  })

  test('learn token: level decides access, lessons open in order, plan only sets the coach cap', async () => {
    const state = baseState()
    const { app } = makeApp(state)
    const me = async () => (await (await app.request('/api/learn/me', { headers: { [LEARN_TOKEN_HEADER]: tokenFor() } })).json()) as any
    let body = await me()
    expect(body.signedIn).toBe(true)
    expect(body.plan.id).toBe('business')
    expect(body.coach.dailyLimit).toBe(LEARN_COACH_DAILY_LIMIT.business)
    // A Business plan opens nothing on its own any more.
    expect(body.courses['start-here']).toEqual({ hasAccess: false, reason: 'level_required', requiredLevel: 1 })
    expect(body.courses['agents-for-everyone']).toEqual({ hasAccess: true, reason: 'public', unlockedLessons: ['what-is-an-agent'] })
    expect(body.certification).toMatchObject({ level: 0, title: null, next: { level: 1, title: 'Explorer', claimable: true } })

    grantLevels(state, 'u1', 1)
    body = await me()
    expect(body.certification).toMatchObject({ level: 1, title: 'Explorer', next: { level: 2, title: 'Builder' } })
    expect(body.courses['start-here']).toEqual({ hasAccess: true, reason: 'level', unlockedLessons: ['what-an-agent-is'] })
    expect(body.courses['agent-team-playbook']).toEqual({ hasAccess: false, reason: 'level_required', requiredLevel: 2 })
    expect(res_noStore(await app.request('/api/learn/me', { headers: { [LEARN_TOKEN_HEADER]: tokenFor() } }))).toBe('no-store')
  })

  test('past Solo Founder buyers keep their board progress, the founding badge and a free Expert attempt', async () => {
    const state = baseState()
    state.enrollments.push({ userId: 'u1', workspaceId: 'ws-biz', courseId: SOLO_FOUNDER_COURSE_ID, progress: { completedLessons: ['m0', 'm1'] }, completedAt: null })
    const { app } = makeApp(state)
    const body = (await (await app.request('/api/learn/me', { headers: { [LEARN_TOKEN_HEADER]: tokenFor() } })).json()) as any
    expect(body.courses['solo-founder']).toMatchObject({ hasAccess: false, reason: 'level_required', requiredLevel: 3, progress: { completedLessons: ['m0', 'm1'] } })
    expect(body.certification.perks).toEqual({ freeExpertAttempt: true })
    expect(body.newBadges.map((b: any) => b.id)).toContain('founding-learner')
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

  test('signed in behind the production proxy: the API sees an internal Host and still sets the cookie', async () => {
    // Regression: prod's API gets an internal hostname (Knative), never studio.shogo.ai,
    // and a Host check answered every signed-in learner 404 "not configured on this host".
    const state = baseState()
    state.cookieSession = { userId: 'u1', sessionId: 's1' }
    const { app } = makeApp(state)
    const res = await app.request(`/api/learn/sso?return=${ret}`, { headers: { host: 'api.152.70.192.220.sslip.io' } })
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie')).toContain('Domain=.shogo.ai')
    // Still never on a host where the feature is off.
    delete process.env.LEARN_COOKIE_DOMAIN
    process.env.NODE_ENV = 'production'
    expect((await app.request(`/api/learn/sso?return=${ret}`, { headers: { host: 'studio.shogo.ai' } })).status).toBe(404)
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
    expect((await post(app, 'start-here', tokenFor())).status).toBe(403)
    const limited = await post(app, 'agents-for-everyone', tokenFor())
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('3600')
    expect(state.coachCalls).toHaveLength(0)
  })

  test('answers with the guarded, lesson-scoped prompt', async () => {
    const state = baseState()
    const { app } = makeApp(state)
    grantLevels(state, 'u1', 1)
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

  test('mints behind the production proxy (internal Host); no-op when the feature is not configured', async () => {
    const internal = new Request('http://api.shogo-production-system.svc.cluster.local/api/auth/get-session', { headers: { host: 'api.152.70.192.220.sslip.io' } })
    expect((await withLearnCookie(internal, new Response('{}'), deps)).headers.get('set-cookie')).toContain('Domain=.shogo.ai')
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

  test('a department check: locked below Level 1, then a pass awards its badge and certificate without changing the level', async () => {
    const MARKETING = { ...LEARN_CERTIFICATES['ai-for-marketing']!.answers }
    const state = finishLessons(baseState(), 'u1', 'ai-for-marketing')
    const { app } = makeApp(state)
    const locked = await post(app, { courseId: 'ai-for-marketing', answers: MARKETING })
    expect(locked.status).toBe(403)
    grantLevels(state, 'u1', 1)
    const res = await post(app, { courseId: 'ai-for-marketing', answers: MARKETING, name: 'Ada' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.passed).toBe(true)
    expect(body.levelUp ?? false).toBe(false)
    expect(body.newBadges.map((b: any) => b.id)).toContain('certified-ai-for-marketing')
    const verify = (await (await app.request(`/api/learn/certificate/${body.certificate.id}`)).json()) as any
    expect(verify).toMatchObject({ valid: true, courseId: 'ai-for-marketing', courseTitle: 'AI for Marketing', level: null })
  })

  test('the final check opens only after every lesson before it is done, and a refusal does not use up an attempt', async () => {
    const state = baseState()
    let attempts = 0
    const { app, deps } = makeApp(state)
    const take = deps.takeRateLimit
    deps.takeRateLimit = async (...args) => (attempts++, take(...args))
    const early = await post(app, { courseId: 'agents-for-everyone', answers: PASS })
    expect(early.status).toBe(403)
    expect(((await early.json()) as any).error).toBe('Finish every lesson in this course before the final check.')
    expect(attempts).toBe(0)
    expect(state.badges ?? []).toEqual([])
    finishLessons(state)
    state.completions = state.completions!.filter((c) => c.lessonId !== 'good-at-bad-at')
    expect((await post(app, { courseId: 'agents-for-everyone', answers: PASS })).status).toBe(403)
    finishLessons(state)
    expect((await post(app, { courseId: 'agents-for-everyone', answers: PASS })).status).toBe(200)
  })

  test('a pass returns a certificate that verifies publicly, with the chosen name and no email', async () => {
    const { app } = makeApp(finishLessons(baseState()))
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
      level: { level: 1, title: 'Explorer' },
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
    const { app } = makeApp(finishLessons(baseState()))
    const body = (await (await post(app, { courseId: 'agents-for-everyone', answers: PASS })).json()) as any
    expect(body.certificate.name).toBe('Ada')
  })

  test('a fail returns the score and which questions missed, but no certificate and no answer key', async () => {
    const { app } = makeApp(finishLessons(baseState()))
    const res = await post(app, { courseId: 'agents-for-everyone', answers: { q1: 'a', q2: 'c' } })
    const body = (await res.json()) as any
    expect(body).toMatchObject({ passed: false, score: 1, total: 6 })
    expect(body.wrong).toEqual(['q1', 'q3', 'q4', 'q5', 'q6'])
    expect(body.certificate).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('"d"')
  })

  test('requires sign-in, a known course, answers, and respects the daily cap', async () => {
    const state = baseState()
    const { app } = makeApp(finishLessons(state))
    expect((await post(app, { courseId: 'agents-for-everyone', answers: PASS }, null)).status).toBe(401)
    expect((await post(app, { courseId: 'start-here', answers: PASS })).status).toBe(404)
    expect((await post(app, { courseId: 'agents-for-everyone' })).status).toBe(400)
    state.rateAllowed = false
    const limited = await post(app, { courseId: 'agents-for-everyone', answers: PASS })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('3600')
  })

  test('rejects forged, tampered and cross-purpose ids', async () => {
    const { app } = makeApp(finishLessons(baseState()))
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
    expect(gradeLearnCheck(LEARN_CERTIFICATES['agents-for-everyone'], PASS)).toEqual({ score: 6, total: 6, wrong: [], passed: true })
  })
})


describe('Shogo Certified levels', () => {
  const H = (userId = 'u1', sessionId = 's1') => ({ 'content-type': 'application/json', [LEARN_TOKEN_HEADER]: tokenFor(userId, sessionId) })
  const claim = (app: Hono, body: unknown, headers: Record<string, string> = H()) =>
    app.request('/api/learn/level/claim', { method: 'POST', headers, body: JSON.stringify(body) })
  const finish = (state: FakeState, ...courses: string[]) => {
    state.completions ??= []
    for (const courseId of courses) {
      for (const lessonId of LEARN_LESSONS[courseId]) state.completions.push({ userId: 'u1', courseId, lessonId, day: '2026-11-19', completedAt: new Date(NOW) })
    }
  }

  test('the ladder: 6 levels, 1–3 claimable online, 5–6 carry an exam fee and renew', () => {
    expect(LEARN_LEVELS.map((l) => l.title)).toEqual(['Explorer', 'Builder', 'Operator', 'Professional', 'Expert', 'Architect'])
    expect(LEARN_LEVELS.filter((l) => l.claimable).map((l) => l.level)).toEqual([1, 2, 3])
    expect(LEARN_LEVELS.filter((l) => l.feeUsd).map((l) => [l.level, l.feeUsd, l.renewYears])).toEqual([[5, 299, 2], [6, 499, 2]])
    // Badge names come from the same titles.
    for (const l of LEARN_LEVELS) expect(LEARN_BADGES.find((b) => b.id === `level-${l.level}`)?.name).toBe(`Shogo Certified ${l.title}`)
    // Every course on a track exists on the catalog.
    for (const l of LEARN_LEVELS) for (const c of l.courses) expect(learnCourseById(c)).toBeDefined()
  })

  test('GET /level: sign-in required; requirements carry workspace evidence', async () => {
    const state = baseState()
    const { app } = makeApp(state)
    expect((await app.request('/api/learn/level')).status).toBe(401)
    grantLevels(state, 'u1', 1)
    state.evidence = { publishedApps: 1, agentCardsDone: 3, agentsWithDoneCards: 1 }
    const r = (await (await app.request('/api/learn/level', { headers: H() })).json()) as any
    expect(r.level).toBe(1)
    const two = r.levels.find((l: any) => l.level === 2)
    expect(two.requirements.find((q: any) => q.id === 'published-app')).toMatchObject({ ok: true, detail: '1 published' })
    expect(two.ready).toBe(false)
    const three = r.levels.find((l: any) => l.level === 3)
    expect(three.requirements.find((q: any) => q.id === 'agent-cards')).toMatchObject({ ok: false, detail: '3 of 5' })
    expect(r.levels.find((l: any) => l.level === 5)).toMatchObject({ claimable: false, feeUsd: 299, held: false })
  })

  test('Level 2 needs Level 1, every track lesson and a published app; then it is awarded with a verifiable certificate', async () => {
    const state = baseState()
    const { app } = makeApp(state)
    expect((await claim(app, { level: 2 })).status).toBe(422)
    grantLevels(state, 'u1', 1)
    finish(state, 'start-here', 'ai-teammates')
    const noApp = await claim(app, { level: 2 })
    expect(noApp.status).toBe(422)
    expect(((await noApp.json()) as any).requirements.find((q: any) => !q.ok).id).toBe('published-app')

    state.evidence = { publishedApps: 1, agentCardsDone: 0, agentsWithDoneCards: 0 }
    const ok = await claim(app, { level: 2, name: 'Grace Hopper' })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as any
    expect(body).toMatchObject({ level: 2, title: 'Builder', certificate: { name: 'Grace Hopper' } })
    expect(body.newBadges[0].id).toBe('level-2')
    const cert = (await (await app.request(`/api/learn/certificate/${body.certificate.id}`)).json()) as any
    expect(cert).toMatchObject({ valid: true, name: 'Grace Hopper', courseId: 'level-2', courseTitle: 'Shogo Certified Builder', level: { level: 2, title: 'Builder' } })

    const me = (await (await app.request('/api/learn/me', { headers: H() })).json()) as any
    expect(me.certification.level).toBe(2)
    expect(me.courses['agent-team-playbook']).toMatchObject({ hasAccess: true, unlockedLessons: ['team'] })
    expect((await claim(app, { level: 2 })).status).toBe(409)
  })

  test('Level 3 needs 5 cards finished by at least 2 different agents', async () => {
    const state = baseState()
    const { app } = makeApp(state)
    grantLevels(state, 'u1', 2)
    finish(state, 'agent-team-playbook')
    state.evidence = { publishedApps: 1, agentCardsDone: 9, agentsWithDoneCards: 1 }
    const one = await claim(app, { level: 3 })
    expect(one.status).toBe(422)
    expect(((await one.json()) as any).requirements.filter((q: any) => !q.ok).map((q: any) => q.id)).toEqual(['agent-team'])
    state.evidence.agentsWithDoneCards = 2
    expect((await claim(app, { level: 3 })).status).toBe(200)
    expect(heldLevel(state.badges!.filter((b) => b.userId === 'u1').map((b) => b.badgeId))).toBe(3)
  })

  test('claims refuse what they should', async () => {
    const state = baseState()
    const { app } = makeApp(state)
    expect((await claim(app, { level: 2 }, { 'content-type': 'application/json' })).status).toBe(401)
    expect((await claim(app, { level: 9 })).status).toBe(404)
    expect((await claim(app, { level: 1 })).status).toBe(400)
    expect((await claim(app, { level: 4 })).status).toBe(400)
    expect((await claim(app, { level: 5 })).status).toBe(400)
    state.rateAllowed = false
    expect((await claim(app, { level: 2 })).status).toBe(429)
    expect(state.badges ?? []).toHaveLength(0)
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

  test('XP: 10 a lesson, 50 a finished course, badge XP on top; ranks follow', () => {
    const course = 'start-here'
    const completions = LEARN_LESSONS[course].map((lessonId) => ({ courseId: course, lessonId, day: '2026-11-20' }))
    const stats = computeLearnStats({ completions, badgeIds: ['first-lesson', 'course-start-here'], today: '2026-11-20' })
    expect(stats.lessonsCompleted).toBe(7)
    expect(stats.coursesCompleted).toEqual(['start-here'])
    expect(stats.xp).toBe(7 * 10 + 50 + 20 + 20)
    expect(stats.rank.name).toBe('Kindling')
    expect(rankFor(0).next).toEqual({ name: 'Ember', min: 40 })
    expect(rankFor(99999).next).toBeNull()
  })

  test('finishing everything reaches the top rank', () => {
    const completions = Object.entries(LEARN_LESSONS).flatMap(([courseId, ls]) => ls.map((lessonId) => ({ courseId, lessonId, day: '2026-11-20' })))
    const all = computeLearnStats({ completions, badgeIds: LEARN_BADGES.map((b) => b.id), today: '2026-11-20' })
    expect(all.rank.next).toBeNull()
  })

  test('badges come from progress: first lesson, course graduate, foundations, founding learner', () => {
    const free = ['agents-for-everyone', 'start-here', 'ai-teammates']
    const completions = free.flatMap((courseId) => LEARN_LESSONS[courseId].map((lessonId) => ({ courseId, lessonId, day: '2026-11-20' })))
    const stats = computeLearnStats({ completions, badgeIds: [], today: '2026-11-20' })
    const got = qualifyingBadges(stats, { certified: ['agents-for-everyone'], firstActivityDay: '2026-11-20' })
    for (const b of ['first-lesson', 'lessons-10', 'course-start-here', 'course-ai-teammates', 'course-agents-for-everyone', 'certified-agents-for-everyone', 'level-1', 'foundations', 'founding-learner']) {
      expect(got).toContain(b)
    }
    expect(qualifyingBadges(stats, { firstActivityDay: '2027-02-01' })).not.toContain('founding-learner')
    for (const id of got) expect(LEARN_BADGES.some((b) => b.id === id)).toBe(true)
  })

  test('every course is self-paced on learn.shogo.ai, Solo Founder included', () => {
    for (const c of SELF_PACED_COURSES) expect(LEARN_LESSONS[c].length).toBeGreaterThan(0)
    expect(SELF_PACED_COURSES).toContain('solo-founder')
  })

  test('XP rank names never reuse a Shogo Certified level title', () => {
    const titles = new Set(LEARN_LEVELS.map((l) => l.title))
    for (let xp = 0; xp < 2000; xp += 10) expect(titles.has(rankFor(xp).name)).toBe(false)
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
    grantLevels(st, 'u1', 1)
    return st
  }

  test('marking a lesson complete saves it to the account and awards first badges', async () => {
    const st = freeLearner()
    const { app } = makeApp(st)
    const res = await post(app, '/progress', { courseId: 'start-here', lessonId: 'what-an-agent-is', tz: 'America/Los_Angeles' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.added).toBe(true)
    expect(body.completedLessons).toEqual(['what-an-agent-is'])
    expect(body.newBadges.map((b: any) => b.id).sort()).toEqual(['first-lesson', 'founding-learner'])
    // Level 1's badge XP (100) is already held.
    expect(body.stats.xp).toBe(100 + 10 + 20 + 20)
    expect(body.rankUp).toBe(true)
    expect(body.levelUp).toBeNull()
    expect(st.completions).toEqual([{ userId: 'u1', courseId: 'start-here', lessonId: 'what-an-agent-is', day: '2026-11-20', completedAt: new Date(NOW) }])

    const again = (await (await post(app, '/progress', { courseId: 'start-here', lessonId: 'what-an-agent-is' })).json()) as any
    expect(again.added).toBe(false)
    expect(again.newBadges).toEqual([])
    expect(again.rankUp).toBe(false)
    expect(st.badges).toHaveLength(3)
  })

  test('progress is per learner: a teammate in the same workspace starts at zero', async () => {
    const st = freeLearner()
    const { app } = makeApp(st)
    await post(app, '/progress', { courseId: 'start-here', lessonId: 'what-an-agent-is' })
    const me2 = (await (await app.request('/api/learn/me', { headers: H('u2', 's2') })).json()) as any
    expect(me2.stats.lessonsCompleted).toBe(0)
    expect(me2.badges).toEqual([])
  })

  test('refuses what it should', async () => {
    const st = freeLearner()
    const { app } = makeApp(st)
    expect((await post(app, '/progress', { courseId: 'start-here', lessonId: 'what-an-agent-is' }, { 'content-type': 'application/json' })).status).toBe(401)
    expect((await post(app, '/progress', { courseId: 'start-here', lessonId: 'nope' })).status).toBe(404)
    expect((await post(app, '/progress', { courseId: 'agents-for-everyone', lessonId: 'final-check' })).status).toBe(400)
    // Locked course: the error names the level that opens it.
    const locked = await post(app, '/progress', { courseId: 'paid-app', lessonId: 'day-1-pick' })
    expect(locked.status).toBe(403)
    expect(((await locked.json()) as any).error).toBe('Earn Shogo Certified Level 3 (Operator) to open this course.')
    expect((await post(app, '/progress', { courseId: 'solo-founder', lessonId: 'm0' })).status).toBe(403)
    // Lessons open in order.
    const early = await post(app, '/progress', { courseId: 'start-here', lessonId: 'first-app' })
    expect(early.status).toBe(403)
    expect(((await early.json()) as any).error).toBe('Finish the lesson before this one first.')
    st.rateAllowed = false
    expect((await post(app, '/progress', { courseId: 'start-here', lessonId: 'what-an-agent-is' })).status).toBe(429)
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
      { courseId: 'start-here', lessonId: 'review-loop' },
      { courseId: 'nope', lessonId: 'x' },
    ]
    const r = (await (await post(app, '/progress/import', { items, tz: 'UTC' })).json()) as any
    expect(r.imported).toBe(2)
    expect(st.completions!.map((c) => [c.lessonId, c.day])).toEqual([['what-is-an-agent', '2026-11-18'], ['good-at-bad-at', '2026-11-20']])
    expect((await post(app, '/progress/import', { items: 'x' })).status).toBe(400)
  })

  test('passing the final check completes its lesson and earns Shogo Certified Level 1', async () => {
    const st = finishLessons(freeLearner())
    st.badges = []
    const { app } = makeApp(st)
    const rule = LEARN_CERTIFICATES['agents-for-everyone']
    const answers = { ...rule.answers }
    const r = (await (await post(app, '/certificate', { courseId: 'agents-for-everyone', answers, tz: 'UTC' })).json()) as any
    expect(r.passed).toBe(true)
    expect(r.newBadges.map((b: any) => b.id)).toEqual(expect.arrayContaining(['certified-agents-for-everyone', 'first-lesson', 'level-1']))
    expect([...r.stats.completedLessons['agents-for-everyone']].sort()).toEqual([...LEARN_LESSONS['agents-for-everyone']!].sort())
    // 6 lessons, the course, the certificate, first-lesson + course + founding badges, Level 1
    expect(r.stats.xp).toBe(6 * 10 + 50 + 100 + 20 + 20 + 20 + 100)
    expect(r.level).toBe(1)
    expect(r.levelUp).toEqual({ level: 1, title: 'Explorer' })
    const me = (await (await app.request('/api/learn/me', { headers: H() })).json()) as any
    expect(me.courses['start-here'].hasAccess).toBe(true)
  })

  test('badge share links: only for held badges, publicly verifiable, tamper-proof', async () => {
    const st = freeLearner()
    const { app } = makeApp(st)
    expect((await post(app, '/badge-share', { badgeId: 'first-lesson' })).status).toBe(404)
    await post(app, '/progress', { courseId: 'start-here', lessonId: 'what-an-agent-is' })
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
    expect(r.levels.map((l: any) => l.level)).toEqual([1, 2, 3, 4, 5, 6])
    expect(r.ranks[0].name).toBe('Spark')
    expect(r.departments.map((d: any) => d.id)).toEqual(DEPARTMENTS.map((d) => d.id))
  })
})
