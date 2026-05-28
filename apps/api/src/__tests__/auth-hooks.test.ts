// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coverage for src/auth.ts databaseHooks + emailAndPassword/emailVerification
 * + the project-auth-allowlist plugin's before/after handlers.
 *
 * Strategy:
 *   - mock.module('better-auth') captures the config object passed to
 *     betterAuth() so we can invoke its hooks directly with fake user / ctx.
 *   - mock.module('better-auth/api') provides createAuthMiddleware (returns
 *     its handler unchanged) + APIError (custom error class).
 *   - All service deps (workspace, email, affiliate, project-auth-config,
 *     prisma) are mocked.
 *
 * isLocalMode is captured at module load — we only run the non-local-mode
 * branches in this file. SHOGO_AFFILIATES_NATIVE and the email-log env
 * vars are read on every hook invocation, so they ARE flipped between tests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ---------------------------------------------------------------------------
// Capture the betterAuth(config) call so we can invoke hooks directly.
// ---------------------------------------------------------------------------

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
  // createAuthMiddleware returns the handler verbatim so we can call it.
  createAuthMiddleware: (handler: (ctx: any) => unknown) => handler,
}))

mock.module('@better-auth/expo', () => ({
  expo: () => ({ id: 'expo-plugin' }),
}))

// ---------------------------------------------------------------------------
// Service mocks (mutable state so each test can drive its own branch)
// ---------------------------------------------------------------------------

const wsState: {
  createCalls: Array<{ userId: string; name: string }>
  shouldFailTimes: number
} = { createCalls: [], shouldFailTimes: 0 }

mock.module('../services/workspace.service', () => ({
  createPersonalWorkspace: async (userId: string, name: string) => {
    wsState.createCalls.push({ userId, name })
    if (wsState.shouldFailTimes > 0) {
      wsState.shouldFailTimes--
      throw new Error('workspace create failed')
    }
    return { id: 'ws-1' }
  },
}))

const emailState: {
  welcomeCalls: number
  resetCalls: number
  verifyCalls: number
  welcomeShouldThrow: boolean
  resetShouldFail: boolean
  verifyShouldFail: boolean
} = {
  welcomeCalls: 0, resetCalls: 0, verifyCalls: 0,
  welcomeShouldThrow: false, resetShouldFail: false, verifyShouldFail: false,
}

mock.module('../services/email.service', () => ({
  sendWelcomeEmail: async () => {
    emailState.welcomeCalls++
    if (emailState.welcomeShouldThrow) throw new Error('welcome send failed')
    return { success: true }
  },
  sendPasswordResetEmail: async () => {
    emailState.resetCalls++
    return emailState.resetShouldFail
      ? { success: false, error: 'smtp down' }
      : { success: true }
  },
  sendEmailVerificationEmail: async () => {
    emailState.verifyCalls++
    return emailState.verifyShouldFail
      ? { success: false, error: 'smtp down' }
      : { success: true }
  },
}))

const affState: {
  calls: Array<{ userId: string; visitorId: string; code: string | null }>
  shouldThrow: boolean
} = { calls: [], shouldThrow: false }

mock.module('../services/affiliate.service', () => ({
  resolveAttributionForUser: async (userId: string, visitorId: string, code: string | null) => {
    affState.calls.push({ userId, visitorId, code })
    if (affState.shouldThrow) throw new Error('affiliate down')
  },
}))

const allowState: {
  verdict: { allowed: boolean; reason?: string }
  recordCalls: Array<{ projectId: string; userId: string }>
  recordShouldThrow: boolean
} = {
  verdict: { allowed: true },
  recordCalls: [],
  recordShouldThrow: false,
}

mock.module('../services/project-auth-config.service', () => ({
  evaluateAllowlist: async (_projectId: string, _email: string) => allowState.verdict,
  recordSignIn: async (projectId: string, userId: string) => {
    allowState.recordCalls.push({ projectId, userId })
    if (allowState.recordShouldThrow) throw new Error('record failed')
  },
}))

mock.module('../lib/prisma', () => ({
  prisma: {
    user: {
      count: async () => 0, // never local-mode-blocked in this file
      update: async (_args: unknown) => ({ id: 'u', role: 'super_admin' }),
    },
  },
}))

