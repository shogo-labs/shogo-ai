import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import {
  getTestEnv,
  pool,
  waitForReplication,
  generateCuid,
  cleanupTestRows,
  closeAllPools,
  getSubscriptionStatus,
  sleep,
  type TestEnv,
} from "./helpers"
import { Pool } from "pg"

let env: TestEnv
const TEST_MARKER = `_repl_test_${Date.now()}`

beforeAll(() => {
  env = getTestEnv()
})

afterAll(async () => {
  await cleanupTestRows(env, "sessions", '"userId"', TEST_MARKER)
  await cleanupTestRows(env, "platform_settings", "key", TEST_MARKER)
  await cleanupTestRows(env, "users", "email", TEST_MARKER)
  await closeAllPools(env)
})

describe("write propagation", () => {
  test("US -> EU: row inserted in US appears in EU", async () => {
    const key = `test_us_eu_${TEST_MARKER}`

    await pool(env, "us").query(
      'INSERT INTO platform_settings (key, value, "updatedAt") VALUES ($1, $2, NOW())',
      [key, JSON.stringify({ source: "us" })]
    )

    const row = await waitForReplication<{ key: string }>({
      sourcePool: pool(env, "us"),
      targetPool: pool(env, "eu"),
      query: "SELECT key, value FROM platform_settings WHERE key = $1",
      params: [key],
      timeoutMs: 10_000,
    })

    expect(row.key).toBe(key)
  })

  test("EU -> US: row inserted in EU appears in US", async () => {
    const key = `test_eu_us_${TEST_MARKER}`

    await pool(env, "eu").query(
      'INSERT INTO platform_settings (key, value, "updatedAt") VALUES ($1, $2, NOW())',
      [key, JSON.stringify({ source: "eu" })]
    )

    const row = await waitForReplication<{ key: string }>({
      sourcePool: pool(env, "eu"),
      targetPool: pool(env, "us"),
      query: "SELECT key, value FROM platform_settings WHERE key = $1",
      params: [key],
      timeoutMs: 10_000,
    })

    expect(row.key).toBe(key)
  })

  test("three-way mesh: India -> US + EU", async () => {
    const key = `test_india_mesh_${TEST_MARKER}`

    await pool(env, "india").query(
      'INSERT INTO platform_settings (key, value, "updatedAt") VALUES ($1, $2, NOW())',
      [key, JSON.stringify({ source: "india" })]
    )

    const [usRow, euRow] = await Promise.all([
      waitForReplication<{ key: string }>({
        sourcePool: pool(env, "india"),
        targetPool: pool(env, "us"),
        query: "SELECT key FROM platform_settings WHERE key = $1",
        params: [key],
        timeoutMs: 10_000,
      }),
      waitForReplication<{ key: string }>({
        sourcePool: pool(env, "india"),
        targetPool: pool(env, "eu"),
        query: "SELECT key FROM platform_settings WHERE key = $1",
        params: [key],
        timeoutMs: 10_000,
      }),
    ])

    expect(usRow.key).toBe(key)
    expect(euRow.key).toBe(key)
  })
})

describe("auth table replication", () => {
  test("user created in US replicates to EU and India", async () => {
    const id = generateCuid()
    const email = `user_us_${TEST_MARKER}@test.shogo.dev`

    await pool(env, "us").query(
      `INSERT INTO users (id, email, name, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, false, NOW(), NOW())`,
      [id, email, "Test User US"]
    )

    const [euRow, indiaRow] = await Promise.all([
      waitForReplication<{ id: string; email: string }>({
        sourcePool: pool(env, "us"),
        targetPool: pool(env, "eu"),
        query: "SELECT id, email FROM users WHERE id = $1",
        params: [id],
        timeoutMs: 10_000,
      }),
      waitForReplication<{ id: string; email: string }>({
        sourcePool: pool(env, "us"),
        targetPool: pool(env, "india"),
        query: "SELECT id, email FROM users WHERE id = $1",
        params: [id],
        timeoutMs: 10_000,
      }),
    ])

    expect(euRow.email).toBe(email)
    expect(indiaRow.email).toBe(email)
  })

  test("session created in EU replicates to US and India", async () => {
    const userId = generateCuid()
    const sessionId = generateCuid()
    const email = `user_eu_sess_${TEST_MARKER}@test.shogo.dev`
    const token = generateCuid()

    await pool(env, "eu").query(
      `INSERT INTO users (id, email, name, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, false, NOW(), NOW())`,
      [userId, email, "Test User EU"]
    )

    await sleep(2000)

    await pool(env, "eu").query(
      `INSERT INTO sessions (id, token, "userId", "expiresAt", "ipAddress", "userAgent", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, NOW() + interval '30 days', '127.0.0.1', 'test-agent', NOW(), NOW())`,
      [sessionId, token, userId]
    )

    const [usRow, indiaRow] = await Promise.all([
      waitForReplication<{ id: string; token: string }>({
        sourcePool: pool(env, "eu"),
        targetPool: pool(env, "us"),
        query: "SELECT id, token FROM sessions WHERE id = $1",
        params: [sessionId],
        timeoutMs: 10_000,
      }),
      waitForReplication<{ id: string; token: string }>({
        sourcePool: pool(env, "eu"),
        targetPool: pool(env, "india"),
        query: "SELECT id, token FROM sessions WHERE id = $1",
        params: [sessionId],
        timeoutMs: 10_000,
      }),
    ])

    expect(usRow.token).toBe(token)
    expect(indiaRow.token).toBe(token)
  })
})

