// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A team workspace with something in every sidebar tab: a channel, a person who
 * messaged the user (so the DM arrives unread with a preview), two agents, and
 * a failed agent task for the Activity and Home "Needs you" views.
 *
 * The DM is person-to-person: a chat with an agent is a project chat now
 * (SHO-412), so an agent DM is no longer something the app can show in the DMs
 * tab. The second person is written straight to the local database because
 * local mode refuses a second sign-up (see `huddle-seed-user.ts`).
 *
 * Agent replies are scripted (SHOGO_CHANNEL_AGENT_SCRIPT, local mode only), the
 * same mechanism team-chat-agents.test.ts uses.
 */
import { execFileSync } from "child_process"
import { mkdirSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { expect, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"

const REPO = resolve(__dirname, "../..")
// Same resolution as `playwright.config.ts`'s `localDbPath`: the seed has to
// write to the database the stack booted, and `E2E_LOCAL_DB` is how a run picks
// a different one.
const DATABASE_URL =
  process.env.E2E_LOCAL_DATABASE_URL ||
  `file:${resolve(REPO, process.env.E2E_LOCAL_DB || "test-results/e2e-local.db")}`
const PEER = { email: "team-nav-peer@example.com", password: "team-nav-peer-pass", name: "Bea Partner" }

export const SCRIPT_PATH =
  process.env.SHOGO_CHANNEL_AGENT_SCRIPT || resolve(__dirname, "../../test-results/team-chat-agents.script.json")

export interface TeamNavSeed {
  suffix: string
  workspaceId: string
  channelName: string
  channelId: string
  /** The person who messaged the user, so the DM arrives unread with a preview. */
  dmPeer: string
  dmPeerId: string
  dmId: string
  dmReply: string
  /** An agent, for the Agents tab and the project page. */
  dmAgent: string
  dmAgentProjectId: string
  /** A second agent with no chat yet. */
  idleAgent: string
  idleAgentProjectId: string
  projectIds: string[]
}

export async function api(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(`${LOCAL_API_BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    data: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status(), json, retryAfter: res.headers()["retry-after"] }
}

export async function teamWorkspaceId(page: Page): Promise<string> {
  const res = await api(page, "GET", "/api/workspaces")
  const rows = (res.json?.items ?? res.json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
  const id = rows.find((w) => w.kind !== "personal")?.id
  if (!id) throw new Error(`local stack has no team workspace: ${JSON.stringify(res.json)}`)
  return id
}

/**
 * The second person's message is what makes the DM unread, and every spec that
 * reads the dock or the rail badge needs it to already exist. Waiting here, in
 * the seed, keeps the wait off the badge assertion: a red there then means the
 * badge is broken, not that the message was late (SHO-222).
 */
export async function waitForDmMessage(page: Page, seed: TeamNavSeed, timeoutMs = 30_000): Promise<number> {
  const started = Date.now()
  await expect
    .poll(
      async () => {
        const res = await api(page, "GET", `/api/conversations/${seed.dmId}/messages`)
        const rows = (res.json?.messages ?? []) as Array<{ text?: string }>
        return rows.some((m) => (m.text ?? "").includes(seed.dmReply))
      },
      {
        timeout: timeoutMs,
        message: `"${seed.dmPeer}" never posted the seeded DM message within ${timeoutMs / 1000}s`,
      },
    )
    .toBe(true)
  const elapsed = Date.now() - started
  // Keep this: the first CI runs are the only measurement of how long a seeded
  // message actually takes on a runner (SHO-222).
  console.log(`[team-nav-seed] DM message after ${elapsed}ms`)
  return elapsed
}

/** Adds the second person to the local team workspace and returns their id. */
function seedPeer(): string {
  const out = execFileSync(
    "bun",
    ["--no-env-file", resolve(__dirname, "huddle-seed-user.ts"), PEER.email, PEER.password, PEER.name],
    { cwd: REPO, env: { ...process.env, DATABASE_URL }, encoding: "utf8" },
  )
  return JSON.parse(out.trim().split("\n").pop()!).userId
}

/** Posts the DM message as the second person, in their own session. */
async function postAsPeer(page: Page, conversationId: string, text: string): Promise<void> {
  const browser = page.context().browser()
  if (!browser) throw new Error("the seed needs a browser to sign in as the second person")
  const context = await browser.newContext()
  try {
    const signedIn = await context.request.post(`${LOCAL_API_BASE}/api/auth/sign-in/email`, {
      data: { email: PEER.email, password: PEER.password },
    })
    if (!signedIn.ok()) throw new Error(`peer sign-in failed: ${signedIn.status()} ${await signedIn.text()}`)
    const posted = await context.request.post(`${LOCAL_API_BASE}/api/conversations/${conversationId}/messages`, {
      data: { text },
    })
    if (!posted.ok()) throw new Error(`peer message failed: ${posted.status()} ${await posted.text()}`)
  } finally {
    await context.close()
  }
}

export async function seedTeamNav(page: Page): Promise<TeamNavSeed> {
  const suffix = Date.now().toString(36)
  const workspaceId = await teamWorkspaceId(page)
  const dmAgent = `Scout${suffix}`
  const idleAgent = `Builder${suffix}`
  const dmReply = `Found two flaky checkout tests (${suffix}). Want me to quarantine them?`

  mkdirSync(dirname(SCRIPT_PATH), { recursive: true })
  writeFileSync(SCRIPT_PATH, JSON.stringify({ delayMs: 100, agents: { [dmAgent]: [{ reply: dmReply }] } }))

  const session = await (await page.request.get(`${LOCAL_API_BASE}/api/auth/get-session`)).json().catch(() => null)
  const projectIds: string[] = []
  for (const name of [dmAgent, idleAgent]) {
    const created = await api(page, "POST", "/api/projects", {
      name,
      workspaceId,
      createdBy: session?.user?.id,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
      schemas: [],
    })
    const id = created.json?.data?.id ?? created.json?.id
    if (!id) throw new Error(`project create failed: ${JSON.stringify(created.json)}`)
    projectIds.push(id)
  }

  const channelName = `launch-${suffix}`
  const channel = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, { name: channelName, kind: "public" })
  const channelId = channel.json?.conversation?.id
  if (!channelId) throw new Error(`channel create failed: ${JSON.stringify(channel.json)}`)

  const dmPeerId = seedPeer()
  const dm = await api(page, "POST", `/api/workspaces/${workspaceId}/dms`, { userIds: [dmPeerId] })
  const dmId = dm.json?.conversation?.id
  if (!dmId) throw new Error(`person dm failed: ${JSON.stringify(dm.json)}`)
  await postAsPeer(page, dmId, dmReply)

  const seed: TeamNavSeed = {
    suffix, workspaceId, channelName, channelId,
    dmPeer: PEER.name, dmPeerId, dmId, dmReply,
    dmAgent, dmAgentProjectId: projectIds[0]!, idleAgent, idleAgentProjectId: projectIds[1]!, projectIds,
  }
  // Do not return until the message exists: every caller reads the unread badge.
  await waitForDmMessage(page, seed)
  return seed
}

export async function cleanupTeamNav(page: Page, seed: TeamNavSeed): Promise<void> {
  for (const id of seed.projectIds) await page.request.delete(`${LOCAL_API_BASE}/api/projects/${id}`).catch(() => {})
}

/** Make the team workspace the active one (Local mode opens Personal). */
export async function activateTeamWorkspace(page: Page, workspaceId: string): Promise<void> {
  await page.addInitScript((id) => {
    localStorage.setItem("shogo:active-workspace-id", id)
    sessionStorage.setItem("shogo:active-workspace-id", id)
    localStorage.setItem("shogo:active-workspace-kind", JSON.stringify({ id, kind: "team" }))
    sessionStorage.setItem("shogo:active-workspace-kind", JSON.stringify({ id, kind: "team" }))
  }, workspaceId)
}

/**
 * Sign in without loading the app: the same `/api/local/auto-sign-in` the app
 * calls on boot, made through `page.request`, so the session cookie is in this
 * page's context before its first navigation.
 *
 * Phone specs use this instead of `signIn`. `signIn` boots the app at `/` and
 * returns once the *session* exists, not once the page has finished booting, so
 * the spec's own `page.goto` lands while that first page is still loading: a
 * second hard navigation mid-boot, the SHO-273 WebKit hang (a document request
 * Metro never answers inside the 120s budget, run 41625226724). It also paid
 * for a full app boot per test that the test immediately threw away.
 */
export async function signInByApi(page: Page): Promise<void> {
  const res = await page.request.post(`${LOCAL_API_BASE}/api/local/auto-sign-in`)
  expect(res.ok(), `local auto-sign-in failed (${res.status()})`).toBe(true)
  await expect
    .poll(async () => (await (await page.request.get(`${LOCAL_API_BASE}/api/auth/get-session`)).json().catch(() => null))?.user?.id ?? null, {
      timeout: 60_000,
    })
    .not.toBeNull()
}

/**
 * Local mode signs the user in on first load. Wait for the session so the
 * API calls the seed makes (through `page.request`) are authenticated.
 */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/")
  await expect
    .poll(async () => (await (await page.request.get(`${LOCAL_API_BASE}/api/auth/get-session`)).json().catch(() => null))?.user?.id ?? null, {
      timeout: 60_000,
    })
    .not.toBeNull()
}
