// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A finished background task resumes its chat on its own (SHO-30).
 *
 * The agent starts a background `exec`, says it will report back, and the turn
 * ends. When the command finishes, the API has to wake the chat — no user
 * message, no reload. It fails when the wake is lost between the task settling
 * and the queued message being dispatched (dropped notify, a dispatch the
 * runtime refused, the pause after several wakes in a row).
 *
 * Runs the real local API + agent runtime against the scripted fake model, so
 * start the stack pointed at the fake model's port first (CI does this):
 *
 *   LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 LOCAL_LLM_BASIC_MODEL=fake-stream \
 *   LOCAL_LLM_ADVANCED_MODEL=fake-stream E2E_LOCAL_START_STACK=1 \
 *   E2E_FAKE_LLM_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-task-resume --project chromium --retries 0
 *
 * Checks are soft, so one run lists every way the scenario goes wrong.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { FakeLlmServer, marker, type FakeTurn } from "../../apps/desktop/e2e/streaming/fake-llm-server"

const API = process.env.E2E_API_URL || "http://localhost:8002"
const LLM_PORT = Number(process.env.E2E_FAKE_LLM_PORT || 18765)
/** How long the wake may take: the task, the coalesce window and a drain tick. */
const WAKE_MS = Number(process.env.E2E_WAKE_MS || 120_000)

const soft = expect.configure({ soft: true })

// Needs the API pointed at the fake model, which would change every other
// local spec; CI runs it in its own job (ci.yml "E2E (chat resume)").
test.skip(
  process.env.E2E_FAKE_LLM_STACK !== "1",
  "needs an API started with LOCAL_LLM_BASE_URL pointing at the fake model (see the header); set E2E_FAKE_LLM_STACK=1",
)

test.setTimeout(300_000)

let llm: FakeLlmServer
let context: BrowserContext
let baseURL: string
let workspaceId: string
const projectOf = new Map<string, string>()

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(360_000)
  llm = new FakeLlmServer()
  await llm.start(LLM_PORT)
  baseURL = String(info.project.use.baseURL)
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

// ── API helpers (run in Node with the browser context's session cookie) ─────

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

/** A new project, opened once so the app creates its chat, then closed again. */
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

// ── Window helpers ──────────────────────────────────────────────────────────

const composer = (page: Page) => page.getByTestId("project-composer-input").filter({ visible: true }).first()

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

/** A Stop button the user can see (hidden chat tabs stay mounted at opacity 0). */
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

/** How many times `needle` appears in the rendered transcript. */
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

/** The wake turn reached the model, so the whole chain ran, not just a repaint. */
function wakeRequests(): FakeTurn[] {
  return llm.turns.filter((t) => t.userText.includes("[Task update]"))
}

/** How many times the model answered an auto-resumed wake turn on screen. */
async function wakeRepliesOnScreen(page: Page): Promise<number> {
  return countOnScreen(page, "wake-ack")
}

// ── Scenario ────────────────────────────────────────────────────────────────

test.describe("background task resume", () => {
  test("a finished background command wakes the chat without a message", async () => {
    const sid = await createChat("task resume")
    const page = await newWindow(sid)
    const tag = "bg1"
    const command = "sleep 4"

    // The fake model runs `exec({command, background: true})`, then says it
    // will report back — the shape Russell reported.
    await send(page, `${marker("bg", tag, 20, { ms: 5, cmd: command })} start the build in the background`)
    await llm.waitForTurn(tag, 90_000)
    await waitForIdle(page)

    soft(await wakeRepliesOnScreen(page), "nothing has woken the chat yet").toBe(0)
    const scripted = llm.turns.filter((t) => t.script === "bg").length
    soft(scripted, "the agent ran the scripted background turn").toBeGreaterThan(0)

    // No user input from here on: only the API's wake can produce a turn.
    const started = Date.now()
    while (Date.now() - started < WAKE_MS && wakeRequests().length === 0) {
      await page.waitForTimeout(250)
    }

    soft(wakeRequests().length, "the finished task woke the chat on its own").toBe(1)

    // The resumed turn is in the transcript the next time the chat is read.
    await page.reload()
    await expect(composer(page)).toBeVisible({ timeout: 120_000 })
    const shown = Date.now()
    while (Date.now() - shown < 30_000 && (await wakeRepliesOnScreen(page)) === 0) {
      await page.waitForTimeout(250)
    }
    soft(await wakeRepliesOnScreen(page), "the resumed turn is in the transcript").toBe(1)

    // One wake, not one per drain tick.
    await page.waitForTimeout(16_000)
    soft(wakeRequests().length, "the chat was woken once, not once per drain tick").toBe(1)
    soft(await stopShown(page), "the wake turn finished instead of streaming forever").toBe(false)
  })
})
