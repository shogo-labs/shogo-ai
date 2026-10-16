// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An agent's question card, answered through the web UI. Several questions on
 * one card reach the agent as one reply, so the agent wakes once instead of
 * once per answer.
 *
 * The card is posted the way an agent posts one (the agent-channel message
 * route with explicit `questions`), so no model runs. The agent's reply comes
 * from the scripted agent (SHOGO_CHANNEL_AGENT_SCRIPT, local mode only).
 *
 * Posting as an agent takes a workspace runtime token, which is derived from
 * BETTER_AUTH_SECRET. Set it to the same value as the API you test against.
 * The E2E_LOCAL_START_STACK config uses `e2e-local-secret`.
 */
import { mkdirSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { expect, test, type Page } from "@playwright/test"
import { deriveWorkspaceRuntimeToken } from "../../apps/api/src/lib/workspace-runtime-token"
import { LOCAL_API_BASE, openTeamHome } from "./helpers"

process.env.BETTER_AUTH_SECRET ??= "e2e-local-secret"

const SCRIPT_PATH =
  process.env.SHOGO_CHANNEL_AGENT_SCRIPT || resolve(__dirname, "../../test-results/team-chat-agents.script.json")

const suffix = Date.now().toString(36)
const AGENT = `CardBot${suffix}`
const AGENT_REPLY = "Thanks, that's everything I needed. Starting the deploy now."

const QUESTIONS = [
  {
    header: "Environment",
    prompt: "Which environment should the deploy target?",
    interaction: "choice",
    options: [{ label: "Staging A" }, { label: "Staging B" }],
  },
  {
    header: "Canary",
    prompt: "How wide should the canary be?",
    interaction: "choice",
    options: [{ label: "Canary 5%" }, { label: "Canary 20%" }],
  },
  { header: "Go ahead", prompt: "Shall I start the deploy?", interaction: "confirm" },
]

function writeScript() {
  mkdirSync(dirname(SCRIPT_PATH), { recursive: true })
  writeFileSync(SCRIPT_PATH, JSON.stringify({ delayMs: 150, agents: { [AGENT]: [{ reply: AGENT_REPLY }] } }))
}

async function apiJson(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(`${LOCAL_API_BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    data: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status(), json }
}

/** Posts a message as the agent, the way its runtime does. */
async function postAsAgent(page: Page, workspaceId: string, channelId: string, body: unknown) {
  const res = await page.request.post(
    `${LOCAL_API_BASE}/api/internal/workspaces/${workspaceId}/agent-channels/${channelId}/messages`,
    {
      headers: { "x-runtime-token": deriveWorkspaceRuntimeToken(workspaceId), "content-type": "application/json" },
      data: JSON.stringify(body),
    },
  )
  return { status: res.status(), json: await res.json().catch(() => null) }
}

interface ThreadMessage {
  id: string
  authorType: string
  text: string
}

/** Replies in a thread (the root itself is not included). */
async function thread(page: Page, channelId: string, rootId: string): Promise<ThreadMessage[]> {
  const res = await apiJson(page, "GET", `/api/conversations/${channelId}/messages?threadRootId=${rootId}`)
  return res.json?.messages ?? []
}

const personReplies = async (page: Page, channelId: string, rootId: string) =>
  (await thread(page, channelId, rootId)).filter((m) => m.authorType === "user")

const agentReplies = async (page: Page, channelId: string, rootId: string) =>
  (await thread(page, channelId, rootId)).filter((m) => m.authorType === "agent")

test.describe("Question cards: answers to one card reach the agent as one reply", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let workspaceId: string
  let channelId: string
  let projectId: string
  const projectIds: string[] = []

  /** Posts a fresh card in the channel and returns the message id it lives on. */
  async function askCard(): Promise<string> {
    const posted = await postAsAgent(page, workspaceId, channelId, {
      projectId,
      text: "The deploy is ready. I need three decisions before I start it.",
      questions: QUESTIONS,
    })
    expect(posted.status, JSON.stringify(posted.json)).toBe(201)
    return posted.json.message.id as string
  }

  async function openChannel() {
    await page.goto(`/c/${channelId}`)
    await expect(page.getByText("Which environment should the deploy target?").first()).toBeVisible({ timeout: 30_000 })
  }

  /** Replies to a card are in its thread, which the channel view only links to. */
  async function openThread(rootId: string) {
    await page.goto(`/c/${channelId}?thread=${rootId}`)
    await expect(page.getByLabel("Close thread")).toBeVisible({ timeout: 30_000 })
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    writeScript()
    page = await browser.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    await openTeamHome(page)

    const workspaces = await apiJson(page, "GET", "/api/workspaces")
    const rows = (workspaces.json?.items ?? workspaces.json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
    workspaceId = rows.find((w) => w.kind !== "personal")!.id

    const session = await (await page.request.get(`${LOCAL_API_BASE}/api/auth/get-session`)).json().catch(() => null)
    const created = await apiJson(page, "POST", "/api/projects", {
      name: AGENT,
      workspaceId,
      createdBy: session?.user?.id,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
      schemas: [],
    })
    projectId = created.json?.data?.id ?? created.json?.id
    expect(projectId, JSON.stringify(created.json)).toBeTruthy()
    projectIds.push(projectId)

    const channel = await apiJson(page, "POST", `/api/workspaces/${workspaceId}/conversations`, {
      name: `question-cards-${suffix}`,
      kind: "public",
    })
    channelId = channel.json?.conversation?.id
    expect(channelId, JSON.stringify(channel.json)).toBeTruthy()
  })

  test.afterAll(async () => {
    for (const id of projectIds) await page.request.delete(`${LOCAL_API_BASE}/api/projects/${id}`).catch(() => {})
    await page?.close()
  })

  test("answering all three sends one reply, and the agent wakes once", async () => {
    const rootId = await askCard()
    await openChannel()

    await page.getByRole("button", { name: "Staging A", exact: true }).click()
    await expect(page.getByText(/when you finish the rest/)).toHaveCount(1)
    await page.getByRole("button", { name: "Canary 20%", exact: true }).click()
    await expect(page.getByText(/when you finish the rest/)).toHaveCount(2)
    // Two of three are answered: the person has not been sent anything yet.
    expect(await personReplies(page, channelId, rootId)).toHaveLength(0)

    await page.getByRole("button", { name: "Approve", exact: true }).click()

    await expect(page.getByText(/, sent to /)).toHaveCount(3)
    await expect.poll(async () => (await personReplies(page, channelId, rootId)).length, { timeout: 15_000 }).toBe(1)
    const [reply] = await personReplies(page, channelId, rootId)
    expect(reply.text).toContain("- **Environment:** Staging A")
    expect(reply.text).toContain("- **Canary:** Canary 20%")
    expect(reply.text).toContain("- **Go ahead:** Approve")

    await expect.poll(async () => (await agentReplies(page, channelId, rootId)).length, { timeout: 30_000 }).toBe(1)
    await openThread(rootId)
    await expect(page.getByText(AGENT_REPLY)).toBeVisible({ timeout: 30_000 })
    // Give any second run time to start before checking it did not.
    await page.waitForTimeout(3_000)
    expect(await agentReplies(page, channelId, rootId)).toHaveLength(1)
    expect(await personReplies(page, channelId, rootId)).toHaveLength(1)
  })

  test("dismissing the rest sends what was answered straight away", async () => {
    const rootId = await askCard()
    await openChannel()

    await page.getByRole("button", { name: "Canary 5%", exact: true }).click()
    await page.getByRole("button", { name: "Dismiss question" }).first().click()
    await expect(page.getByRole("button", { name: "Dismiss question" })).toHaveCount(1)
    // The last open question is still there, so the answer is held.
    expect(await personReplies(page, channelId, rootId)).toHaveLength(0)

    await page.getByRole("button", { name: "Dismiss question" }).click()

    await expect.poll(async () => (await personReplies(page, channelId, rootId)).length, { timeout: 15_000 }).toBe(1)
    const [reply] = await personReplies(page, channelId, rootId)
    expect(reply.text).toContain("**Canary:** Canary 5%")
    expect(reply.text).not.toContain("Staging")
    await expect.poll(async () => (await agentReplies(page, channelId, rootId)).length, { timeout: 30_000 }).toBe(1)
  })

  test("a partial set goes to the agent once the person has been idle for two minutes", async () => {
    test.setTimeout(270_000)
    const rootId = await askCard()
    await openChannel()

    await page.getByRole("button", { name: "Staging B", exact: true }).click()
    await expect(page.getByText(/when you finish the rest/)).toBeVisible()

    // Still inside the idle window, so still held.
    await page.waitForTimeout(20_000)
    expect(await personReplies(page, channelId, rootId)).toHaveLength(0)

    // The default idle window is 120s; the channel scheduler (every 15s) sends it after that.
    await expect.poll(async () => (await personReplies(page, channelId, rootId)).length, { timeout: 230_000, intervals: [5_000] }).toBe(1)
    const [reply] = await personReplies(page, channelId, rootId)
    expect(reply.text).toContain("**Environment:** Staging B")
    expect(reply.text).not.toContain("Canary")
    await expect.poll(async () => (await agentReplies(page, channelId, rootId)).length, { timeout: 30_000 }).toBe(1)
  })
})