describe("PG 18 conflict detection", () => {
  test("CUID primary keys prevent INSERT conflicts across regions", async () => {
    const usId = generateCuid()
    const euId = generateCuid()
    const usEmail = `us_${TEST_MARKER}_${usId}@test.shogo.dev`
    const euEmail = `eu_${TEST_MARKER}_${euId}@test.shogo.dev`

    const [usResult, euResult] = await Promise.allSettled([
      pool(env, "us").query(
        `INSERT INTO users (id, email, name, "emailVerified", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, false, NOW(), NOW())`,
        [usId, usEmail, "CUID User US"]
      ),
      pool(env, "eu").query(
        `INSERT INTO users (id, email, name, "emailVerified", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, false, NOW(), NOW())`,
        [euId, euEmail, "CUID User EU"]
      ),
    ])

    expect(usResult.status).toBe("fulfilled")
    expect(euResult.status).toBe("fulfilled")

    const pollBothPresent = async (p: Pool, id1: string, id2: string, timeoutMs = 15_000) => {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        const res = await p.query("SELECT id FROM users WHERE id IN ($1, $2)", [id1, id2])
        if (res.rows.length === 2) return true
        await sleep(500)
      }
      return false
    }

    const [usOk, euOk] = await Promise.all([
      pollBothPresent(pool(env, "us"), usId, euId),
      pollBothPresent(pool(env, "eu"), usId, euId),
    ])

    expect(usOk).toBe(true)
    expect(euOk).toBe(true)

    const usSubscriptions = await getSubscriptionStatus(pool(env, "us"))
    const euSubscriptions = await getSubscriptionStatus(pool(env, "eu"))

    for (const sub of usSubscriptions) {
      expect(sub.pid).not.toBeNull()
    }
    for (const sub of euSubscriptions) {
      expect(sub.pid).not.toBeNull()
    }
  })
})

describe("replication lag", () => {
  test("row propagates to all regions within 5 seconds", async () => {
    const key = `test_lag_${TEST_MARKER}`

    const start = Date.now()

    await pool(env, "us").query(
      'INSERT INTO platform_settings (key, value, "updatedAt") VALUES ($1, $2, NOW())',
      [key, JSON.stringify({ ts: start })]
    )

    await Promise.all([
      waitForReplication({
        sourcePool: pool(env, "us"),
        targetPool: pool(env, "eu"),
        query: "SELECT key FROM platform_settings WHERE key = $1",
        params: [key],
        timeoutMs: 5_000,
        pollIntervalMs: 100,
      }),
      waitForReplication({
        sourcePool: pool(env, "us"),
        targetPool: pool(env, "india"),
        query: "SELECT key FROM platform_settings WHERE key = $1",
        params: [key],
        timeoutMs: 5_000,
        pollIntervalMs: 100,
      }),
    ])

    const elapsed = Date.now() - start
    console.log(`Replication lag (US -> EU + India): ${elapsed}ms`)
    expect(elapsed).toBeLessThan(5_000)
  })
})

describe("subscription health", () => {
  test("all subscriptions are active and streaming on all regions", async () => {
    const regions = ["us", "eu", "india"] as const

    for (const region of regions) {
      const subs = await getSubscriptionStatus(pool(env, region))

      expect(subs.length).toBe(2)

      for (const sub of subs) {
        expect(sub.pid).not.toBeNull()
        expect(sub.subname).toMatch(/^sub_from_(us|eu|india)$/)
      }
    }
  })

  test("all replication slots are active", async () => {
    const regions = ["us", "eu", "india"] as const

    for (const region of regions) {
      const result = await pool(env, region).query(`
        SELECT slot_name, active
        FROM pg_replication_slots
        WHERE slot_type = 'logical'
      `)

      for (const slot of result.rows) {
        expect(slot.active).toBe(true)
      }
    }
  })
})
