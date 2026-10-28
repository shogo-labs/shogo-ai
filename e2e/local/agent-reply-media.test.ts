// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An agent's ordinary turn reply carries the workspace media it embeds.
 *
 * The agent answers a mention with a workspace image path in its final text —
 * no `team_chat_post` call — and the reply the platform posts must show the
 * picture: the ref is published to a signed conversation-file URL and linked to
 * that message, which is what makes the thread render it and what keeps it
 * readable once the agent sleeps.
 *
 * The image is put in the agent's runtime first, through the same proxy the app
 * uses, so the reply is the only thing under test. Agent replies are scripted
 * (SHOGO_CHANNEL_AGENT_SCRIPT, local mode only), so the run is deterministic.
 */
import { mkdirSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

const SCRIPT_PATH =
  process.env.SHOGO_CHANNEL_AGENT_SCRIPT || resolve(__dirname, "../../test-results/team-chat-agents.script.json")

const suffix = Date.now().toString(36)
const AGENT = `RenderAgent${suffix}`
const IMAGE_NAME = `hero-${suffix}.png`
const IMAGE_PATH = `renders/${IMAGE_NAME}`
const REPLY = `Here is the render you asked for:\n\n![Hero](${IMAGE_PATH})`
// A 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
)

/** Writes the scripted reply so the API picks it up on the next agent turn. */
function writeScript() {
  mkdirSync(dirname(SCRIPT_PATH), { recursive: true })
  writeFileSync(SCRIPT_PATH, JSON.stringify({ delayMs: 100, agents: { [AGENT]: [{ reply: REPLY }] } }))
}

/** Opens the thread under the latest top-level message containing `text`. */
async function openThread(page: Page, channelId: string, text: string) {
  let rootId: string | undefined
  await expect(async () => {
    const res = await api(page, "GET", `/api/conversations/${channelId}/messages`)
    const roots = (res.json?.messages ?? []).filter((m: any) => !m.threadRootId && m.text.includes(text))
    rootId = roots.at(-1)?.id
    expect(rootId).toBeTruthy()
  }).toPass({ timeout: 15_000 })
  await page.goto(`/c/${channelId}?thread=${rootId}`)
  await expect(page.getByLabel("Close thread")).toBeVisible({ timeout: 30_000 })
  return rootId!
}

test.describe("Agent reply media", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let workspaceId: string
  let projectId: string
  let channelId: string

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000)
    page = await browser.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    await signIn(page)
    workspaceId = await teamWorkspaceId(page)

    const session = await (await page.request.get(`${LOCAL_API_BASE}/api/auth/get-session`)).json().catch(() => null)
    const created = await api(page, "POST", "/api/projects", {
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

    // The first call boots the project's runtime, so the reply that follows has
    // somewhere to read the file from.
    const upload = await page.request.post(`${LOCAL_API_BASE}/api/projects/${projectId}/agent-proxy/agent/workspace/upload`, {
      multipart: { directory: "renders", file: { name: IMAGE_NAME, mimeType: "image/png", buffer: PNG } },
    })
    expect(upload.status(), await upload.text()).toBe(200)

    writeScript()
    const channel = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, {
      name: `reply-media-${suffix}`,
      kind: "public",
    })
    channelId = channel.json?.conversation?.id
    expect(channelId, JSON.stringify(channel.json)).toBeTruthy()
  })

  test.afterAll(async () => {
    if (projectId) await page.request.delete(`${LOCAL_API_BASE}/api/projects/${projectId}`).catch(() => {})
    await page?.close()
  })

  test("a workspace image in the agent's reply is published and renders in the thread", async () => {
    test.setTimeout(180_000)
    await activateTeamWorkspace(page, workspaceId)
    await page.goto(`/c/${channelId}`)
    const composer = page.getByLabel("Message", { exact: true }).first()
    await composer.waitFor({ state: "visible", timeout: 30_000 })
    await composer.click()
    await composer.pressSequentially(`@${AGENT}`)
    await page.getByText(AGENT, { exact: true }).last().waitFor({ state: "visible" })
    await page.keyboard.press("Enter")
    await composer.pressSequentially(" show me the hero render")
    await page.keyboard.press("Enter")

    await openThread(page, channelId, "show me the hero render")

    // Published: the ref the agent wrote is now a signed conversation-file URL,
    // and the thread shows the picture instead of the raw workspace path.
    const image = page.locator(`img[src*="/api/conversation-files/"]`).first()
    await expect(image).toBeVisible({ timeout: 60_000 })
    expect(await image.getAttribute("src")).toContain(`#${IMAGE_NAME}`)
    await expect(page.getByText(IMAGE_PATH, { exact: false })).toHaveCount(0)

    // The stored reply carries the rewritten ref (what a reload renders), and it
    // is the agent's own message — no second tool call in between.
    const thread = await api(page, "GET", `/api/conversations/${channelId}/messages?threadRootId=${await openThreadId(channelId)}`)
    const reply = (thread.json?.messages ?? []).find((m: any) => m.text?.includes("/api/conversation-files/"))
    expect(reply, JSON.stringify(thread.json)).toBeTruthy()
    expect(reply.text).toMatch(new RegExp(`!\\[Hero\\]\\(/api/conversation-files/[^)\\s]+\\?t=`))
    expect(reply.authorAgent?.name).toBe(AGENT)
    expect(reply.agentStatus).toBe("done")
  })

  /** The thread root the reply lives under — the message that mentioned the agent. */
  async function openThreadId(channelIdToUse: string) {
    const res = await api(page, "GET", `/api/conversations/${channelIdToUse}/messages`)
    const roots = (res.json?.messages ?? []).filter((m: any) => !m.threadRootId && m.text.includes("show me the hero render"))
    return roots.at(-1)?.id as string
  }
})
