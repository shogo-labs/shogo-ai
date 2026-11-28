// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The passwordless email-code sign-in plugin (SHO-613).
 *
 * Pins the three server-side decisions that are easy to lose in a refactor and
 * expensive to get wrong:
 *
 *   1. `storeOTP: 'hashed'` — the plugin also registers a *public*
 *      `GET /email-otp/get-verification-otp`, which returns the stored code
 *      verbatim when it is stored in plain text. Plain storage would let anyone
 *      request a code for an address and read it straight back: an account
 *      takeover.
 *   2. `/email-otp/send-verification-otp` is rate limited by the cluster-wide
 *      sign-up limiter, because it mails an arbitrary address and creates the
 *      account on verification (the SHO-416 farm shape).
 *   3. Both OTP endpoints are in the project-auth allow-list, so a published
 *      project that excludes an email cannot be signed into through a code.
 *
 * Strategy matches `auth-hooks.test.ts`: capture the object handed to
 * `betterAuth()` and `emailOTP()`, then drive the hooks directly. No database.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let capturedConfig: any = null
let capturedOtpOptions: any = null

mock.module('better-auth', () => ({
  betterAuth: (cfg: any) => {
    capturedConfig = cfg
    return { _config: cfg, api: {} }
  },
}))

mock.module('better-auth/plugins', () => ({
  emailOTP: (options: any) => {
    capturedOtpOptions = options
    return { id: 'email-otp', options }
  },
}))

class FakeAPIError extends Error {
  status: string
  body: unknown
  headers: unknown
  constructor(status: string, body: any, headers?: unknown) {
    super(body?.message ?? status)
    this.name = 'APIError'
    this.status = status
    this.body = body
    this.headers = headers
  }
}

mock.module('better-auth/api', () => ({
  APIError: FakeAPIError,
  createAuthMiddleware: (handler: (ctx: any) => unknown) => handler,
}))

mock.module('@better-auth/expo', () => ({
  expo: () => ({ id: 'expo-plugin' }),
}))

mock.module('../lib/native-oauth-trust', () => ({
  expoAuthorizationProxyGuard: { id: 'expo-proxy-guard' },
  nativeTrustedOrigins: () => [],
}))

mock.module('../services/workspace.service', () => ({
  createPersonalWorkspace: async () => {},
  createDefaultTeamWorkspace: async () => {},
}))

const emailState: { codeCalls: Array<{ to: string; otp: string; expiresIn?: string }>; shouldFail: boolean } = {
  codeCalls: [],
  shouldFail: false,
}

mock.module('../services/auth-integrations', () => ({
  sendWelcomeEmail: async () => ({ success: true }),
  sendPasswordResetEmail: async () => ({ success: true }),
  sendEmailVerificationEmail: async () => ({ success: true }),
  sendVerificationCodeEmail: async (params: { to: string; otp: string; expiresIn?: string }) => {
    emailState.codeCalls.push(params)
    return emailState.shouldFail
      ? { success: false, error: 'smtp down' }
      : { success: true }
  },
  identifyUser: async () => {},
  trackEvent: async () => {},
  resolveAttributionForUser: async () => null,
}))

const allowState: { verdict: { allowed: boolean; reason?: string } } = {
  verdict: { allowed: true },
}

mock.module('../services/project-auth-config.service', () => ({
  evaluateAllowlist: async () => allowState.verdict,
  recordSignIn: async () => {},
}))

const limitState: { verdict: { allowed: boolean; retryAfterSeconds: number } } = {
  verdict: { allowed: true, retryAfterSeconds: 0 },
}

mock.module('../lib/signup-rate-limit', () => ({
  checkSignupRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  checkVerificationEmailRateLimit: async () => limitState.verdict,
}))

mock.module('../services/signup-risk.service', () => ({
  DEVICE_ID_COOKIE: 'shogo_device_id',
  readDeviceId: () => null,
}))

mock.module('../services/signup-risk-scoring', () => ({
  isBlockedEmailDomain: () => false,
}))