// ---------------------------------------------------------------------------
// Now import auth.ts — this triggers betterAuth() with our captured config.
// ---------------------------------------------------------------------------

const { parseCookieHeader } = await import('../auth')
if (!capturedConfig) throw new Error('betterAuth() was not captured')

const origLog = console.log
const origWarn = console.warn
const origError = console.error
beforeEach(() => {
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  // Reset mutable state
  wsState.createCalls.length = 0
  wsState.shouldFailTimes = 0
  emailState.welcomeCalls = 0
  emailState.resetCalls = 0
  emailState.verifyCalls = 0
  emailState.welcomeShouldThrow = false
  emailState.resetShouldFail = false
  emailState.verifyShouldFail = false
  affState.calls.length = 0
  affState.shouldThrow = false
  allowState.verdict = { allowed: true }
  allowState.recordCalls.length = 0
  allowState.recordShouldThrow = false
  delete process.env.SHOGO_AFFILIATES_NATIVE
  delete process.env.NODE_ENV
  delete process.env.SHOGO_LOG_PASSWORD_RESET_URL
  delete process.env.SHOGO_LOG_EMAIL_VERIFICATION_URL
})
afterEach(() => {
  console.log = origLog
  console.warn = origWarn
  console.error = origError
})

// ===========================================================================
// parseCookieHeader (pure exported function)
// ===========================================================================

describe('parseCookieHeader', () => {
  test('returns null for empty header', () => {
    expect(parseCookieHeader('', 'foo')).toBeNull()
  })

  test('returns value for matching name', () => {
    expect(parseCookieHeader('foo=bar; baz=qux', 'foo')).toBe('bar')
    expect(parseCookieHeader('foo=bar; baz=qux', 'baz')).toBe('qux')
  })

  test('returns null when name not present', () => {
    expect(parseCookieHeader('foo=bar', 'absent')).toBeNull()
  })

  test('handles URL-encoded values', () => {
    expect(parseCookieHeader('x=hello%20world', 'x')).toBe('hello world')
  })

  test('skips malformed cookie parts (no "=")', () => {
    expect(parseCookieHeader('flagonly; foo=bar', 'foo')).toBe('bar')
  })

  test('trims surrounding whitespace', () => {
    expect(parseCookieHeader('  foo  =  bar  ', 'foo')).toBe('bar')
  })
})

// ===========================================================================
// emailAndPassword.sendResetPassword
// ===========================================================================

describe('emailAndPassword.sendResetPassword', () => {
  test('success: calls sendPasswordResetEmail and returns silently', async () => {
    await capturedConfig.emailAndPassword.sendResetPassword({
      user: { email: 'a@b.com', name: 'A' }, url: 'https://reset/url',
    })
    expect(emailState.resetCalls).toBe(1)
  })

  test('failure in production-no-log mode: no warn', async () => {
    emailState.resetShouldFail = true
    process.env.NODE_ENV = 'production'
    let warned = false
    console.warn = () => { warned = true }
    await capturedConfig.emailAndPassword.sendResetPassword({
      user: { email: 'a@b.com' }, url: 'https://url',
    })
    expect(warned).toBe(false)
  })

  test('failure in dev: logs reset link to console.warn', async () => {
    emailState.resetShouldFail = true
    delete process.env.NODE_ENV // dev mode
    let warnMsg = ''
    console.warn = (m: string) => { warnMsg = String(m) }
    await capturedConfig.emailAndPassword.sendResetPassword({
      user: { email: 'a@b.com' }, url: 'https://reset.example/code',
    })
    expect(warnMsg).toContain('https://reset.example/code')
  })

  test('failure in production with SHOGO_LOG_PASSWORD_RESET_URL=true: logs', async () => {
    emailState.resetShouldFail = true
    process.env.NODE_ENV = 'production'
    process.env.SHOGO_LOG_PASSWORD_RESET_URL = 'true'
    let warned = false
    console.warn = () => { warned = true }
    await capturedConfig.emailAndPassword.sendResetPassword({
      user: { email: 'a@b.com' }, url: 'https://url',
    })
    expect(warned).toBe(true)
  })
})

// ===========================================================================
// emailVerification.sendVerificationEmail
// ===========================================================================

