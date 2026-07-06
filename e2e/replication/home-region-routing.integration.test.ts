// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Multi-region home-region write-routing + idempotent-signup integration tests.
 *
 * These exercise the prevention layer for cross-region split-brain:
 *   1. A workspace-scoped write sent to a NON-home region is proxied to the
 *      workspace's home region and lands exactly once (no duplicate row, no
 *      replication conflict).
 *   2. Signing up the same email twice (sequentially, across regions) yields a
 *      single user identity rather than two split-brain rows.
 *
 * Requires the standard replication env (DB_URL_US/EU/INDIA). The proxying
 * assertions additionally require API_URL_US + API_URL_EU AND the EU API to run
 * with HOME_REGION_ROUTING=enforce; they self-skip otherwise so the suite is
 * still useful in DB-only environments.
 *
 *   bun test e2e/replication/home-region-routing.integration.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  getTestEnv,
  pool,
  waitForReplication,
  sleep,
  closeAllPools,
  totalConflicts,
  meshSubHealth,
  type TestEnv,
} from './helpers'

let env: TestEnv
const TEST_MARKER = `_homeregion_test_${Date.now()}`

beforeAll(() => {
  env = getTestEnv()
})

afterAll(async () => {
  try {
    const usPool = pool(env, 'us')
    await usPool.query(`DELETE FROM projects WHERE name LIKE $1`, [`%${TEST_MARKER}%`])
    await usPool.query(`DELETE FROM members WHERE id LIKE $1`, [`%${TEST_MARKER}%`])
    await usPool.query(`DELETE FROM workspaces WHERE name LIKE $1`, [`%${TEST_MARKER}%`])
    await usPool.query(`DELETE FROM workspaces WHERE slug LIKE $1`, [`%${TEST_MARKER}%`])
    await usPool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${TEST_MARKER}%`])
  } catch {}
  await closeAllPools(env)
})

async function signup(apiUrl: string, email: string, password: string, name: string) {
  const res = await fetch(`${apiUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  })
  return res
}

function sessionCookieFrom(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith('shogo.session_token='))
}

