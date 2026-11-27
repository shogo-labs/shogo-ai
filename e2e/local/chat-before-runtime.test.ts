// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-605 — a project chat paints its saved messages before its runtime is up.
 *
 * The project page used to gate itself on `runtimeReady`, so a cold runtime
 * blanked the whole screen — chat history included — for the eight seconds
 * `/sandbox/url` takes (and for the 60–147 s cold starts in the API log). The
 * chat's history is API-only, so the gate now belongs to the right panel
 * (canvas / files / IDE) only, and this spec is the regression proof:
 *
 *   AC1 — with `/sandbox/url` answering `ready:false`, the transcript paints
 *         straight away and the composer says the agent is starting.
 *   AC2 — the right panel shows `RuntimeStartingPane` until the runtime is
 *         ready, then hands the panel back.
 *   AC3 — a message typed while the runtime boots is queued, and goes out
 *         exactly once after `ready:true`.
 *   AC5 — this is that regression test: on the old gate the transcript is
 *         never visible while `/sandbox/url` says not-ready.
 *
 * Driven through the real UI against the real local API; only the runtime URL
 * and the chat turn are stubbed, exactly as `chat-composer-memory.test.ts`
 * does.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-before-runtime --project chromium --retries 0
 */
import { expect, test, type Page } from "@playwright/test"
import { writeActiveWorkspaceSelection } from "./helpers"

const API = process.env.E2E_API_URL || "http://localhost:8002"

let workspaceId = ""
let projectId = ""

/** Flipped by a test to let `/sandbox/url` report `ready:true`. */
let runtimeReady = false
/** Every `/sandbox/url` answer, so a test can prove the chat beat them. */
const sandboxAnswers: Array<{ at: number; ready: boolean }> = []

async function apiJson(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(`${API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    data: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status(), json }
}

/**
 * The project runtime, held cold until a test says otherwise. The real local
 * stack has no runtime template, so the ready answer points at a stub; the
 * not-ready answer is what the old page gate waited on.
 */
async function holdRuntimeCold(page: Page) {
  await page.route("**/api/projects/*/sandbox/url", async (route) => {
    if (runtimeReady) {
      sandboxAnswers.push({ at: Date.now(), ready: true })
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ready: true,
          status: "running",
          agentUrl: `${API}/stub-agent`,
          url: `${API}/stub-preview`,
          canvasBaseUrl: `${API}/stub-preview`,
        }),
      })
      return
    }
    sandboxAnswers.push({ at: Date.now(), ready: false })
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ready: false, status: "starting" }),
    })
  })
  await page.route("**/api/projects/*/agent-proxy/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  )
}

function completedTurn(text: string): string {
  const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`
  return [
    frame({ type: "start", messageId: `sho605_msg_${Date.now()}` }),
    frame({ type: "start-step" }),
    frame({ type: "text-start", id: "sho605_text" }),
    frame({ type: "text-delta", id: "sho605_text", delta: text }),
    frame({ type: "text-end", id: "sho605_text" }),
    frame({ type: "finish-step" }),
    frame({ type: "finish" }),
  ].join("")
}

/** The text of the last user message a chat turn POST carried. */
function lastUserText(body: any): string {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : []
  const last = [...messages].reverse().find((m) => m?.role === "user")
  const parts: any[] = Array.isArray(last?.parts) ? last.parts : []
  const text = parts
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("")
  return text.trim()
}

/**
 * Answer every chat turn locally and record what the composer sent, plus every
 * `/agent/chat` POST seen on the wire (AC3: none before `ready:true`).
 */
async function mockChatTurns(page: Page) {
  const turns: Array<{ at: number; text: string; body: any }> = []
  const agentChatPosts: number[] = []

  await page.route("**/api/{projects,workspaces}/*/chat", async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    let body: any = {}
    try {
      body = route.request().postDataJSON() ?? {}
    } catch {
      body = {}
    }
    turns.push({ at: Date.now(), text: lastUserText(body), body })
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: completedTurn("Noted."),
    })
  })
  // The live-turn probe the composer runs before sending, and the in-panel
  // probe after history loads.
  for (const glob of ["**/api/projects/*/chat/*/turn", "**/api/workspaces/*/chat/*/turn"]) {
    await page.route(glob, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "completed" }),
      }),
    )
  }
  page.on("request", (request) => {
    if (request.method() !== "POST") return
    if (/\/agent\/chat(\/|$)/.test(new URL(request.url()).pathname)) {
      agentChatPosts.push(Date.now())
    }
  })

  return { turns, agentChatPosts }
}

