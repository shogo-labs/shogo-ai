// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/routes/cli-auth.ts — device-code login flow used by
 * BOTH the Shogo desktop app and the `shogo login` CLI.
 *
 * The route uses an in-memory `pendingStates` Map keyed by a 16-byte
 * hex state nonce. The module exposes a `_testing` seam so we can
 * clear it between tests + verify side effects directly. We mock:
 *
 *  - ../lib/prisma (member.findFirst, workspace.findUnique,
 *    user.findUnique)
 *  - ../lib/cloud-urls.getFrontendUrl
 *  - ../lib/api-keys-mint.mintDeviceApiKey
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

// ─── mocks ────────────────────────────────────────────────────────────────

const memberFindFirst = mock(async (_: any): Promise<any> => null)
const workspaceFindUnique = mock(async (_: any): Promise<any> => null)
const userFindUnique = mock(async (_: any): Promise<any> => null)

mock.module('../lib/prisma', () => ({
  prisma: {
    member: { findFirst: memberFindFirst },
    workspace: { findUnique: workspaceFindUnique },
    user: { findUnique: userFindUnique },
  },
  SubscriptionStatus: {
    active: 'active',
    past_due: 'past_due',
    canceled: 'canceled',
    incomplete: 'incomplete',
    incomplete_expired: 'incomplete_expired',
    trialing: 'trialing',
    unpaid: 'unpaid',
    paused: 'paused',
  },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

const getFrontendUrlMock = mock(() => 'https://app.shogo.dev/')
mock.module('../lib/cloud-urls', () => ({
  getFrontendUrl: getFrontendUrlMock,
}))

const mintDeviceApiKeyMock = mock(async (_: any) => ({
  fullKey: 'shogo_sk_DEVICE_MINTED',
  keyPrefix: 'shogo_sk_DEVICE_',
  apiKey: { id: 'apikey-1' },
}))
mock.module('../lib/api-keys-mint', () => ({
  mintDeviceApiKey: mintDeviceApiKeyMock,
  // Stub the rest of the module's exports so sibling test files that
  // import from `../lib/api-keys-mint` (e.g. api-keys-route.test.ts →
  // generateApiKey / hashApiKey) don't blow up under bun's cross-file
  // `mock.module` interception.
  generateApiKey: async () => ({ fullKey: 'stub', keyHash: 'stub', keyPrefix: 'stub' }),
  hashApiKey: async (k: string) => `hash::${k}`,
  SHOGO_API_KEY_PREFIX: 'shogo_sk_',
}))

// Wrap pending-login-store so individual tests can neutralize
// purgeExpiredStates() and reach the post-purge expired-record branches
// in poll + approve.  Re-exports everything else from the real module.
const realStore = await import('../lib/pending-login-store')
let purgeImpl: () => void = realStore.purgeExpiredStates
mock.module('../lib/pending-login-store', () => ({
  ...realStore,
  purgeExpiredStates: () => purgeImpl(),
}))

// Load AFTER mocks are registered.
const { cliAuthRoutes, _testing } = await import('../routes/cli-auth')

// ─── helpers ──────────────────────────────────────────────────────────────

function makeApp(auth?: { userId: string }) {
  const app = new Hono()
  if (auth) {
    app.use('*', async (c, next) => {
      c.set('auth', auth as any)
      await next()
    })
  }
  app.route('/api', cliAuthRoutes())
  return app
}

async function startSession(
  overrides: Record<string, unknown> = {},
): Promise<{ state: string; userCode: string; authUrl: string }> {
  const res = await makeApp().request('/api/cli/login/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'desk-uuid-1234', ...overrides }),
  })
  const body = await res.json()
  return body
}

const ANY_DEVICE = { deviceId: 'desk-uuid-1234' }

beforeEach(() => {
  _testing.pendingStates.clear()

  memberFindFirst.mockReset()
  memberFindFirst.mockImplementation(async () => ({
    id: 'mem-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
  }))
  workspaceFindUnique.mockReset()
  workspaceFindUnique.mockImplementation(async () => ({
    name: 'Personal',
    slug: 'personal',
  }))
  userFindUnique.mockReset()
  userFindUnique.mockImplementation(async () => ({ email: 'anya@example.com' }))

  getFrontendUrlMock.mockReset()
  getFrontendUrlMock.mockImplementation(() => 'https://app.shogo.dev/')

  mintDeviceApiKeyMock.mockReset()
  mintDeviceApiKeyMock.mockImplementation(async () => ({
    fullKey: 'shogo_sk_DEVICE_MINTED',
    keyPrefix: 'shogo_sk_DEVICE_',
    apiKey: { id: 'apikey-1' },
  }))
})

// ─── POST /cli/login/start ────────────────────────────────────────────────

describe('POST /cli/login/start', () => {
  test('400 when deviceId is missing', async () => {
    const res = await makeApp().request('/api/cli/login/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('deviceId is required')
  })

  test('400 when deviceId is shorter than 8 chars (length-strict pin)', async () => {
    const res = await makeApp().request('/api/cli/login/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'short' }),
    })
    expect(res.status).toBe(400)
  })

  test('400 when deviceId is not a string', async () => {
    const res = await makeApp().request('/api/cli/login/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 99999999 }),
    })
    expect(res.status).toBe(400)
  })

  test('400 when JSON body is malformed (catches parse and falls through)', async () => {
    const res = await makeApp().request('/api/cli/login/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  test('happy path returns { ok, state, userCode, authUrl, expiresInMs, pollIntervalMs }', async () => {
    const res = await makeApp().request('/api/cli/login/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ANY_DEVICE),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.state).toMatch(/^[0-9a-f]{32}$/) // 16 bytes → 32 hex chars
    expect(body.userCode).toBe(body.state.slice(-6).toUpperCase())
    expect(body.userCode).toMatch(/^[0-9A-F]{6}$/)
    expect(body.expiresInMs).toBe(5 * 60 * 1000)
    expect(body.pollIntervalMs).toBe(2_000)
  })

  test('authUrl points at /auth/cli-link on the frontend URL and carries the state, userCode, deviceId, client', async () => {
    getFrontendUrlMock.mockImplementation(() => 'https://app.shogo.dev/')
    const { state, authUrl, userCode } = await startSession({ client: 'cli' })
    const url = new URL(authUrl)
    expect(url.origin).toBe('https://app.shogo.dev')
    expect(url.pathname).toBe('/auth/cli-link')
    expect(url.searchParams.get('state')).toBe(state)
    expect(url.searchParams.get('userCode')).toBe(userCode)
    expect(url.searchParams.get('deviceId')).toBe('desk-uuid-1234')
    expect(url.searchParams.get('client')).toBe('cli')
  })

  test('strips a trailing slash from getFrontendUrl() so authUrl never has // before /auth', async () => {
    getFrontendUrlMock.mockImplementation(() => 'https://app.shogo.dev/')
    const { authUrl } = await startSession()
    expect(authUrl).toContain('https://app.shogo.dev/auth/cli-link?')
    expect(authUrl).not.toContain('shogo.dev//auth')
  })

  test('client defaults to "cli" when not specified', async () => {
    const { authUrl } = await startSession()
    expect(new URL(authUrl).searchParams.get('client')).toBe('cli')
  })

  test('client="desktop" is accepted and persisted', async () => {
    const { authUrl, state } = await startSession({ client: 'desktop' })
    expect(new URL(authUrl).searchParams.get('client')).toBe('desktop')
    expect(_testing.pendingStates.get(state)!.client).toBe('desktop')
  })

  test('any non-"desktop" client value falls back to "cli"', async () => {
    const { authUrl } = await startSession({ client: 'browser-extension' as any })
    expect(new URL(authUrl).searchParams.get('client')).toBe('cli')
  })

  test('deviceName defaults to "Shogo CLI" for cli, "Shogo Desktop" for desktop', async () => {
    const { state: cliState } = await startSession({ client: 'cli' })
    expect(_testing.pendingStates.get(cliState)!.deviceName).toBe('Shogo CLI')

    const { state: deskState } = await startSession({ client: 'desktop' })
    expect(_testing.pendingStates.get(deskState)!.deviceName).toBe('Shogo Desktop')
  })

  test('explicit deviceName is preserved AND added to authUrl when given', async () => {
    const { authUrl, state } = await startSession({ deviceName: 'Anya MacBook Pro' })
    expect(new URL(authUrl).searchParams.get('deviceName')).toBe('Anya MacBook Pro')
    expect(_testing.pendingStates.get(state)!.deviceName).toBe('Anya MacBook Pro')
  })

  test('deviceName is clamped to 120 chars', async () => {
    const { state } = await startSession({ deviceName: 'A'.repeat(200) })
    expect(_testing.pendingStates.get(state)!.deviceName.length).toBe(120)
  })

  test('devicePlatform and deviceAppVersion are clamped to 32 chars', async () => {
    const { state } = await startSession({
      devicePlatform: 'p'.repeat(50),
      deviceAppVersion: 'v'.repeat(50),
    })
    const r = _testing.pendingStates.get(state)!
    expect(r.devicePlatform?.length).toBe(32)
    expect(r.deviceAppVersion?.length).toBe(32)
  })

  test('preselected workspaceId is forwarded in authUrl AND persisted', async () => {
    const { authUrl, state } = await startSession({ workspaceId: 'ws-7' })
    expect(new URL(authUrl).searchParams.get('workspaceId')).toBe('ws-7')
    expect(_testing.pendingStates.get(state)!.preselectedWorkspaceId).toBe('ws-7')
  })

  test('empty-string workspaceId is treated as "not preselected"', async () => {
    const { state } = await startSession({ workspaceId: '' })
    expect(_testing.pendingStates.get(state)!.preselectedWorkspaceId).toBeUndefined()
  })

  test('two consecutive calls produce distinct state nonces', async () => {
    const a = await startSession()
    const b = await startSession()
    expect(a.state).not.toBe(b.state)
  })

  test('state nonce is high-entropy (last 6 chars vary across many calls)', async () => {
    const userCodes = new Set<string>()
    for (let i = 0; i < 20; i++) {
      userCodes.add((await startSession()).userCode)
    }
    expect(userCodes.size).toBeGreaterThan(15) // overwhelmingly unique
  })

  test('expiresAt is ~5min in the future', async () => {
    const before = Date.now()
    const { state } = await startSession()
    const after = Date.now()
    const rec = _testing.pendingStates.get(state)!
    expect(rec.expiresAt).toBeGreaterThanOrEqual(before + 5 * 60 * 1000 - 50)
    expect(rec.expiresAt).toBeLessThanOrEqual(after + 5 * 60 * 1000 + 50)
  })
})

// ─── GET /cli/login/poll ──────────────────────────────────────────────────

describe('GET /cli/login/poll', () => {
  test('400 when state query param missing', async () => {
    const res = await makeApp().request('/api/cli/login/poll')
    expect(res.status).toBe(400)
  })

  test('returns "expired" when state is unknown', async () => {
    const res = await makeApp().request('/api/cli/login/poll?state=ffffffff')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'expired' })
  })

  test('returns "pending" while record is in flight', async () => {
    const { state } = await startSession()
    const res = await makeApp().request(`/api/cli/login/poll?state=${state}`)
    expect(await res.json()).toEqual({ ok: true, status: 'pending' })
  })

  test('returns "expired" AND deletes the record when expiresAt has passed', async () => {
    const { state } = await startSession()
    // Force expiry in the past.
    _testing.pendingStates.get(state)!.expiresAt = Date.now() - 1000
    const res = await makeApp().request(`/api/cli/login/poll?state=${state}`)
    expect(await res.json()).toEqual({ ok: true, status: 'expired' })
    expect(_testing.pendingStates.has(state)).toBe(false)
  })

  test('returns "expired" via the record.expiresAt branch when purge is suppressed (lines 160-161)', async () => {
    // Reach the post-purge expired-check by neutralizing purgeExpiredStates.
    const savedPurge = purgeImpl
    purgeImpl = () => {}
    try {
      const { state } = await startSession()
      _testing.pendingStates.get(state)!.expiresAt = Date.now() - 1000
      const res = await makeApp().request(`/api/cli/login/poll?state=${state}`)
      expect(await res.json()).toEqual({ ok: true, status: 'expired' })
      expect(_testing.pendingStates.has(state)).toBe(false)
    } finally {
      purgeImpl = savedPurge
    }
  })

  test('returns "denied" AND deletes the record when status is denied', async () => {
    const { state } = await startSession()
    _testing.pendingStates.get(state)!.status = 'denied'
    const res = await makeApp().request(`/api/cli/login/poll?state=${state}`)
    expect(await res.json()).toEqual({ ok: true, status: 'denied' })
    expect(_testing.pendingStates.has(state)).toBe(false)
  })

  test('approved + mintedKey: returns key + email + workspace + deviceId, then BURNS the record', async () => {
    const { state } = await startSession()
    const rec = _testing.pendingStates.get(state)!
    rec.status = 'approved'
    rec.mintedKey = 'shogo_sk_TEST'
    rec.email = 'anya@example.com'
    rec.workspace = 'Personal'

    const res = await makeApp().request(`/api/cli/login/poll?state=${state}`)
    expect(await res.json()).toEqual({
      ok: true,
      status: 'approved',
      key: 'shogo_sk_TEST',
      email: 'anya@example.com',
      workspace: 'Personal',
      deviceId: 'desk-uuid-1234',
    })
    // SINGLE-USE: subsequent poll must not return the key again.
    expect(_testing.pendingStates.has(state)).toBe(false)
    const second = await makeApp().request(`/api/cli/login/poll?state=${state}`)
    expect((await second.json()).status).toBe('expired')
  })

  test('approved WITHOUT mintedKey is treated as "pending" (key not yet minted)', async () => {
    const { state } = await startSession()
    const rec = _testing.pendingStates.get(state)!
    rec.status = 'approved'
    rec.mintedKey = undefined
    const res = await makeApp().request(`/api/cli/login/poll?state=${state}`)
    expect((await res.json()).status).toBe('pending')
    expect(_testing.pendingStates.has(state)).toBe(true) // not deleted
  })

  test('null email/workspace are surfaced as null (never undefined leaks)', async () => {
    const { state } = await startSession()
    const rec = _testing.pendingStates.get(state)!
    rec.status = 'approved'
    rec.mintedKey = 'k'
    rec.email = null
    rec.workspace = null
    const body = await (await makeApp().request(`/api/cli/login/poll?state=${state}`)).json()
    expect(body.email).toBeNull()
    expect(body.workspace).toBeNull()
  })
})

// ─── GET /cli/login/state ────────────────────────────────────────────────

describe('GET /cli/login/state', () => {
  test('400 when no state', async () => {
    const res = await makeApp().request('/api/cli/login/state')
    expect(res.status).toBe(400)
  })

  test('404 when unknown state', async () => {
    const res = await makeApp().request('/api/cli/login/state?state=zz')
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('expired')
  })

  test('404 when state has expired', async () => {
    const { state } = await startSession()
    _testing.pendingStates.get(state)!.expiresAt = Date.now() - 1
    const res = await makeApp().request(`/api/cli/login/state?state=${state}`)
    expect(res.status).toBe(404)
  })

  test('happy path: returns all metadata for bridge page rendering', async () => {
    const { state } = await startSession({
      client: 'desktop',
      deviceName: 'Anya MacBook',
      devicePlatform: 'darwin-arm64',
      deviceAppVersion: '1.2.3',
      workspaceId: 'ws-team',
    })
    const res = await makeApp().request(`/api/cli/login/state?state=${state}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      ok: true,
      status: 'pending',
      userCode: state.slice(-6).toUpperCase(),
      client: 'desktop',
      deviceId: 'desk-uuid-1234',
      deviceName: 'Anya MacBook',
      devicePlatform: 'darwin-arm64',
      deviceAppVersion: '1.2.3',
      preselectedWorkspaceId: 'ws-team',
    })
  })

  test('does NOT mint or delete on read (idempotent)', async () => {
    const { state } = await startSession()
    await makeApp().request(`/api/cli/login/state?state=${state}`)
    await makeApp().request(`/api/cli/login/state?state=${state}`)
    expect(_testing.pendingStates.has(state)).toBe(true)
    expect(mintDeviceApiKeyMock).not.toHaveBeenCalled()
  })
})

// ─── POST /cli/login/approve ──────────────────────────────────────────────

describe('POST /cli/login/approve', () => {
  test('400 when JSON body is malformed (catches parse, falls through to validation)', async () => {
    const res = await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    // Missing state in the (empty object) fallback → 400.
    expect(res.status).toBe(400)
  })

  test('401 when no auth context', async () => {
    const { state } = await startSession()
    const res = await makeApp().request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    expect(res.status).toBe(401)
    expect(mintDeviceApiKeyMock).not.toHaveBeenCalled()
  })

  test('400 when state missing', async () => {
    const res = await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('400 when state is not a string', async () => {
    const res = await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 12345 }),
    })
    expect(res.status).toBe(400)
  })

  test('404 when state is unknown', async () => {
    const res = await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'definitely-not-a-real-state' }),
    })
    expect(res.status).toBe(404)
  })

  test('expired state is purged at handler entry → returns 404 (indistinguishable from unknown)', async () => {
    // Handler's first line is `purgeExpiredStates()`, so by the time
    // it looks the state up, it has already been deleted. The result
    // is indistinguishable from "unknown state" — by design (same
    // user-visible remediation: "start over").
    const { state } = await startSession()
    _testing.pendingStates.get(state)!.expiresAt = Date.now() - 1
    const res = await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    expect(res.status).toBe(404)
    expect(_testing.pendingStates.has(state)).toBe(false)
    expect(mintDeviceApiKeyMock).not.toHaveBeenCalled()
  })

  test('returns 410 via record.expiresAt branch when purge is suppressed (lines 232-233)', async () => {
    // Reach the post-purge expired-check inside POST /approve by
    // neutralizing purgeExpiredStates. Mirrors the poll-handler test
    // for lines 160-161.
    const savedPurge = purgeImpl
    purgeImpl = () => {}
    try {
      const { state } = await startSession()
      _testing.pendingStates.get(state)!.expiresAt = Date.now() - 1
      const res = await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state }),
      })
      expect(res.status).toBe(410)
      const body = await res.json()
      expect(body.ok).toBe(false)
      expect(body.error).toMatch(/expired/i)
      expect(_testing.pendingStates.has(state)).toBe(false)
      expect(mintDeviceApiKeyMock).not.toHaveBeenCalled()
    } finally {
      purgeImpl = savedPurge
    }
  })

  test('200 + alreadyApproved: when state is already approved (idempotent re-tap)', async () => {
    const { state } = await startSession()
    _testing.pendingStates.get(state)!.status = 'approved'
    const res = await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, alreadyApproved: true })
    expect(mintDeviceApiKeyMock).not.toHaveBeenCalled()
  })

  test('410 when state has been denied', async () => {
    const { state } = await startSession()
    _testing.pendingStates.get(state)!.status = 'denied'
    const res = await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    expect(res.status).toBe(410)
  })

  test('403 when explicit body.workspaceId and the user is not a member', async () => {
    memberFindFirst.mockImplementation(async () => null)
    const { state } = await startSession()
    const res = await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, workspaceId: 'ws-OTHER' }),
    })
    expect(res.status).toBe(403)
    expect(mintDeviceApiKeyMock).not.toHaveBeenCalled()
    // No state-status mutation on the failed approval.
    expect(_testing.pendingStates.get(state)!.status).toBe('pending')
  })

  test('404 when no workspaceId and the user has no memberships', async () => {
    memberFindFirst.mockImplementation(async () => null)
    const { state } = await startSession() // no preselect
    const res = await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    expect(res.status).toBe(404)
  })

  test('happy path with explicit workspaceId: mints + flips state to approved + stores mintedKey', async () => {
    const { state } = await startSession({ deviceName: 'Anya Mac' })
    const res = await makeApp({ userId: 'user-A' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, workspaceId: 'ws-1' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      ok: true,
      keyPrefix: 'shogo_sk_DEVICE_',
      apiKeyId: 'apikey-1',
      workspace: 'Personal',
      email: 'anya@example.com',
    })

    expect(mintDeviceApiKeyMock).toHaveBeenCalledTimes(1)
    const args = mintDeviceApiKeyMock.mock.calls[0][0]
    expect(args).toMatchObject({
      workspaceId: 'ws-1',
      userId: 'user-A',
      deviceId: 'desk-uuid-1234',
      deviceName: 'Anya Mac',
      defaultDeviceName: 'Shogo CLI',
    })

    const rec = _testing.pendingStates.get(state)!
    expect(rec.status).toBe('approved')
    expect(rec.mintedKey).toBe('shogo_sk_DEVICE_MINTED') // plaintext lives in memory until poll picks it up
    expect(rec.email).toBe('anya@example.com')
    expect(rec.workspace).toBe('Personal')
    expect(rec.approvedAt).toBeGreaterThan(0)
  })

  test('approval response NEVER contains the full key (key is delivered ONLY via /poll)', async () => {
    const { state } = await startSession()
    const res = await makeApp({ userId: 'user-A' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, workspaceId: 'ws-1' }),
    })
    const body = await res.json()
    expect(body.key).toBeUndefined()
    expect(body.fullKey).toBeUndefined()
    // The prefix IS surfaced — that's safe to display.
    expect(body.keyPrefix).toBe('shogo_sk_DEVICE_')
  })

  test('desktop client → defaultDeviceName "Shogo Desktop"; cli client → "Shogo CLI"', async () => {
    const { state: cliS } = await startSession({ client: 'cli' })
    await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: cliS, workspaceId: 'ws-1' }),
    })
    expect(mintDeviceApiKeyMock.mock.calls[0][0].defaultDeviceName).toBe('Shogo CLI')

    mintDeviceApiKeyMock.mockClear()
    const { state: dS } = await startSession({ client: 'desktop' })
    await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: dS, workspaceId: 'ws-1' }),
    })
    expect(mintDeviceApiKeyMock.mock.calls[0][0].defaultDeviceName).toBe('Shogo Desktop')
  })

  test('falls back to preselectedWorkspaceId when body.workspaceId not provided', async () => {
    const { state } = await startSession({ workspaceId: 'ws-pre' })
    await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    expect(mintDeviceApiKeyMock.mock.calls[0][0].workspaceId).toBe('ws-pre')
    expect(memberFindFirst.mock.calls[0][0].where).toEqual({
      userId: 'u',
      workspaceId: 'ws-pre',
    })
  })

  test('falls back to earliest membership when no workspaceId anywhere', async () => {
    memberFindFirst.mockImplementation(async (args: any) => {
      if (args.orderBy) return { workspaceId: 'ws-earliest' }
      return null
    })
    const { state } = await startSession()
    await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    expect(mintDeviceApiKeyMock.mock.calls[0][0].workspaceId).toBe('ws-earliest')
    // Earliest = orderBy createdAt asc pinned.
    const orderByCall = memberFindFirst.mock.calls.find((c: any) => c[0]?.orderBy)
    expect(orderByCall![0].orderBy).toEqual({ createdAt: 'asc' })
  })

  test('after approval, record.expiresAt is shortened to <=60s out (CLI-handoff window)', async () => {
    const { state } = await startSession()
    const before = Date.now()
    await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, workspaceId: 'ws-1' }),
    })
    const rec = _testing.pendingStates.get(state)!
    expect(rec.expiresAt).toBeLessThanOrEqual(before + 60_000 + 50)
  })

  test('null email + null workspace are surfaced as null', async () => {
    workspaceFindUnique.mockImplementation(async () => null)
    userFindUnique.mockImplementation(async () => null)
    const { state } = await startSession()
    const res = await makeApp({ userId: 'u' }).request('/api/cli/login/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, workspaceId: 'ws-1' }),
    })
    expect(await res.json()).toMatchObject({ workspace: null, email: null })
    const rec = _testing.pendingStates.get(state)!
    expect(rec.email).toBeNull()
    expect(rec.workspace).toBeNull()
  })
})

// ─── POST /cli/login/deny ────────────────────────────────────────────────

describe('POST /cli/login/deny', () => {
  test('400 when JSON body is malformed (catches parse, falls through to validation)', async () => {
    const res = await makeApp({ userId: 'u' }).request('/api/cli/login/deny', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  test('401 when no auth context (deny must be authed to prevent griefing)', async () => {
    const { state } = await startSession()
    const res = await makeApp().request('/api/cli/login/deny', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    expect(res.status).toBe(401)
    expect(_testing.pendingStates.get(state)!.status).toBe('pending') // unaffected
  })

  test('400 when state missing', async () => {
    const res = await makeApp({ userId: 'u' }).request('/api/cli/login/deny', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('200 silently when state is unknown (no enumeration oracle)', async () => {
    const res = await makeApp({ userId: 'u' }).request('/api/cli/login/deny', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'totally-unknown' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('flips pending → denied AND shortens expiresAt to <=30s out', async () => {
    const { state } = await startSession()
    const before = Date.now()
    const res = await makeApp({ userId: 'u' }).request('/api/cli/login/deny', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    expect(res.status).toBe(200)
    const rec = _testing.pendingStates.get(state)!
    expect(rec.status).toBe('denied')
    expect(rec.expiresAt).toBeLessThanOrEqual(before + 30_000 + 50)
  })

  test('does NOT downgrade an already-approved record (only pending → denied)', async () => {
    const { state } = await startSession()
    _testing.pendingStates.get(state)!.status = 'approved'
    await makeApp({ userId: 'u' }).request('/api/cli/login/deny', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    expect(_testing.pendingStates.get(state)!.status).toBe('approved')
  })
})

// ─── purgeExpiredStates ──────────────────────────────────────────────────

describe('purgeExpiredStates (background sweep)', () => {
  test('removes only states whose expiresAt has passed', () => {
    _testing.pendingStates.set('alive', {
      status: 'pending',
      deviceId: 'd',
      deviceName: 'n',
      client: 'cli',
      expiresAt: Date.now() + 60_000,
    } as any)
    _testing.pendingStates.set('dead-1', {
      status: 'pending',
      deviceId: 'd',
      deviceName: 'n',
      client: 'cli',
      expiresAt: Date.now() - 1,
    } as any)
    _testing.pendingStates.set('dead-2', {
      status: 'approved',
      deviceId: 'd',
      deviceName: 'n',
      client: 'cli',
      expiresAt: Date.now() - 99999,
    } as any)

    _testing.purgeExpiredStates()

    expect(_testing.pendingStates.has('alive')).toBe(true)
    expect(_testing.pendingStates.has('dead-1')).toBe(false)
    expect(_testing.pendingStates.has('dead-2')).toBe(false)
  })

  test('start endpoint triggers purge', async () => {
    _testing.pendingStates.set('ghost', {
      status: 'pending',
      deviceId: 'd',
      deviceName: 'n',
      client: 'cli',
      expiresAt: Date.now() - 1,
    } as any)
    await startSession()
    expect(_testing.pendingStates.has('ghost')).toBe(false)
  })
})

// ─── end-to-end ──────────────────────────────────────────────────────────

describe('end-to-end: start → state → approve → poll → poll-again', () => {
  test('full happy path mints once, hands key off exactly once', async () => {
    // 1. start
    const { state, userCode } = await startSession({ client: 'desktop' })

    // 2. bridge reads metadata
    const metaRes = await makeApp().request(`/api/cli/login/state?state=${state}`)
    expect((await metaRes.json()).userCode).toBe(userCode)

    // 3. bridge approves (cookie-authed)
    const apRes = await makeApp({ userId: 'user-A' }).request(
      '/api/cli/login/approve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, workspaceId: 'ws-1' }),
      },
    )
    expect(apRes.status).toBe(200)
    expect((await apRes.json()).keyPrefix).toBe('shogo_sk_DEVICE_')

    // 4. CLI polls → gets the key once
    const pollRes = await makeApp().request(`/api/cli/login/poll?state=${state}`)
    const pollBody = await pollRes.json()
    expect(pollBody.status).toBe('approved')
    expect(pollBody.key).toBe('shogo_sk_DEVICE_MINTED')

    // 5. CLI polls AGAIN → record is gone, no second-use of the key
    const pollRes2 = await makeApp().request(`/api/cli/login/poll?state=${state}`)
    expect((await pollRes2.json()).status).toBe('expired')

    // Mint must have happened exactly once.
    expect(mintDeviceApiKeyMock).toHaveBeenCalledTimes(1)
  })
})
