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
import { getTestEnv, pool, waitForReplication, sleep, closeAllPools, type TestEnv } from './helpers'

let env: TestEnv
const TEST_MARKER = `_homeregion_test_${Date.now()}`

beforeAll(() => {
  env = getTestEnv()
})

afterAll(async () => {
  try {
    const usPool = pool(env, 'us')
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
