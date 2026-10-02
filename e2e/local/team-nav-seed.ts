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
  projectIds: string[]
}

export async function api(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(`${LOCAL_API_BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    data: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status(), json }
}

export async function teamWorkspaceId(page: Page): Promise<string> {
  const res = await api(page, "GET", "/api/workspaces")
  const rows = (res.json?.items ?? res.json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
  const id = rows.find((w) => w.kind !== "personal")?.id
  if (!id) throw new Error(`local stack has no team workspace: ${JSON.stringify(res.json)}`)
  return id
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
  await api(page, "POST", `/api/conversations/${dmId}/messages`, { text: "any flaky tests lately?" })

  return { suffix, workspaceId, channelName, channelId, dmAgent, dmAgentProjectId: projectIds[0]!, dmId, dmReply, idleAgent, projectIds }
}

export async function cleanupTeamNav(page: Page, seed: TeamNavSeed): Promise<void> {
  for (const id of seed.projectIds) await page.request.delete(`${LOCAL_API_BASE}/api/projects/${id}`).catch(() => {})
}

/** Make the team workspace the active one (Local mode opens Personal). */
export async function activateTeamWorkspace(page: Page, workspaceId: string): Promise<void> {
  await page.addInitScript((id) => {
    localStorage.setItem("shogo:active-workspace-id", id)
    localStorage.setItem("shogo:active-workspace-kind", "team")
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