describe('emailVerification.sendVerificationEmail', () => {
  test('success: calls sendEmailVerificationEmail', async () => {
    await capturedConfig.emailVerification.sendVerificationEmail({
      user: { email: 'a@b.com', name: 'A' }, url: 'https://verify',
    })
    expect(emailState.verifyCalls).toBe(1)
  })

  test('failure in dev: logs verify link', async () => {
    emailState.verifyShouldFail = true
    let warnMsg = ''
    console.warn = (m: string) => { warnMsg = String(m) }
    await capturedConfig.emailVerification.sendVerificationEmail({
      user: { email: 'a@b.com' }, url: 'https://verify/link',
    })
    expect(warnMsg).toContain('https://verify/link')
  })

  test('failure in production-no-log mode: no warn', async () => {
    emailState.verifyShouldFail = true
    process.env.NODE_ENV = 'production'
    let warned = false
    console.warn = () => { warned = true }
    await capturedConfig.emailVerification.sendVerificationEmail({
      user: { email: 'a@b.com' }, url: 'https://verify',
    })
    expect(warned).toBe(false)
  })

  test('failure in production with SHOGO_LOG_EMAIL_VERIFICATION_URL=true: logs', async () => {
    emailState.verifyShouldFail = true
    process.env.NODE_ENV = 'production'
    process.env.SHOGO_LOG_EMAIL_VERIFICATION_URL = 'true'
    let warned = false
    console.warn = () => { warned = true }
    await capturedConfig.emailVerification.sendVerificationEmail({
      user: { email: 'a@b.com' }, url: 'https://verify',
    })
    expect(warned).toBe(true)
  })
})

// ===========================================================================
// databaseHooks.user.create.before (sanitize name)
// ===========================================================================

describe('databaseHooks.user.create.before', () => {
  test('sanitizes HTML in name', async () => {
    const u: { name?: string } = { name: '<script>alert(1)</script>Alice' }
    const out = await capturedConfig.databaseHooks.user.create.before(u)
    expect(out.data.name).toBe('alert(1)Alice')
  })

  test('passes through when name is empty', async () => {
    const u: { name?: string } = { name: '' }
    const out = await capturedConfig.databaseHooks.user.create.before(u)
    expect(out.data.name).toBe('')
  })

  test('passes through when name is undefined', async () => {
    const u: { name?: string } = {}
    const out = await capturedConfig.databaseHooks.user.create.before(u)
    expect(out.data.name).toBeUndefined()
  })
})

// ===========================================================================
// databaseHooks.user.update.before (sanitize name)
// ===========================================================================

describe('databaseHooks.user.update.before', () => {
  test('sanitizes HTML in name', async () => {
    const u: { name?: string } = { name: 'Hi<b>bold</b>' }
    const out = await capturedConfig.databaseHooks.user.update.before(u)
    expect(out.data.name).toBe('Hibold')
  })

  test('passes through when no name', async () => {
    const u: { name?: string } = {}
    const out = await capturedConfig.databaseHooks.user.update.before(u)
    expect(out.data.name).toBeUndefined()
  })
})

// ===========================================================================
// databaseHooks.user.create.after — biggest block (workspace + affiliate + email)
// ===========================================================================

