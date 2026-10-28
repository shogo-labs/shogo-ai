// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A team workspace with something in every sidebar tab: a channel, two agents
 * (one answers the person's DM, so the DM arrives unread with a preview), and
 * a failed agent task for the Activity and Home "Needs you" views.
 *
 * Agent replies are scripted (SHOGO_CHANNEL_AGENT_SCRIPT, local mode only), the
 * same mechanism team-chat-agents.test.ts uses.
 */
import { mkdirSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { expect, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"

export const SCRIPT_PATH =
  process.env.SHOGO_CHANNEL_AGENT_SCRIPT || resolve(__dirname, "../../test-results/team-chat-agents.script.json")

export interface TeamNavSeed {
  suffix: string
  workspaceId: string
  channelName: string
  channelId: string
  /** The agent that answered the DM. */
  dmAgent: string
  dmAgentProjectId: string
  dmId: string
  dmReply: string
  /** A second agent with no DM yet. */
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

/**
 * A seed write that must land. The local-mode API rate-limits human posts
 * (`CHAT_RATE_LIMITS.message`: 60 per user per minute), and
 * team-home-phone-perf.test.ts posts 150 messages as that same local user just
 * before this seed runs — so the DM post came back 429, nothing was posted, no
 * scripted agent replied, and the unread badge waited 30s for a message that
 * never existed (SHO-222). Wait the window out instead of seeding nothing.
 */
async function postThatMustLand(page: Page, path: string, body: unknown, what: string) {
  for (let attempt = 1; ; attempt += 1) {
    const res = await api(page, "POST", path, body)
    if (res.status === 429 && attempt <= 6) {
      const waitMs = Math.max(1, Number(res.retryAfter) || 10) * 1000
      console.log(`[team-nav-seed] ${what} hit the message rate limit; retrying in ${waitMs / 1000}s`)
      await new Promise((r) => setTimeout(r, waitMs))
      continue
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${what} failed: ${res.status} ${JSON.stringify(res.json)}`)
    }
    return res
  }
}

export async function teamWorkspaceId(page: Page): Promise<string> {
  const res = await api(page, "GET", "/api/workspaces")
  const rows = (res.json?.items ?? res.json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
  const id = rows.find((w) => w.kind !== "personal")?.id
  if (!id) throw new Error(`local stack has no team workspace: ${JSON.stringify(res.json)}`)
  return id
}

/**
 * The scripted agent's reply is what makes the DM unread, and every spec that
 * reads the dock or the rail badge needs it to already exist. Waiting here, in
 * the seed, keeps the wait off the badge assertion: a red there then means the
 * badge is broken, not that the reply was late (SHO-222).
 */
export async function waitForDmReply(page: Page, seed: TeamNavSeed, timeoutMs = 90_000): Promise<number> {
  const started = Date.now()
  await expect
    .poll(
      async () => {
        const res = await api(page, "GET", `/api/conversations/${seed.dmId}/messages`)
        const rows = (res.json?.messages ?? []) as Array<{ text?: string; agentStatus?: string | null }>
        return rows.find((m) => (m.text ?? "").includes(seed.dmReply))?.agentStatus ?? null
      },
      {
        timeout: timeoutMs,
        message: `the scripted agent "${seed.dmAgent}" never finished its reply to the seeded DM within ${timeoutMs / 1000}s`,
      },
    )
    .toBe("done")
  const elapsed = Date.now() - started
  // Keep this: the first CI runs are the only measurement of how long a
  // scripted reply actually takes on a runner (SHO-222).
  console.log(`[team-nav-seed] DM reply after ${elapsed}ms`)
  return elapsed
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

  const dm = await api(page, "POST", `/api/workspaces/${workspaceId}/dms`, { agent: { projectId: projectIds[0] } })
  const dmId = dm.json?.conversation?.id
  if (!dmId) throw new Error(`agent dm failed: ${JSON.stringify(dm.json)}`)
  await postThatMustLand(page, `/api/conversations/${dmId}/messages`, { text: "any flaky tests lately?" }, "the seeded DM message")

  const seed: TeamNavSeed = {
    suffix, workspaceId, channelName, channelId, dmAgent, dmAgentProjectId: projectIds[0]!, dmId, dmReply,
    idleAgent, idleAgentProjectId: projectIds[1]!, projectIds,
  }
  // Do not return until the reply exists: every caller reads the unread badge.
  await waitForDmReply(page, seed)
  return seed
}

export async function cleanupTeamNav(page: Page, seed: TeamNavSeed): Promise<void> {
  for (const id of seed.projectIds) await page.request.delete(`${LOCAL_API_BASE}/api/projects/${id}`).catch(() => {})
}

/** Make the team workspace the active one (Local mode opens Personal). */
export async function activateTeamWorkspace(page: Page, workspaceId: string): Promise<void> {
  await page.addInitScript((id) => {
    localStorage.setItem("shogo:active-workspace-id", id)
    localStorage.setItem("shogo:active-workspace-kind", JSON.stringify({ id, kind: "team" }))
  }, workspaceId)
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
