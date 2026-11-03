// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-53 — a chat that was in the background when its wake turn ran repaints
 * when it comes back, without a reload.
 *
 * SHO-31 (`chat-task-wake-live-attach`) covers the window that is in front and
 * untouched: its wake watch is armed by the turn that started the background
 * task, so it picks the wake up on its own. This spec covers the residual: a
 * window that sat behind another window while the wake ran. It watches
 * nothing (the wake watch only runs for an active panel), and by the time it
 * is looked at again the turn reads `completed`, which the attach path treats
 * as "history is enough" — history this window has never loaded.
 *
 *   LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 LOCAL_LLM_BASIC_MODEL=fake-stream \
 *   LOCAL_LLM_ADVANCED_MODEL=fake-stream E2E_LOCAL_START_STACK=1 \
 *   E2E_FAKE_LLM_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-task-wake-refocus --project chromium --retries 0
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { FakeLlmServer, marker, type FakeTurn } from "../../apps/desktop/e2e/streaming/fake-llm-server"

const API = process.env.E2E_API_URL || "http://localhost:8002"
const LLM_PORT = Number(process.env.E2E_FAKE_LLM_PORT || 18765)
const WAKE_MS = Number(process.env.E2E_WAKE_MS || 120_000)
/** The same budget SHO-31 gives the front window; a refocus must not be slower. */
const LIVE_RENDER_MS = Number(process.env.E2E_LIVE_RENDER_MS || 25_000)

const soft = expect.configure({ soft: true })

test.skip(
  process.env.E2E_FAKE_LLM_STACK !== "1",
  "needs an API started with LOCAL_LLM_BASE_URL pointing at the fake model (see the header); set E2E_FAKE_LLM_STACK=1",
)

test.setTimeout(300_000)

let llm: FakeLlmServer
let context: BrowserContext
let workspaceId: string
const projectOf = new Map<string, string>()

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(360_000)
  llm = new FakeLlmServer()
  await llm.start(LLM_PORT)
  const baseURL = String(info.project.use.baseURL)
  context = await browser.newContext({ baseURL })
  const signIn = await context.request.post(`${API}/api/local/auto-sign-in`)
  if (!signIn.ok()) throw new Error(`auto-sign-in failed (${signIn.status()}): ${await signIn.text()}`)
  await context.request.post(`${API}/api/onboarding/complete`)

  const models = await apiJson<any>("GET", "/api/local/models")
  if (!models?.ok || !(models.models ?? []).some((m: any) => m?.id === "fake-stream")) {
    throw new Error(
      `the API is not using the fake model on :${LLM_PORT} (GET /api/local/models: ${JSON.stringify(models).slice(0, 200)}); ` +
        `start it with LOCAL_LLM_BASE_URL=http://127.0.0.1:${LLM_PORT} LOCAL_LLM_BASIC_MODEL=fake-stream LOCAL_LLM_ADVANCED_MODEL=fake-stream`,
    )
  }

  const workspaces = await apiJson<any>("GET", "/api/workspaces")
  const list: any[] = workspaces?.items ?? workspaces?.data ?? workspaces ?? []
  const workspace = list.find((w) => w?.kind === "team") ?? list[0]
  if (!workspace?.id) throw new Error(`no workspace: ${JSON.stringify(workspaces).slice(0, 300)}`)
  workspaceId = workspace.id
})

test.afterAll(async () => {
  await context?.close()
  await llm?.stop()
})

async function apiJson<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await context.request.fetch(`${API}${route}`, {
    method,
    data: body,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
  })
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

const composer = (page: Page) => page.getByTestId("project-composer-input").filter({ visible: true }).first()

async function createChat(name: string): Promise<string> {
  const created = await apiJson<any>("POST", "/api/projects", {
    name: `${name} ${Date.now()}`,
    workspaceId,
    tier: "starter",
    status: "draft",
    accessLevel: "anyone",
  })
  const projectId: string | undefined = created?.data?.id ?? created?.id
  if (!projectId) throw new Error(`project create failed: ${JSON.stringify(created).slice(0, 300)}`)
  const page = await context.newPage()
  await page.goto(`/projects/${encodeURIComponent(projectId)}`)
  await expect(composer(page)).toBeVisible({ timeout: 120_000 })
  const deadline = Date.now() + 60_000
  let sessionId: string | undefined
  while (!sessionId && Date.now() < deadline) {
    const res = await apiJson<any>("GET", `/api/chat-sessions?contextId=${encodeURIComponent(projectId)}`)
    sessionId = (res?.items ?? []).find((s: any) => s.contextType === "workspace" && s.workspaceId)?.id
    if (!sessionId) await page.waitForTimeout(500)
  }
  await page.close()
  if (!sessionId) throw new Error(`project ${projectId} never got a chat`)
  projectOf.set(sessionId, projectId)
  return sessionId
}