const composerInput = (page: Page) =>
  page.getByTestId("project-composer-input").filter({ visible: true }).first()

/** Open the app once so the workspace selection sticks for the project route. */
async function prepare(page: Page) {
  page.on("pageerror", (error) =>
    console.log("PAGEERROR", (error as Error)?.stack ?? String(error)),
  )
  await holdRuntimeCold(page)
  await page.goto("/")
  await page.getByRole("navigation", { name: "App sidebar" }).first().waitFor({
    timeout: 120_000,
  })
  await page.evaluate(writeActiveWorkspaceSelection, [workspaceId, "team"] as const)
}

function projectUrl(chatSessionId: string): string {
  return `/projects/${projectId}?chatSessionId=${chatSessionId}`
}

let chatToken = 0

/** A fresh chat on the project with one saved message on each side. */
async function makeChatWithHistory(
  page: Page,
  marker: string,
): Promise<{ id: string }> {
  chatToken += 1
  const name = `SHO-605 chat ${Date.now().toString(36)}${chatToken}`
  const created = await apiJson(page, "POST", "/api/chat-sessions", {
    contextId: projectId,
    contextType: "project",
    inferredName: name,
    name,
  })
  const id = created.json?.data?.id ?? created.json?.id
  expect(id, JSON.stringify(created.json)).toBeTruthy()

  const seed = async (role: "user" | "assistant", content: string) => {
    const seeded = await apiJson(page, "POST", "/api/chat-messages", {
      sessionId: id,
      role,
      content,
      // The same shape the turn machinery writes; a null `parts` crashes the
      // panel on render.
      parts: JSON.stringify([{ type: "text", text: content }]),
    })
    expect(seeded.status, JSON.stringify(seeded.json)).toBeLessThan(300)
  }
  await seed("user", marker)
  await seed("assistant", `Saved reply to ${marker}`)
  return { id: id as string }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000)
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto("/")
  await page.getByRole("navigation", { name: "App sidebar" }).first().waitFor({
    timeout: 120_000,
  })

  const suffix = Date.now().toString(36)
  const workspace = await apiJson(page, "POST", "/api/workspaces", {
    name: `QA chat before runtime ${suffix}`,
    kind: "team",
  })
  workspaceId = workspace.json?.data?.id ?? workspace.json?.id
  expect(workspaceId, JSON.stringify(workspace.json)).toBeTruthy()

  const project = await apiJson(page, "POST", "/api/projects", {
    name: `QA chat before runtime ${suffix}`,
    workspaceId,
    tier: "starter",
    status: "draft",
    accessLevel: "anyone",
    schemas: [],
    settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
  })
  projectId = project.json?.data?.id ?? project.json?.id
  expect(projectId, JSON.stringify(project.json)).toBeTruthy()

  await page.close()
})

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  if (projectId) await page.request.delete(`${API}/api/projects/${projectId}`).catch(() => {})
  if (workspaceId) await page.request.delete(`${API}/api/workspaces/${workspaceId}`).catch(() => {})
  await page.close()
})