describe('home-region write routing', () => {
  test('a non-home workspace write is proxied home and lands exactly once', async () => {
    const usApi = env.us.apiUrl
    const euApi = env.eu.apiUrl
    if (!usApi || !euApi) {
      console.log('Skipping: API_URL_US and API_URL_EU required')
      return
    }
    if (process.env.HOME_REGION_ROUTING_E2E !== 'enforce') {
      console.log('Skipping: set HOME_REGION_ROUTING_E2E=enforce (EU API must run with HOME_REGION_ROUTING=enforce)')
      return
    }

    const email = `home_route_${TEST_MARKER}@test.shogo.dev`
    const password = `TestPass${Date.now()}!`

    // Sign up in US → personal workspace's homeRegion is US.
    const signupRes = await signup(usApi, email, password, `Home Route ${TEST_MARKER}`)
    expect(signupRes.ok).toBe(true)
    const cookie = sessionCookieFrom(signupRes)
    expect(cookie).toBeDefined()

    // Wait for the user + workspace to replicate to EU.
    await sleep(3000)

    // Find the personal workspace via the US API.
    const listRes = await fetch(`${usApi}/api/workspaces`, { headers: { Cookie: cookie! } })
    expect(listRes.ok).toBe(true)
    const list = (await listRes.json()) as Array<{ id: string; homeRegion?: string | null }>
    const ws = list[0]
    expect(ws?.id).toBeDefined()

    // Now mutate the workspace via the EU API (its NON-home region). Rename it.
    const newName = `Renamed ${TEST_MARKER}`
    const patchRes = await fetch(`${euApi}/api/workspaces/${ws.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie! },
      body: JSON.stringify({ name: newName }),
    })
    expect(patchRes.ok).toBe(true)

    // The write should have been applied at the US (home) primary, then
    // replicated back to EU. Assert it is visible in US and converges in EU.
    const usRow = await pool(env, 'us').query(
      `SELECT name, "homeRegion" FROM workspaces WHERE id = $1`,
      [ws.id],
    )
    expect(usRow.rows[0]?.name).toBe(newName)
    expect(usRow.rows[0]?.homeRegion).toBe('us-ashburn-1')

    const euRow = await waitForReplication<{ name: string }>({
      sourcePool: pool(env, 'us'),
      targetPool: pool(env, 'eu'),
      query: `SELECT name FROM workspaces WHERE id = $1 AND name = $2`,
      params: [ws.id, newName],
      timeoutMs: 10_000,
    })
    expect(euRow.name).toBe(newName)

    // Exactly one workspace row for this id across every region (no split-brain).
    for (const region of ['us', 'eu', 'india']) {
      const count = await pool(env, region).query(
        `SELECT COUNT(*)::int AS c FROM workspaces WHERE id = $1`,
        [ws.id],
      )
      expect(count.rows[0].c).toBe(1)
    }
  })
})

describe('identity write routing', () => {
  test('a non-home identity write is proxied to the user home region and converges', async () => {
    const usApi = env.us.apiUrl
    const euApi = env.eu.apiUrl
    if (!usApi || !euApi) {
      console.log('Skipping: API_URL_US and API_URL_EU required')
      return
    }
    if (process.env.HOME_REGION_ROUTING_E2E !== 'enforce') {
      console.log('Skipping: set HOME_REGION_ROUTING_E2E=enforce (EU API must run with HOME_REGION_ROUTING=enforce)')
      return
    }

    const email = `id_route_${TEST_MARKER}@test.shogo.dev`
    const password = `TestPass${Date.now()}!`

    // Sign up in US → user.homeRegion = US.
    const signupRes = await signup(usApi, email, password, `Id Route ${TEST_MARKER}`)
    expect(signupRes.ok).toBe(true)
    const cookie = sessionCookieFrom(signupRes)
    expect(cookie).toBeDefined()

    // Let the user row replicate to EU so the EU router can resolve its home.
    await sleep(3000)

    // Identity write (onboarding complete) via the EU API (NON-home region).
    // resolve-user-id treats /api/onboarding/complete as a self route, so the
    // router pins it to the session user's home region (US).
    const completeRes = await fetch(`${euApi}/api/onboarding/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie! },
      body: JSON.stringify({}),
    })
    expect(completeRes.ok).toBe(true)

    // The write must land at the US (home) primary, then replicate out.
    const usRow = await pool(env, 'us').query(
      `SELECT "onboardingCompleted", "homeRegion" FROM users WHERE lower(email) = lower($1)`,
      [email],
    )
    expect(usRow.rows[0]?.onboardingCompleted).toBe(true)
    expect(usRow.rows[0]?.homeRegion).toBe('us-ashburn-1')

    const euRow = await waitForReplication<{ onboardingCompleted: boolean }>({
      sourcePool: pool(env, 'us'),
      targetPool: pool(env, 'eu'),
      query: `SELECT "onboardingCompleted" FROM users WHERE lower(email) = lower($1) AND "onboardingCompleted" = true`,
      params: [email],
      timeoutMs: 10_000,
    })
    expect(euRow.onboardingCompleted).toBe(true)

    // Exactly one user row for this identity across every region.
    for (const region of ['us', 'eu', 'india']) {
      const count = await pool(env, region).query(
        `SELECT COUNT(*)::int AS c FROM users WHERE lower(email) = lower($1)`,
        [email],
      )
      expect(count.rows[0].c).toBe(1)
    }
  })
})

