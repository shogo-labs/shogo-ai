// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-416 acceptance — AC #6.
 *
 * A high-band signup must send nothing: no welcome email, no automatic
 * verification email, no Loops identify/`signup` event. A resend through
 * `/send-verification-email` still goes out (a real person needs it), and the
 * deferred onboarding is sent exactly once when the hold actually lifts.
 *
 * Same harness as `auth-hooks.test.ts`: `betterAuth()` is captured so the
 * hooks can be invoked directly with fake users and contexts.
 *
 *   bun test apps/api/src/__tests__/qa-sho416-signup-onboarding.acceptance.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

delete process.env.SHOGO_LOCAL_MODE

let capturedConfig: any = null

mock.module('better-auth', () => ({
  betterAuth: (cfg: any) => {
    capturedConfig = cfg
    return { _config: cfg, api: {} }
  },
}))

class FakeAPIError extends Error {
  status: string
  body: unknown
  constructor(status: string, body: { message?: string }) {
    super(body.message ?? status)
    this.name = 'APIError'
    this.status = status
    this.body = body
  }
}

mock.module('better-auth/api', () => ({
  APIError: FakeAPIError,
  createAuthMiddleware: (handler: (ctx: any) => unknown) => handler,
}))

// `auth.ts` imports `emailOTP` from here while building its plugin list; under
// a mocked `better-auth` that subpath resolves to a module Bun cannot load
// (`getEndpoints` is not exported by 1.4.18's api/index.mjs).
mock.module('better-auth/plugins', () => ({ emailOTP: () => ({ id: 'email-otp' }) }))

mock.module('@better-auth/expo', () => ({ expo: () => ({ id: 'expo-plugin' }) }))

// ─── Mutable state the tests drive ────────────────────────────────────────
const state = {
  band: 'low' as 'low' | 'medium' | 'high',
  assessmentThrows: false,
  welcome: 0,
  verify: 0,
  identify: 0,
  track: [] as string[],
  releaseReason: 'rescored_below_high' as string,
  releaseCalls: 0,
  assessment: null as any,
  user: null as any,
}

mock.module('../services/workspace.service', () => ({
  createPersonalWorkspace: async () => ({ id: 'ws-personal' }),
  createDefaultTeamWorkspace: async () => ({ id: 'ws-team' }),
}))

mock.module('../services/auth-integrations', () => ({
  sendWelcomeEmail: async () => {
    state.welcome++
    return { success: true }
  },
  sendPasswordResetEmail: async () => ({ success: true }),
  sendEmailVerificationEmail: async () => {
    state.verify++
    return { success: true }
  },
  identifyUser: async () => {
    state.identify++
  },
  trackEvent: async (_userId: string, event: string) => {
    state.track.push(event)
  },
  resolveAttributionForUser: async () => {},
  // `auth.ts` builds its plugin list, which imports this at module scope
  // (SHO-613). A stub that omits it makes Bun throw `Export named ... not
  // found` before a single test runs.
  sendVerificationCodeEmail: async () => ({ success: true }),
}))

mock.module('../services/project-auth-config.service', () => ({
  evaluateAllowlist: async () => ({ allowed: true }),
  recordSignIn: async () => {},
}))

mock.module('../lib/prisma', () => ({
  prisma: {
    user: {
      count: async () => 0,
      update: async () => ({ id: 'u', role: 'user' }),
      findUnique: async () => state.user,
    },
    signupRiskAssessment: {
      findUnique: async () => state.assessment,
    },
    member: {
      findFirst: async () => null,
    },
  },
}))

mock.module('../services/signup-risk.service', () => ({
  DEVICE_ID_COOKIE: 'shogo.device_id',
  readDeviceId: () => null,
  assessNewSignup: async () => {
    if (state.assessmentThrows) throw new Error('scoring down')
    return { band: state.band, decision: state.band === 'high' ? 'no_credit' : 'initial', score: 10 }
  },
  // `lib/signup-rate-limit.ts` imports this; the limiter itself is not under
  // test here, so a no-IP stub keeps it inert.
  readSignupRequestInfo: () => ({
    ip: null,
    ipPrefix: null,
    country: null,
    deviceId: null,
    e2eAllowlisted: false,
  }),
}))

mock.module('../services/signup-credit.service', () => ({
  applyInitialSignupCredit: async () => {},
  releaseSignupCreditOnVerification: async () => {
    state.releaseCalls++
    return { released: false, reason: state.releaseReason, band: 'low' }
  },
}))

mock.module('../lib/region', () => ({ homeRegionForNewUser: async () => 'us' }))
mock.module('../lib/cloud-urls', () => ({ getFrontendUrl: () => 'https://app.shogo.ai' }))

// ─── Import auth.ts (captures the config) ─────────────────────────────────
await import('../auth')
if (!capturedConfig) throw new Error('betterAuth() was not captured')

const { _clearSignupTrustCacheForTests } = await import('../lib/signup-trust')

const origLog = console.log
const origWarn = console.warn
const origError = console.error