async function newWindow(sessionId: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`/projects/${encodeURIComponent(projectOf.get(sessionId)!)}`)
  const switchToText = page.getByText("Switch to text input", { exact: true })
  if (await switchToText.isVisible().catch(() => false)) await switchToText.click()
  await expect(composer(page)).toBeVisible({ timeout: 120_000 })
  return page
}

async function send(page: Page, text: string): Promise<void> {
  const input = composer(page)
  await input.click()
  await input.fill(text)
  await page.keyboard.press("Enter")
}

async function stopShown(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('[data-testid="stop-streaming"]'))) {
      let node: Element | null = el
      let hidden = false
      while (node) {
        const style = getComputedStyle(node)
        if (style.opacity === "0" || style.display === "none" || style.visibility === "hidden") {
          hidden = true
          break
        }
        node = node.parentElement
      }
      if (!hidden) return true
    }
    return false
  })
}

async function countOnScreen(page: Page, needle: string): Promise<number> {
  return page.evaluate((n) => {
    const text = document.body?.innerText ?? ""
    let count = 0
    let from = 0
    for (;;) {
      const at = text.indexOf(n, from)
      if (at === -1) return count
      count++
      from = at + n.length
    }
  }, needle)
}

async function waitForIdle(page: Page, timeoutMs = 60_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs && (await stopShown(page))) await page.waitForTimeout(200)
}

async function waitForTurnStart(page: Page, timeoutMs = 60_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs && !(await stopShown(page))) await page.waitForTimeout(100)
  await page.waitForTimeout(500)
}

function wakeRequests(): FakeTurn[] {
  return llm.turns.filter((t) => t.userText.includes("[Task update]"))
}

async function persistedWakeReply(sessionId: string): Promise<{ update: boolean; reply: boolean }> {
  const messages = await apiJson<any>("GET", `/api/chat-messages?sessionId=${encodeURIComponent(sessionId)}`)
  const items: any[] = messages?.items ?? messages?.data ?? messages ?? []
  const updateAt = items.findIndex(
    (m) => m?.role === "user" && String(m?.content ?? "").includes("[Task update]"),
  )
  const reply =
    updateAt >= 0 &&
    items.some((m, index) => index > updateAt && m?.role === "assistant" && String(m?.content ?? "").includes("wake-ack"))
  return { update: updateAt >= 0, reply }
}

/** Every task/turn request this window made, from now on. */
function watchWakeRequests(page: Page): string[] {
  const seen: string[] = []
  page.on("request", (request) => {
    const url = request.url()
    if (/\/(tasks|processes|turn)(\?|$)/.test(url)) seen.push(url)
  })
  return seen
}

/** Every /api/chat-messages request this window made, from now on. */
function watchHistoryRequests(page: Page): string[] {
  const seen: string[] = []
  page.on("request", (request) => {
    const url = request.url()
    if (url.includes("/api/chat-messages")) seen.push(url)
  })
  return seen
}

/** Requests the panel makes on its own after a turn, plus the refocus probes. */
const CHAT_TRAFFIC = /\/api\/chat-messages|\/(tasks|processes|turn)(\?|$)/

/**
 * Wait until the window stops talking to the chat endpoints on its own.
 *
 * A finished turn keeps the panel busy for a while — four `/turn` probes, then
 * a history refresh of its own. The gaps between those requests are fixed but
 * their latencies are the runner's, so "sleep 13s and count from there" is a
 * wall-clock guess: on a loaded runner the last of them lands inside the
 * counted window and the refocus gets blamed for a fetch it did not make
 * (SHO-134 — `chat-task-wake-refocus:305 (c)` red on a run where it is green
 * on the next). Measure the settle instead of assuming it.
 *
 * `quietMs` must outlast the widest gap in that schedule (~4s between the
 * third and fourth probe), or the wait settles inside it and the next probe
 * lands in the window anyway.
 */
async function waitForChatQuiet(page: Page, quietMs = 6_000, deadlineMs = 120_000): Promise<boolean> {
  let lastAt = Date.now()
  page.on("request", (request) => {
    if (CHAT_TRAFFIC.test(request.url())) lastAt = Date.now()
  })
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    if (Date.now() - lastAt >= quietMs) return true
    await page.waitForTimeout(100)
  }
  return false
}

/**
 * Bring the window back to the person. `bringToFront` is a real activation,
 * but a headless runner has no window manager to hand the page the events the
 * app listens for, so deliver the same `focus` / `visibilitychange` pair the
 * browser would (the panel arms on either, and throttles the pair to one
 * check).
 */
async function refocus(page: Page): Promise<void> {
  await page.bringToFront()
  await page.evaluate(() => {
    if (document.visibilityState !== "visible") {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
    }
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("focus"))
  })
}