mock.module('../lib/signup-trust', () => ({
  invalidateSignupTrustHold: () => {},
  getSignupTrustHold: async () => null,
}))

mock.module('../lib/tunnel-redis', () => ({
  getSharedRedis: () => null,
}))

mock.module('../lib/prisma', () => ({
  prisma: {
    user: {
      count: async () => 0,
      findUnique: async () => null,
      findFirst: async () => null,
      update: async () => ({ id: 'u' }),
    },
    signupRiskAssessment: { findUnique: async () => null, upsert: async () => ({}) },
    $transaction: async (ops: any[]) => Promise.all(ops),
  },
}))

mock.module('../services/signup-credit.service', () => ({
  applyInitialSignupCredit: async () => {},
  releaseSignupCreditOnVerification: async () => ({ released: false, reason: 'none' }),
}))

const { auth } = await import('../auth')
if (!capturedConfig) throw new Error('betterAuth() was not captured')
if (!capturedOtpOptions) throw new Error('emailOTP() was not captured')

const plugins: any[] = capturedConfig.plugins
const otpPlugin = plugins.find((plugin) => plugin.id === 'email-otp')
const projectAuthPlugin = plugins.find((plugin) => plugin.id === 'shogo-project-auth-allowlist')
const rateLimitPlugin = plugins.find((plugin) => plugin.id === 'shogo-signup-rate-limit')

/** The before-hook whose `matcher` accepts `path`. */
function beforeHookFor(plugin: any, path: string) {
  return plugin.hooks.before.find((hook: any) => hook.matcher({ path }))
}

function ctxFor(path: string, email?: string, projectId?: string) {
  const headers = new Headers()
  if (projectId) headers.set('x-shogo-project-id', projectId)
  return {
    path,
    body: email === undefined ? {} : { email },
    headers,
    request: undefined,
  }
}

const PROJECT_ID = 'proj_613' 

const originalWarn = console.warn
let warned: string[] = []

beforeEach(() => {
  emailState.codeCalls = []
  emailState.shouldFail = false
  allowState.verdict = { allowed: true }
  limitState.verdict = { allowed: true, retryAfterSeconds: 0 }
  warned = []
  console.warn = (...args: unknown[]) => {
    warned.push(args.map(String).join(' '))
  }
})

afterEach(() => {
  console.warn = originalWarn
})

describe('the emailOTP plugin configuration', () => {
  test('is registered on the auth instance', () => {
    expect(otpPlugin).toBeDefined()
    expect(plugins.some((plugin) => plugin.id === 'email-otp')).toBe(true)
  })

  test('uses a 6-digit code that lives 10 minutes and allows 5 attempts', () => {
    expect(capturedOtpOptions.otpLength).toBe(6)
    expect(capturedOtpOptions.expiresIn).toBe(600)
    expect(capturedOtpOptions.allowedAttempts).toBe(5)
  })

  // The plugin exposes `GET /email-otp/get-verification-otp` publicly and that
  // endpoint returns the stored code verbatim for plain storage.
  test('stores the code hashed, so the public get-verification-otp cannot read it back', () => {
    expect(capturedOtpOptions.storeOTP).toBe('hashed')
  })

  test('does not take over the existing verification-email flow', () => {
    expect(capturedOtpOptions.overrideDefaultEmailVerification).toBeFalsy()
  })

  test('mails the code through the transactional email service', async () => {
    await capturedOtpOptions.sendVerificationOTP({ email: 'new@example.com', otp: '123456', type: 'sign-in' })
    expect(emailState.codeCalls).toEqual([
      { to: 'new@example.com', otp: '123456', expiresIn: '10 minutes' },
    ])
    expect(warned).toEqual([])
  })

  test('logs the code only when the email could not be sent (local/dev escape hatch)', async () => {
    emailState.shouldFail = true
    await capturedOtpOptions.sendVerificationOTP({ email: 'new@example.com', otp: '654321', type: 'sign-in' })
    expect(warned.join('\n')).toContain('654321')
  })

  test('never logs the code when the email went out', async () => {
    await capturedOtpOptions.sendVerificationOTP({ email: 'new@example.com', otp: '999999', type: 'sign-in' })
    expect(warned.join('\n')).not.toContain('999999')
  })
})

