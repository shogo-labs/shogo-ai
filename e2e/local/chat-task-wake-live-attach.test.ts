// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-31 — an already-open chat window shows a server-initiated wake turn.
 *
 * SHO-30 made the wake reliable: the finished background task queues a
 * `[Task update]` message, the queue dispatcher starts the turn on its 15 s
 * tick, the assistant reply is persisted. This spec covers the other half of
 * the symptom: the window that did NOT post that turn has to render it without
 * a reload.
 *
 *   LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 LOCAL_LLM_BASIC_MODEL=fake-stream \
 *   LOCAL_LLM_ADVANCED_MODEL=fake-stream E2E_LOCAL_START_STACK=1 \
 *   E2E_FAKE_LLM_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-task-wake-live-attach --project chromium --retries 0
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { FakeLlmServer, marker, type FakeTurn } from "../../apps/desktop/e2e/streaming/fake-llm-server"

const API = process.env.E2E_API_URL || "http://localhost:8002"
const LLM_PORT = Number(process.env.E2E_FAKE_LLM_PORT || 18765)
const WAKE_MS = Number(process.env.E2E_WAKE_MS || 120_000)
const LIVE_RENDER_MS = Number(process.env.E2E_LIVE_RENDER_MS || 30_000)

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

test.describe("a server-initiated wake on an open window", () => {
  test("the transcript shows the wake turn without a reload", async () => {
    const sid = await createChat("wake live attach")
    const page = await newWindow(sid)
    const tag = "w1"

    // The fake model runs `exec({command, background: true})`, then ends the
    // turn — the shape Russell reported. From here the window is never touched.
    await send(page, `${marker("bg", tag, 20, { ms: 5, cmd: "sleep 5" })} start the build in the background`)
    await llm.waitForTurn(tag, 90_000)
    await waitForTurnStart(page)
    await waitForIdle(page)

    soft(await countOnScreen(page, "wake-ack"), "nothing has woken the chat yet").toBe(0)

    // No user input from here on: only the API's wake can produce a turn.
    const started = Date.now()
    while (Date.now() - started < WAKE_MS && wakeRequests().length === 0) {
      await page.waitForTimeout(250)
    }
    soft(wakeRequests().length, "the finished task woke the chat on its own (SHO-30)").toBe(1)

    // (a) The wake turn ran and its reply is in the database.
    let persisted = { update: false, reply: false }
    const persistedBy = Date.now() + 60_000
    while (Date.now() < persistedBy && !persisted.reply) {
      persisted = await persistedWakeReply(sid)
      if (!persisted.reply) await page.waitForTimeout(500)
    }
    soft(persisted.update, "(a) the [Task update] message is persisted").toBe(true)
    soft(persisted.reply, "(a) the assistant wake reply is persisted").toBe(true)

    // (b) The window that never reloaded picks it up on its own.
    const liveDeadline = Date.now() + LIVE_RENDER_MS
    let renderedAt: number | null = null
    while (Date.now() < liveDeadline && renderedAt === null) {
      if ((await countOnScreen(page, "wake-ack")) > 0) renderedAt = Date.now()
      else await page.waitForTimeout(250)
    }
    soft(
      renderedAt !== null,
      `(b) an open, untouched window shows the wake reply within ${LIVE_RENDER_MS}ms of it being persisted`,
    ).toBe(true)

    soft(await stopShown(page), "the wake turn finished instead of streaming forever").toBe(false)
  })

  test("a second window on the same chat renders the wake it never posted", async () => {
    const sid = await createChat("wake second window")
    const first = await newWindow(sid)
    const tag = "w2"

    await send(first, `${marker("bg", tag, 20, { ms: 5, cmd: "sleep 5" })} start the build in the background`)
    await llm.waitForTurn(tag, 90_000)
    await waitForTurnStart(first)
    await waitForIdle(first)

    // A window that was not open for the turn: it can only learn about the
    // wake from its own history reload / turn probe.
    const second = await newWindow(sid)
    soft(await countOnScreen(second, "wake-ack"), "the second window has not seen a wake yet").toBe(0)

    const baseline = wakeRequests().length
    const started = Date.now()
    while (Date.now() - started < WAKE_MS && wakeRequests().length <= baseline) {
      await second.waitForTimeout(250)
    }
    soft(wakeRequests().length - baseline, "the finished task woke the chat on its own (SHO-30)").toBe(1)

    const liveDeadline = Date.now() + LIVE_RENDER_MS * 2
    let renderedAt: number | null = null
    while (Date.now() < liveDeadline && renderedAt === null) {
      if ((await countOnScreen(second, "wake-ack")) > 0) renderedAt = Date.now()
      else await second.waitForTimeout(250)
    }
    soft(renderedAt !== null, "(b) the second, untouched window shows the wake reply").toBe(true)
    // One row, not one per window: the reload must replace the transcript, not
    // replay the wake into it.
    soft(await countOnScreen(second, "wake-ack"), "the wake reply is rendered once").toBe(1)
    await second.close()
  })

  test("an idle chat with nothing running stops asking", async () => {
    const sid = await createChat("wake idle")
    const page = await newWindow(sid)
    const asked: string[] = []
    page.on("request", (request) => {
      const url = request.url()
      if (/\/(tasks|processes|turn)(\?|$)/.test(url)) asked.push(url)
    })

    // Let the mount probes settle, then watch a window with no background work
    // at all: the wake watch must not be armed, or every idle chat polls.
    await page.waitForTimeout(6_000)
    asked.length = 0
    await page.waitForTimeout(12_000)
    soft(asked.length, `an idle chat made ${asked.length} task/turn requests in 12s`).toBe(0)
  })
})