test.describe("a chat that was in the background when its wake ran", () => {
  test("repaints the wake reply on refocus without a reload", async () => {
    const sid = await createChat("wake refocus")
    // The window that posts the turn, and a second window on the same chat
    // that never does — it is opened first so it is already mounted (and
    // armed by nothing) when the wake runs.
    const first = await newWindow(sid)
    const background = await newWindow(sid)
    await first.bringToFront()
    // Let the background window's mount probes settle before counting: what
    // matters is that it asks for nothing from here on.
    await background.waitForTimeout(6_000)
    const asked = watchWakeRequests(background)
    const tag = "r1"

    await send(first, `${marker("bg", tag, 20, { ms: 5, cmd: "sleep 5" })} start the build in the background`)
    await llm.waitForTurn(tag, 90_000)
    await waitForTurnStart(first)
    await waitForIdle(first)

    soft(await countOnScreen(background, "wake-ack"), "the background window has not seen a wake yet").toBe(0)
    asked.length = 0

    // The wake runs while the background window is behind the first one.
    const started = Date.now()
    while (Date.now() - started < WAKE_MS && wakeRequests().length === 0) {
      await background.waitForTimeout(250)
    }
    soft(wakeRequests().length, "the finished task woke the chat on its own (SHO-30)").toBe(1)

    // (a) The wake turn ran and its reply is in the database.
    let persisted = { update: false, reply: false }
    const persistedBy = Date.now() + 60_000
    while (Date.now() < persistedBy && !persisted.reply) {
      persisted = await persistedWakeReply(sid)
      if (!persisted.reply) await background.waitForTimeout(500)
    }
    soft(persisted.update, "(a) the [Task update] message is persisted").toBe(true)
    soft(persisted.reply, "(a) the assistant wake reply is persisted").toBe(true)

    // Nothing ran in this window while it was away: no watch, no polling.
    soft(
      asked.length,
      `(c) the background window made ${asked.length} task/turn requests while it was away`,
    ).toBe(0)

    // (b) Coming back repaints it — no reload.
    await refocus(background)
    const liveDeadline = Date.now() + LIVE_RENDER_MS
    let renderedAt: number | null = null
    while (Date.now() < liveDeadline && renderedAt === null) {
      if ((await countOnScreen(background, "wake-ack")) > 0) renderedAt = Date.now()
      else await background.waitForTimeout(250)
    }
    soft(
      renderedAt !== null,
      `(b) the window that was in the background shows the wake reply within ${LIVE_RENDER_MS}ms of refocus`,
    ).toBe(true)
    soft(await countOnScreen(background, "wake-ack"), "the wake reply is rendered once").toBe(1)

    // The catch-up is one-shot: a refocus, not the start of a poll.
    const turned = asked.filter((url) => /\/turn(\?|$)/.test(url)).length
    soft(turned, `(d) a refocus probes /turn once, not ${turned} times`).toBeLessThanOrEqual(1)
    soft(
      asked.filter((url) => /\/(tasks|processes)(\?|$)/.test(url)).length,
      "(d) a refocus does not start watching the task list",
    ).toBe(0)
    await background.waitForTimeout(8_000)
    soft(
      asked.filter((url) => /\/turn(\?|$)/.test(url)).length,
      "(d) the catch-up stops after the one probe",
    ).toBe(turned)

    await background.close()
  })

  test("a refocus on a chat that is already up to date leaves it alone", async () => {
    const sid = await createChat("wake settled")
    const page = await newWindow(sid)
    const prompt = "just a normal message"

    await send(page, prompt)
    await waitForTurnStart(page)
    await waitForIdle(page)
    soft(await countOnScreen(page, prompt), "the chat has an answered turn").toBe(1)

    // A finished turn keeps the panel busy on its own: four `/turn` probes over
    // ~10.5s, then a history refresh. Wait for that traffic to stop rather than
    // guessing how long the runner needs for it, so what is counted below is
    // the refocus and nothing else. A panel that never stops asking is itself
    // the bug this spec guards, so that fails here by name.
    expect(
      await waitForChatQuiet(page),
      "the chat stops its own post-turn traffic on its own",
    ).toBe(true)
    const asked = watchWakeRequests(page)
    const history = watchHistoryRequests(page)
    await refocus(page)
    await page.waitForTimeout(8_000)

    soft(
      asked.filter((url) => /\/turn(\?|$)/.test(url)).length,
      "(c) a settled chat costs at most the single /turn probe on refocus",
    ).toBeLessThanOrEqual(1)
    soft(
      asked.filter((url) => /\/(tasks|processes)(\?|$)/.test(url)).length,
      "(c) a settled chat issues no task-list requests on refocus",
    ).toBe(0)
    const refetched = history.filter((url) => !url.includes("limit=1"))
    soft(
      refetched.length,
      `(c) a settled chat does not refetch the transcript on refocus (saw ${refetched.join(" ") || "none"})`,
    ).toBe(0)
    soft(await countOnScreen(page, prompt), "the transcript is untouched").toBe(1)
  })
})