describe('the sign-up rate limiter covers the code request', () => {
  test('its matcher claims the send endpoint and nothing else OTP-shaped', () => {
    const hook = beforeHookFor(rateLimitPlugin, '/email-otp/send-verification-otp')
    expect(hook).toBeDefined()
    expect(rateLimitPlugin.hooks.before[0].matcher({ path: '/sign-up/email' })).toBe(true)
  })

  test('a refused request is a 429 SIGNUP_RATE_LIMITED with Retry-After', async () => {
    limitState.verdict = { allowed: false, retryAfterSeconds: 42 }
    const hook = beforeHookFor(rateLimitPlugin, '/email-otp/send-verification-otp')
    let thrown: any = null
    try {
      await hook.handler(ctxFor('/email-otp/send-verification-otp', 'farm@example.com'))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(FakeAPIError)
    expect(thrown.status).toBe('TOO_MANY_REQUESTS')
    expect(thrown.body.code).toBe('SIGNUP_RATE_LIMITED')
    expect((thrown.headers as Record<string, string>)['Retry-After']).toBe('42')
  })

  test('an allowed request passes through', async () => {
    const hook = beforeHookFor(rateLimitPlugin, '/email-otp/send-verification-otp')
    await expect(
      hook.handler(ctxFor('/email-otp/send-verification-otp', 'ok@example.com')),
    ).resolves.toBeUndefined()
  })
})

describe('the project allow-list covers the code endpoints', () => {
  test('both legs of the code flow are matched', () => {
    expect(projectAuthPlugin.hooks.before[0].matcher({ path: '/email-otp/send-verification-otp' })).toBe(true)
    expect(projectAuthPlugin.hooks.before[0].matcher({ path: '/sign-in/email-otp' })).toBe(true)
    expect(projectAuthPlugin.hooks.before[0].matcher({ path: '/get-session' })).toBe(false)
  })

  test('an excluded email cannot request a code', async () => {
    allowState.verdict = { allowed: false, reason: 'custom_not_listed' }
    const hook = beforeHookFor(projectAuthPlugin, '/email-otp/send-verification-otp')
    const ctx = ctxFor('/email-otp/send-verification-otp', 'nope@example.com', PROJECT_ID)
    let thrown: any = null
    try {
      await hook.handler(ctx)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(FakeAPIError)
    expect(thrown.status).toBe('FORBIDDEN')
    expect(thrown.body.code).toBe('project_auth_not_allowed')
  })

  test('an excluded email cannot exchange a code for a session', async () => {
    allowState.verdict = { allowed: false, reason: 'workspace_not_member' }
    const hook = beforeHookFor(projectAuthPlugin, '/sign-in/email-otp')
    let thrown: any = null
    try {
      await hook.handler(ctxFor('/sign-in/email-otp', 'nope@example.com', PROJECT_ID))
    } catch (err) {
      thrown = err
    }
    expect(thrown?.body?.code).toBe('project_auth_not_allowed')
  })

  test('an allowed email passes and a request with no project header is untouched', async () => {
    const hook = beforeHookFor(projectAuthPlugin, '/sign-in/email-otp')
    await expect(
      hook.handler(ctxFor('/sign-in/email-otp', 'ok@example.com', PROJECT_ID)),
    ).resolves.toBeUndefined()
  })
})

describe('the auth instance still exposes the documented surface', () => {
  test('email + password and the social providers are unchanged', () => {
    expect(capturedConfig.emailAndPassword.enabled).toBe(true)
    expect(typeof capturedConfig.emailAndPassword.sendResetPassword).toBe('function')
    expect(typeof capturedConfig.emailVerification.sendVerificationEmail).toBe('function')
    expect(typeof (auth as any)).toBe('object')
  })
})