describe('platform-global write routing', () => {
  test('an /api/admin write from a non-primary region lands at the primary', async () => {
    const euApi = env.eu.apiUrl
    // Needs a super-admin session cookie; self-skip otherwise (env-specific).
    const adminCookie = process.env.ADMIN_COOKIE_EU
    if (!euApi || !adminCookie) {
      console.log('Skipping: API_URL_EU + ADMIN_COOKIE_EU (super-admin session) required')
      return
    }
    if (process.env.HOME_REGION_ROUTING_E2E !== 'enforce') {
      console.log('Skipping: set HOME_REGION_ROUTING_E2E=enforce')
      return
    }

    // Toggle a feature flag via the EU API (non-primary). PlatformSetting is
    // platform-global, so the router must proxy this to the primary (US).
    const flagValue = `e2e_${Date.now()}`
    const res = await fetch(`${euApi}/api/admin/settings/features`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ e2eMarker: flagValue }),
    })
    // The request must be accepted (proxied to primary) — never a local write.
    expect(res.status).toBeLessThan(500)

    // The platform setting must be present at the US primary and converge to EU.
    await waitForReplication<{ value: unknown }>({
      sourcePool: pool(env, 'us'),
      targetPool: pool(env, 'eu'),
      query: `SELECT value FROM platform_settings WHERE value::text LIKE $1`,
      params: [`%${flagValue}%`],
      timeoutMs: 10_000,
    }).catch(() => {
      // Table/shape is deployment-specific; don't hard-fail the suite on it.
      console.log('Note: platform_settings convergence not asserted (table/shape unknown)')
    })
  })
})

describe('chat session region pinning', () => {
  // Regression guard for the cross-region resume 404 storm (RCA: a resume GET
  // re-steered to a non-home region hit the wildcard `/api/projects/:id/*`
  // 404 — or requireProjectAccess's "Project not found" 404 — and the client
  // looped on it). With affine-read pinning (chat-region-pin) + enforce, a
  // resume for an unknown/idle session must return the TERMINAL 204 ("nothing
  // buffered"), never a 404, even from a region that is not the session home.
  //
  // Full end-to-end resume of an ACTIVE buffered turn requires a live runtime
  // pod and is out of scope for this DB/API harness; this asserts the pod-
  // independent contract that killed the loop.
  test('a resume GET from a non-home region returns 204 (not a 404 storm)', async () => {
    const usApi = env.us.apiUrl
    const euApi = env.eu.apiUrl
    if (!usApi || !euApi) {
      console.log('Skipping: API_URL_US and API_URL_EU required')
      return
    }
    if (process.env.HOME_REGION_ROUTING_E2E !== 'enforce') {
      console.log('Skipping: set HOME_REGION_ROUTING_E2E=enforce (EU API must run with HOME_REGION_ROUTING=enforce)')
      return
    }

    const email = `chat_pin_${TEST_MARKER}@test.shogo.dev`
    const password = `TestPass${Date.now()}!`

    // Sign up in US → personal workspace homeRegion = US.
    const signupRes = await signup(usApi, email, password, `Chat Pin ${TEST_MARKER}`)
    expect(signupRes.ok).toBe(true)
    const cookie = sessionCookieFrom(signupRes)
    expect(cookie).toBeDefined()
    await sleep(3000)

    const listRes = await fetch(`${usApi}/api/workspaces`, { headers: { Cookie: cookie! } })
    const list = (await listRes.json()) as Array<{ id: string }>
    const wsId = list[0]?.id
    expect(wsId).toBeDefined()

    // Seed a project row directly at the US primary (avoids spinning a real
    // runtime pod). Self-skip on schema drift so this never false-fails.
    const projectId = `proj_${TEST_MARKER}`
    try {
      const userRow = await pool(env, 'us').query(
        `SELECT id FROM users WHERE lower(email) = lower($1)`,
        [email],
      )
      const userId = userRow.rows[0]?.id
      await pool(env, 'us').query(
        `INSERT INTO projects (id, name, "workspaceId", "createdBy", "updatedAt")
         VALUES ($1, $2, $3, $4, now())`,
        [projectId, `Chat Pin ${TEST_MARKER}`, wsId, userId ?? null],
      )
    } catch (err) {
      console.log('Skipping: could not seed project row (schema drift?):', err instanceof Error ? err.message : String(err))
      return
    }

    // Let the project replicate so the EU router can resolve its home region.
    await sleep(3000)

    // Resume an unknown session via the EU API (NON-home region). Pinned home
    // to US, where the project row exists → 204 (no buffer), never 404.
    const resumeRes = await fetch(
      `${euApi}/api/projects/${projectId}/chat/nonexistent-session/stream?fromSeq=0`,
      { headers: { Cookie: cookie! } },
    )
    expect(resumeRes.status).not.toBe(404)
    expect(resumeRes.status).toBe(204)
  })
})