describe('databaseHooks.user.create.after', () => {
  test('creates personal workspace + fires welcome email (success path)', async () => {
    await capturedConfig.databaseHooks.user.create.after(
      { id: 'u-1', email: 'a@b.com', name: 'Alice' },
      {},
    )
    expect(wsState.createCalls).toHaveLength(1)
    // Fire-and-forget welcome — give microtask queue a tick
    await new Promise(r => setTimeout(r, 10))
    expect(emailState.welcomeCalls).toBe(1)
  })

  test('retries workspace creation up to 5 attempts on failure', async () => {
    wsState.shouldFailTimes = 2
    await capturedConfig.databaseHooks.user.create.after(
      { id: 'u-2', email: 'b@b.com', name: 'Bob' }, {},
    )
    expect(wsState.createCalls.length).toBe(3) // 2 fails + 1 success
  })

  test('logs after 5 failed attempts (does not throw)', async () => {
    wsState.shouldFailTimes = 5
    // 1+2+3+4 = 10s of setTimeout retries between 5 attempts
    let errMsg = ''
    console.error = (m: string) => { errMsg = String(m) }
    await capturedConfig.databaseHooks.user.create.after(
      { id: 'u-3', email: 'c@c.com', name: 'Charlie' }, {},
    )
    expect(wsState.createCalls.length).toBe(5)
    expect(errMsg).toContain('Failed to create personal workspace')
  }, 20000)

  test('runs affiliate attribution when SHOGO_AFFILIATES_NATIVE=true + cookies present', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    const ctx = {
      request: { headers: {
        get: (k: string) => k === 'cookie' ? '__shogo_ref_visitor=v-abc; __shogo_ref=ref-99' : null,
      }},
    }
    await capturedConfig.databaseHooks.user.create.after(
      { id: 'u-aff', email: 'x@y.com', name: 'X' }, ctx,
    )
    expect(affState.calls).toHaveLength(1)
    expect(affState.calls[0]!.visitorId).toBe('v-abc')
    expect(affState.calls[0]!.code).toBe('ref-99')
  })

  test('falls back to ctx.headers.get when ctx.request is missing', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    const ctx = {
      headers: { get: (k: string) => k === 'cookie' ? '__shogo_ref_visitor=v2' : null },
    }
    await capturedConfig.databaseHooks.user.create.after(
      { id: 'u-aff2', email: 'a@b.com', name: 'A' }, ctx,
    )
    expect(affState.calls).toHaveLength(1)
    expect(affState.calls[0]!.code).toBeNull()
  })

  test('skips affiliate when no visitor cookie present', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    const ctx = { request: { headers: { get: () => '' } } }
    await capturedConfig.databaseHooks.user.create.after(
      { id: 'u', email: 'a@b.com', name: 'A' }, ctx,
    )
    expect(affState.calls).toHaveLength(0)
  })

  test('catches affiliate service errors (does not block workspace)', async () => {
    process.env.SHOGO_AFFILIATES_NATIVE = 'true'
    affState.shouldThrow = true
    const ctx = {
      request: { headers: {
        get: (k: string) => k === 'cookie' ? '__shogo_ref_visitor=v' : null,
      }},
    }
    let errLog = ''
    console.error = (m: string) => { errLog = String(m) }
    await capturedConfig.databaseHooks.user.create.after(
      { id: 'u', email: 'a@b.com', name: 'A' }, ctx,
    )
    expect(errLog).toContain('[Affiliate]')
    expect(wsState.createCalls).toHaveLength(1)
  })

  test('skips affiliate when SHOGO_AFFILIATES_NATIVE is not set', async () => {
    delete process.env.SHOGO_AFFILIATES_NATIVE
    const ctx = {
      request: { headers: { get: () => '__shogo_ref_visitor=v' } },
    }
    await capturedConfig.databaseHooks.user.create.after(
      { id: 'u', email: 'a@b.com' }, ctx,
    )
    expect(affState.calls).toHaveLength(0)
  })

  test('falls back to name="User" when user.name is missing', async () => {
    await capturedConfig.databaseHooks.user.create.after(
      { id: 'u-nameless', email: 'n@n.com' }, {},
    )
    expect(wsState.createCalls[0]!.name).toBe('User')
  })

  test('welcome email failure is caught and logged (does not throw)', async () => {
    emailState.welcomeShouldThrow = true
    let errLogged = ''
    console.error = (m: string) => { errLogged = String(m) }
    await capturedConfig.databaseHooks.user.create.after(
      { id: 'u-em', email: 'e@e.com', name: 'E' }, {},
    )
    await new Promise(r => setTimeout(r, 10))
    expect(errLogged).toContain('Welcome email failed')
  })
})

// ===========================================================================
// PROJECT_AUTH_ALLOWLIST plugin (hooks.before + hooks.after)
// ===========================================================================

