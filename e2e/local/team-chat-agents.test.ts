// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agents handing work to each other in a team chat thread, driven through the
 * web UI. Agent replies are scripted (SHOGO_CHANNEL_AGENT_SCRIPT, local mode
 * only) so the run is fast and deterministic: this spec writes the script file,
 * the API re-reads it on every agent reply.
 *
 * `E2E_LOCAL_START_STACK=1` sets the script path for the API it boots. Against
 * your own stack, start the API with the same env var pointing at
 * test-results/team-chat-agents.script.json.
 */
import { mkdirSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE, openTeamHome } from "./helpers"

const SCRIPT_PATH =
  process.env.SHOGO_CHANNEL_AGENT_SCRIPT || resolve(__dirname, "../../test-results/team-chat-agents.script.json")

const suffix = Date.now().toString(36)
const NAMES = {
  scout: `ChainScout${suffix}`,
  planner: `ChainPlanner${suffix}`,
  builder: `ChainBuilder${suffix}`,
  writer: `NotesWriter${suffix}`,
  reviewer: `NotesReviewer${suffix}`,
}

function writeScript() {
  mkdirSync(dirname(SCRIPT_PATH), { recursive: true })
  writeFileSync(
    SCRIPT_PATH,
    JSON.stringify({
      delayMs: 150,
      agents: {
        [NAMES.scout]: [{
          reply:
            "Reproduced issue 12: slugify() leaves a trailing dash when a title ends in punctuation, because it strips " +
            "punctuation after collapsing dashes. The existing tests never cover trailing punctuation, which is how it " +
            `slipped through. @${NAMES.planner} can you plan a fix?`,
        }],
        [NAMES.planner]: [
          {
            when: "option B",
            reply:
              "Going with option B since it also fixes the double-dash bug from issue 9. The plan is to replace the two " +
              "passes with one regex that turns runs of non-alphanumerics into a dash, then trim dashes from both ends, " +
              `with tests for trailing punctuation and repeated separators. @${NAMES.builder} please implement this.`,
          },
          {
            reply:
              "There are two ways to fix this. Option A swaps the order of the two replace calls: one line and low risk, " +
              "but issue 9 stays open. Option B rewrites slugify() as a single regex pass, which fixes both. " +
              "{{origin}}, A or B?",
          },
        ],
        [NAMES.builder]: [{
          reply:
            "PR ready: https://example.com/pr/1. slugify() now does a single regex pass and trims dashes from both ends. " +
            "I added four tests for trailing punctuation and repeated separators, and the full suite passes.",
        }],
        [NAMES.writer]: [{
          reply:
            "I drafted the release note for the slugify fix, covering only user-visible behavior. It says titles ending in " +
            `punctuation no longer get a trailing dash. @${NAMES.reviewer} can you check it's accurate before I post it?`,
        }],
        [NAMES.reviewer]: [{
          reply:
            "The draft also claims the double-dash bug from issue 9 is fixed, but that's only true if option B shipped. " +
            `@${NAMES.writer} please check which option merged and update the note.`,
        }],
      },
    }),
  )
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

/** Types into a composer, picking `@name` from the mention menu so it's sent as a real mention. */
async function compose(page: Page, composer: ReturnType<Page["getByLabel"]>, parts: Array<string | { mention: string }>) {
  await composer.click()
  for (const part of parts) {
    if (typeof part === "string") {
      await composer.pressSequentially(part)
    } else {
      await composer.pressSequentially(`@${part.mention}`)
      await page.getByText(part.mention, { exact: true }).last().waitFor({ state: "visible" })
      await page.keyboard.press("Enter")
    }
  }
  await page.keyboard.press("Enter")
}

/** Opens the thread under the latest top-level message containing `text`. */
async function openThread(page: Page, channelId: string, text: string) {
  let rootId: string | undefined
  await expect(async () => {
    const res = await apiJson(page, "GET", `/api/conversations/${channelId}/messages`)
    const roots = (res.json?.messages ?? []).filter((m: any) => !m.threadRootId && m.text.includes(text))
    rootId = roots.at(-1)?.id
    expect(rootId).toBeTruthy()
  }).toPass({ timeout: 15_000 })
  await page.goto(`/c/${channelId}?thread=${rootId}`)
  await expect(page.getByLabel("Close thread")).toBeVisible({ timeout: 30_000 })
  return rootId!
}

async function openChannelComposer(page: Page, channelId: string) {
  await page.goto(`/c/${channelId}`)
  const composer = page.getByLabel("Message", { exact: true }).first()
  try {
    await composer.waitFor({ state: "visible", timeout: 10_000 })
  } catch {
    // The local stack can finish the channel route after the initial
    // navigation response. A reload avoids making this serial E2E depend on
    // that startup race.
    await page.reload()
    await composer.waitFor({ state: "visible", timeout: 30_000 })
  }
  return composer
}

test.describe("Team chat: agents hand off to each other", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let channelId: string
  const projectIds: string[] = []

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    writeScript()
    page = await browser.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    await openTeamHome(page)

    const workspaces = await apiJson(page, "GET", "/api/workspaces")
    const rows = (workspaces.json?.items ?? workspaces.json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
    const workspaceId = rows.find((w) => w.kind !== "personal")?.id
    expect(workspaceId, JSON.stringify(workspaces.json)).toBeTruthy()

    const session = await (await page.request.get(`${LOCAL_API_BASE}/api/auth/get-session`)).json().catch(() => null)
    for (const name of Object.values(NAMES)) {
      const created = await apiJson(page, "POST", "/api/projects", {
        name,
        workspaceId,
        createdBy: session?.user?.id,
        tier: "starter",
        status: "draft",
        accessLevel: "anyone",
        schemas: [],
      })
      const id = created.json?.data?.id ?? created.json?.id
      expect(id, JSON.stringify(created.json)).toBeTruthy()
      projectIds.push(id)
    }

    const channel = await apiJson(page, "POST", `/api/workspaces/${workspaceId}/conversations`, {
      name: `agent-handoffs-${suffix}`,
      kind: "public",
    })
    channelId = channel.json?.conversation?.id
    expect(channelId, JSON.stringify(channel.json)).toBeTruthy()
  })

  test.afterAll(async () => {
    for (const id of projectIds) await page.request.delete(`${LOCAL_API_BASE}/api/projects/${id}`).catch(() => {})
    await page?.close()
  })

  test("a tagged agent hands off, asks the person, and the chain continues after they answer", async () => {
    const channelComposer = await openChannelComposer(page, channelId)
    await compose(page, channelComposer, [{ mention: NAMES.scout }, " triage issue 12"])

    const rootId = await openThread(page, channelId, "triage issue 12")

    await expect(page.getByText("Reproduced issue 12", { exact: false })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("There are two ways to fix this.", { exact: false })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Going with option B", { exact: false })).toHaveCount(0)

    // No mention: the answer goes to the agent that asked.
    await compose(page, page.getByLabel("Message", { exact: true }).last(), ["go with option B"])
    await expect(page.getByText("Going with option B", { exact: false })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("PR ready: https://example.com/pr/1", { exact: false })).toBeVisible({ timeout: 30_000 })

    const thread = await apiJson(page, "GET", `/api/conversations/${channelId}/messages?threadRootId=${rootId}`)
    const authors = (thread.json?.messages ?? []).map((m: any) => m.authorAgent?.name ?? m.authorType)
    expect(authors).toEqual([NAMES.scout, NAMES.planner, "user", NAMES.planner, NAMES.builder])
  })

  test("two agents handing work back and forth get paused, and the person is asked to continue", async () => {
    const channelComposer = await openChannelComposer(page, channelId)
    await compose(page, channelComposer, [{ mention: NAMES.writer }, " write the release note for the slugify fix"])

    await openThread(page, channelId, "write the release note")
    // The pause notice shows in the thread and, as a broadcast, in the channel.
    await expect(page.getByText("reply here to continue", { exact: false }).first()).toBeVisible({ timeout: 60_000 })
    const reviews = await page.getByText("The draft also claims", { exact: false }).count()
    expect(reviews).toBeLessThanOrEqual(2)
  })
})
