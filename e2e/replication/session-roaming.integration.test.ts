import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import {
  getTestEnv,
  pool,
  waitForReplication,
  generateCuid,
  cleanupTestRows,
  closeAllPools,
  sleep,
  type TestEnv,
} from "./helpers"

let env: TestEnv
const TEST_MARKER = `_roam_test_${Date.now()}`

beforeAll(() => {
  env = getTestEnv()
})

afterAll(async () => {
  try {
    const usPool = pool(env, "us")
    await usPool.query(`DELETE FROM projects WHERE name LIKE $1`, [`%${TEST_MARKER}%`])
    await usPool.query(`DELETE FROM members WHERE id LIKE $1`, [`%${TEST_MARKER}%`])
    await usPool.query(`DELETE FROM workspaces WHERE name LIKE $1`, [`%${TEST_MARKER}%`])
    await usPool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${TEST_MARKER}%`])
  } catch {}
  await closeAllPools(env)
})

describe("session roaming via API", () => {
  test("signup via US API, session visible via EU API", async () => {
    const usApi = env.us.apiUrl
    const euApi = env.eu.apiUrl
    if (!usApi || !euApi) {
      console.log("Skipping: API_URL_US and API_URL_EU required")
      return
    }

    const email = `roam_signup_${TEST_MARKER}@test.shogo.dev`
    const password = `TestPass${Date.now()}!`

    const signupRes = await fetch(`${usApi}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name: "Roaming User" }),
    })

    expect(signupRes.ok).toBe(true)

    const cookies = signupRes.headers.getSetCookie()
    const sessionCookie = cookies.find((c) =>
      c.startsWith("shogo.session_token=")
    )
    expect(sessionCookie).toBeDefined()

    await sleep(3000)

    const sessionRes = await fetch(`${euApi}/api/auth/get-session`, {
      headers: {
        Cookie: sessionCookie!,
      },
    })

    expect(sessionRes.ok).toBe(true)
    const session = (await sessionRes.json()) as { user?: { email?: string } }
    expect(session.user?.email).toBe(email)
  })
})

describe("project visibility across regions", () => {
  test("project created via DB in US appears in EU query", async () => {
    const userId = generateCuid()
    const workspaceId = generateCuid()
    const projectId = generateCuid()
    const memberId = generateCuid()
    const email = `proj_vis_${TEST_MARKER}@test.shogo.dev`

    await pool(env, "us").query(
      `INSERT INTO users (id, email, name, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, false, NOW(), NOW())`,
      [userId, email, "Project Vis User"]
    )

    await pool(env, "us").query(
      `INSERT INTO workspaces (id, name, slug, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [
        workspaceId,
        `Test WS ${TEST_MARKER}`,
        `test-ws-${Date.now()}`,
      ]
    )

    await pool(env, "us").query(
      `INSERT INTO members (id, "userId", "workspaceId", role, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'owner', NOW(), NOW())`,
      [memberId, userId, workspaceId]
    )

    await pool(env, "us").query(
      `INSERT INTO projects (id, name, "workspaceId", "createdAt", "updatedAt", status)
       VALUES ($1, $2, $3, NOW(), NOW(), 'active')`,
      [projectId, `Test Project ${TEST_MARKER}`, workspaceId]
    )

    const euRow = await waitForReplication<{ id: string; name: string }>({
      sourcePool: pool(env, "us"),
      targetPool: pool(env, "eu"),
      query: "SELECT id, name FROM projects WHERE id = $1",
      params: [projectId],
      timeoutMs: 10_000,
    })

    expect(euRow.id).toBe(projectId)
    expect(euRow.name).toContain(TEST_MARKER)

    const indiaRow = await waitForReplication<{ id: string }>({
      sourcePool: pool(env, "us"),
      targetPool: pool(env, "india"),
      query: "SELECT id FROM projects WHERE id = $1",
      params: [projectId],
      timeoutMs: 10_000,
    })

    expect(indiaRow.id).toBe(projectId)
  })
})