test("AC1/AC2/AC5: saved messages paint while the runtime is still booting", async ({
  page,
}) => {
  test.setTimeout(300_000)
  const marker = `MARKER-BEFORE-RUNTIME-${Date.now().toString(36)}`
  runtimeReady = false
  await mockChatTurns(page)
  await prepare(page)
  // Seeded after `prepare` so the sidebar/collection this page load sees is
  // the one the project route opens.
  const chat = await makeChatWithHistory(page, marker)

  // Warm the `/projects/:id` route (Metro compiles it on first use) while the
  // runtime answers ready, so the measurement below is the project open, not a
  // one-time bundle compile.
  runtimeReady = true
  await page.goto(projectUrl(chat.id))
  await composerInput(page).waitFor({ state: "visible", timeout: 120_000 })
  await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({
    timeout: 60_000,
  })

  /** Reload this document and time the transcript from its own navigation start. */
  async function reloadAndTimePaint(): Promise<number> {
    await page.reload()
    await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    })
    return Math.round(await page.evaluate(() => performance.now()))
  }

  // Baseline: the same document, the same route and the same API calls, with
  // the runtime ready — measured here, on this machine, in this run.
  const readyPaintMs = await reloadAndTimePaint()

  // Cold again: no `/sandbox/url` answer may say ready from here on.
  runtimeReady = false
  sandboxAnswers.length = 0
  const bootPaintMs = await reloadAndTimePaint()

  // AC5's teeth: with the old whole-page gate the transcript could not appear
  // until `ready:true`, which this test never sends before the assertion — the
  // reload above would have thrown at 30 s, and the cold paint would then carry
  // the whole cold start on top of the baseline. Both numbers come from the same
  // document on the same runner, so how fast that runner is cancels out.
  expect(sandboxAnswers.filter((answer) => answer.ready)).toHaveLength(0)

  // AC1: the composer owns up to the boot, in its own placeholder — no extra
  // row above it, so the transcript does not shift when the boot ends.
  await expect(composerInput(page)).toBeVisible({ timeout: 10_000 })
  await expect(composerInput(page)).toHaveAttribute(
    "placeholder",
    /Starting agent…/,
    { timeout: 10_000 },
  )

  // AC2: every panel that needs `agentUrl` is replaced by the pane.
  await expect(page.getByTestId("runtime-starting-pane")).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByText("Starting your project…", { exact: true })).toBeVisible()

  // Holding the runtime cold must not cost the chat paint anything: on the old
  // gate this number was the whole cold start (10.5 s against a 1.8 s baseline).
  console.log(`SHO-605 chat paint: ${readyPaintMs} ms ready / ${bootPaintMs} ms booting`)
  expect(bootPaintMs).toBeLessThan(readyPaintMs * 1.5 + 500)

  // AC2: once the runtime is ready the pane hands the right panel back.
  runtimeReady = true
  await expect(page.getByTestId("runtime-starting-pane")).toBeHidden({
    timeout: 60_000,
  })
  await expect(composerInput(page)).not.toHaveAttribute(
    "placeholder",
    /Starting agent…/,
    { timeout: 60_000 },
  )
})

test("AC3: a send while the runtime starts is queued, then goes out exactly once", async ({
  page,
}) => {
  test.setTimeout(300_000)
  const marker = `MARKER-QUEUED-SEND-${Date.now().toString(36)}`
  runtimeReady = false
  const { turns, agentChatPosts } = await mockChatTurns(page)
  await prepare(page)
  const chat = await makeChatWithHistory(page, marker)

  await page.goto(projectUrl(chat.id))
  await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByTestId("runtime-starting-pane")).toBeVisible({
    timeout: 30_000,
  })

  const sent = `queued while booting ${Date.now().toString(36)}`
  await composerInput(page).click()
  await composerInput(page).fill(sent)
  await page.keyboard.press("Enter")

  // The row explains the wait, and nothing went out yet — not to the chat
  // route, and not to the runtime's own `/agent/chat`.
  await expect(page.getByText("Waiting for the agent to start…").first()).toBeVisible({
    timeout: 15_000,
  })
  expect(turns).toHaveLength(0)
  expect(agentChatPosts).toHaveLength(0)

  // Ready: the queued row drains exactly once and its reply streams in.
  runtimeReady = true
  await expect
    .poll(() => turns.length, { timeout: 60_000 })
    .toBe(1)
  expect(turns[0]!.text).toContain(sent)
  await expect(page.getByText("Noted.", { exact: false }).first()).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByText("Waiting for the agent to start…")).toHaveCount(0)
  expect(turns).toHaveLength(1)
})