describe('project-auth-allowlist plugin', () => {
  // The plugin lives in capturedConfig.plugins -> shogo-project-auth-allowlist
  const findPlugin = () =>
    (capturedConfig.plugins as Array<{ id: string; hooks?: any }>).find(
      p => p.id === 'shogo-project-auth-allowlist',
    )

  test('plugin is registered', () => {
    expect(findPlugin()).toBeDefined()
  })

  test('before handler is no-op when no project-id header', async () => {
    const p = findPlugin()!
    const before = p.hooks.before[0]
    await before.handler({ path: '/sign-up/email', body: { email: 'a@b.com' }, headers: { get: () => null } })
    // No throw -> pass
  })

  test('before handler returns when email body is missing/non-string', async () => {
    const p = findPlugin()!
    const before = p.hooks.before[0]
    await before.handler({
      path: '/sign-up/email',
      body: {}, // no email
      headers: { get: (k: string) => k === 'x-shogo-project-id' ? 'proj-1' : null },
    })
    // No throw -> pass (lets better-auth produce canonical error)
  })

  test('before handler throws APIError when allowlist denies (custom_not_listed)', async () => {
    const p = findPlugin()!
    const before = p.hooks.before[0]
    allowState.verdict = { allowed: false, reason: 'custom_not_listed' }
    let caught: FakeAPIError | null = null
    try {
      await before.handler({
        path: '/sign-in/email',
        body: { email: 'a@b.com' },
        headers: { get: (k: string) => k === 'x-shogo-project-id' ? 'proj-1' : null },
      })
    } catch (e) { caught = e as FakeAPIError }
    expect(caught).toBeInstanceOf(FakeAPIError)
    expect((caught!.body as { code: string }).code).toBe('project_auth_not_allowed')
  })

  test('before handler throws with workspace_not_member message', async () => {
    const p = findPlugin()!
    allowState.verdict = { allowed: false, reason: 'workspace_not_member' }
    await expect(p.hooks.before[0].handler({
      path: '/sign-in/email',
      body: { email: 'a@b.com' },
      headers: { get: (k: string) => k === 'x-shogo-project-id' ? 'proj-1' : null },
    })).rejects.toThrow(/workspace members/)
  })

  test('before handler throws default denied message for unknown reason', async () => {
    const p = findPlugin()!
    allowState.verdict = { allowed: false }
    await expect(p.hooks.before[0].handler({
      path: '/sign-in/email',
      body: { email: 'a@b.com' },
      headers: { get: (k: string) => k === 'x-shogo-project-id' ? 'proj-1' : null },
    })).rejects.toThrow(/Not allowed/)
  })

  test('before handler does nothing when allowlist passes', async () => {
    const p = findPlugin()!
    allowState.verdict = { allowed: true }
    await p.hooks.before[0].handler({
      path: '/sign-in/email',
      body: { email: 'a@b.com' },
      headers: { get: (k: string) => k === 'x-shogo-project-id' ? 'proj-1' : null },
    })
    // No throw -> pass
  })

  test('after handler records sign-in when newSession.user.id present', async () => {
    const p = findPlugin()!
    await p.hooks.after[0].handler({
      path: '/sign-in/email',
      context: { newSession: { user: { id: 'u-42' } } },
      headers: { get: (k: string) => k === 'x-shogo-project-id' ? 'proj-1' : null },
    })
    expect(allowState.recordCalls).toEqual([{ projectId: 'proj-1', userId: 'u-42' }])
  })

  test('after handler skips when no project header', async () => {
    const p = findPlugin()!
    await p.hooks.after[0].handler({
      path: '/sign-in/email',
      context: { newSession: { user: { id: 'u-42' } } },
      headers: { get: () => null },
    })
    expect(allowState.recordCalls).toHaveLength(0)
  })

  test('after handler skips when no newSession.user.id', async () => {
    const p = findPlugin()!
    await p.hooks.after[0].handler({
      path: '/sign-in/email',
      context: { newSession: {} },
      headers: { get: (k: string) => k === 'x-shogo-project-id' ? 'proj-1' : null },
    })
    expect(allowState.recordCalls).toHaveLength(0)
  })

  test('after handler swallows recordSignIn failures (logs error)', async () => {
    const p = findPlugin()!
    allowState.recordShouldThrow = true
    let errLog = ''
    console.error = (...args: unknown[]) => { errLog = args.map(String).join(' ') }
    await p.hooks.after[0].handler({
      path: '/sign-in/email',
      context: { newSession: { user: { id: 'u-x' } } },
      headers: { get: (k: string) => k === 'x-shogo-project-id' ? 'proj-1' : null },
    })
    expect(errLog).toContain('recordSignIn failed')
  })
})