beforeEach(() => {
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  state.band = 'low'
  state.assessmentThrows = false
  state.welcome = 0
  state.verify = 0
  state.identify = 0
  state.track = []
  state.releaseReason = 'rescored_below_high'
  state.releaseCalls = 0
  state.assessment = null
  state.user = { id: 'u-1', email: 'bot@farm.dev', name: 'Bot' }
  // The hold is cached for 60s in production; each test starts from a cold one.
  _clearSignupTrustCacheForTests()
})

afterEach(() => {
  console.log = origLog
  console.warn = origWarn
  console.error = origError
})

const signUpCtx = { path: '/sign-up/email', request: { url: 'https://api.shogo.ai/api/auth/sign-up/email', headers: new Headers() } }

async function signUp(user: any = { id: 'u-1', email: 'bot@farm.dev', name: 'Bot', emailVerified: false }) {
  await capturedConfig.databaseHooks.user.create.after(user, signUpCtx)
  // Fire-and-forget sends need a tick.
  await new Promise((r) => setTimeout(r, 10))
}

describe('SHO-416 AC#6 — a held signup sends nothing', () => {
  test('high band + unverified: no welcome email, no Loops identify/signup', async () => {
    state.band = 'high'
    await signUp()
    expect(state.welcome).toBe(0)
    expect(state.identify).toBe(0)
    expect(state.track).not.toContain('signup')
    expect(state.track).not.toContain('signup_risk_scored')
  })

  test('low band: onboarding goes out as before', async () => {
    state.band = 'low'
    await signUp()
    expect(state.welcome).toBe(1)
    expect(state.identify).toBe(1)
    expect(state.track).toContain('signup')
    expect(state.track).toContain('signup_risk_scored')
  })

  test('a scoring failure leaves the account unheld, so onboarding still goes out', async () => {
    state.assessmentThrows = true
    await signUp()
    expect(state.welcome).toBe(1)
    expect(state.identify).toBe(1)
  })

  test('the automatic sign-up verification email is skipped for a held account', async () => {
    state.assessment = { band: 'high', reviewDecision: null, signals: { provider: 'credential' } }
    state.user = { emailVerified: false }
    await capturedConfig.emailVerification.sendVerificationEmail(
      { user: { id: 'u-1', email: 'bot@farm.dev', name: 'Bot' }, url: 'https://verify' },
      new Request('https://api.shogo.ai/api/auth/sign-up/email', { method: 'POST' }),
    )
    expect(state.verify).toBe(0)
  })

  test('a user-requested resend still goes out for a held account', async () => {
    state.assessment = { band: 'high', reviewDecision: null, signals: { provider: 'credential' } }
    state.user = { emailVerified: false }
    await capturedConfig.emailVerification.sendVerificationEmail(
      { user: { id: 'u-1', email: 'bot@farm.dev', name: 'Bot' }, url: 'https://verify' },
      new Request('https://api.shogo.ai/api/auth/send-verification-email', { method: 'POST' }),
    )
    expect(state.verify).toBe(1)
  })

  test('a low-band signup still gets its automatic verification email', async () => {
    state.assessment = { band: 'low', reviewDecision: null, signals: { provider: 'credential' } }
    state.user = { emailVerified: false }
    await capturedConfig.emailVerification.sendVerificationEmail(
      { user: { id: 'u-1', email: 'real@company.io', name: 'Real' }, url: 'https://verify' },
      new Request('https://api.shogo.ai/api/auth/sign-up/email', { method: 'POST' }),
    )
    expect(state.verify).toBe(1)
  })
})

describe('SHO-416 AC#6 — deferred onboarding is sent once, when the hold lifts', () => {
  test('verification that drops the band below high sends the onboarding once', async () => {
    state.assessment = { band: 'high', reviewDecision: null }
    state.releaseReason = 'rescored_below_high'

    await capturedConfig.emailVerification.afterEmailVerification({ id: 'u-1', email: 'real@company.io', name: 'Real' })
    await new Promise((r) => setTimeout(r, 10))

    expect(state.releaseCalls).toBe(1)
    expect(state.welcome).toBe(1)
    expect(state.identify).toBe(1)
    expect(state.track).toContain('signup')
  })

  test('a re-score that stays high sends nothing (the account is under review)', async () => {
    state.assessment = { band: 'high', reviewDecision: null }
    state.releaseReason = 'rescored_high_risk'

    await capturedConfig.emailVerification.afterEmailVerification({ id: 'u-1', email: 'bot@farm.dev', name: 'Bot' })
    await new Promise((r) => setTimeout(r, 10))

    expect(state.welcome).toBe(0)
    expect(state.identify).toBe(0)
  })

  test('a second verification of an already-released account sends nothing', async () => {
    // The band is no longer high, so the account was not held at this point.
    state.assessment = { band: 'low', reviewDecision: null }
    state.releaseReason = 'not_eligible'

    await capturedConfig.emailVerification.afterEmailVerification({ id: 'u-1', email: 'real@company.io', name: 'Real' })
    await new Promise((r) => setTimeout(r, 10))

    expect(state.welcome).toBe(0)
    expect(state.identify).toBe(0)
  })
})