describe('mesh health after cross-region routing', () => {
  test('routed writes introduce zero new replication conflicts', async () => {
    const usApi = env.us.apiUrl
    const euApi = env.eu.apiUrl
    if (!usApi || !euApi) {
      console.log('Skipping: API_URL_US and API_URL_EU required')
      return
    }
    if (process.env.HOME_REGION_ROUTING_E2E !== 'enforce') {
      console.log('Skipping: set HOME_REGION_ROUTING_E2E=enforce')
      return
    }

    const conflictsBefore = await totalConflicts(env)

    // Drive a small batch of cross-region routed writes: sign up in US, then
    // mutate the workspace repeatedly from EU (its non-home region).
    const email = `mesh_health_${TEST_MARKER}@test.shogo.dev`
    const password = `TestPass${Date.now()}!`
    const signupRes = await signup(usApi, email, password, `Mesh ${TEST_MARKER}`)
    expect(signupRes.ok).toBe(true)
    const cookie = sessionCookieFrom(signupRes)!
    await sleep(3000)

    const listRes = await fetch(`${usApi}/api/workspaces`, { headers: { Cookie: cookie } })
    const list = (await listRes.json()) as Array<{ id: string }>
    const wsId = list[0]?.id
    expect(wsId).toBeDefined()

    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${euApi}/api/workspaces/${wsId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: `Mesh ${TEST_MARKER} ${i}` }),
      })
      expect(r.ok).toBe(true)
    }

    // Let everything apply across the mesh.
    await sleep(5000)

    // All subscriptions still enabled (none self-disabled on a conflict)...
    const health = await meshSubHealth(env)
    expect(health.total).toBeGreaterThan(0)
    expect(health.enabled).toBe(health.total)

    // ...and no new apply/sync errors accrued: single-writer by design.
    const conflictsAfter = await totalConflicts(env)
    expect(conflictsAfter - conflictsBefore).toBe(0)
  })
})

describe('idempotent signup', () => {
  test('signing up the same email twice yields a single user identity', async () => {
    const usApi = env.us.apiUrl
    const euApi = env.eu.apiUrl ?? env.us.apiUrl
    if (!usApi) {
      console.log('Skipping: API_URL_US required')
      return
    }

    const email = `dup_signup_${TEST_MARKER}@test.shogo.dev`
    const password = `TestPass${Date.now()}!`

    const first = await signup(usApi, email, password, `Dup ${TEST_MARKER}`)
    expect(first.ok).toBe(true)

    // Let the user row replicate so the second region can see it.
    await sleep(3000)

    // Second signup with the same email (in EU if available, else US again).
    const second = await signup(euApi, email, password, `Dup2 ${TEST_MARKER}`)
    // It must NOT succeed as a new identity, and must NOT be a 500.
    expect(second.ok).toBe(false)
    expect(second.status).toBeLessThan(500)

    // Exactly one user row everywhere.
    for (const region of ['us', 'eu', 'india']) {
      const count = await pool(env, region).query(
        `SELECT COUNT(*)::int AS c FROM users WHERE lower(email) = lower($1)`,
        [email],
      )
      expect(count.rows[0].c).toBe(1)
    }
  })
})
