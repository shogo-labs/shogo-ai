// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-299 — a chat open in two windows stays in step.
 *
 * Russell: with a chat open in tab 1 he opened the same chat in tab 2 and sent
 * messages there; tab 1 never showed them. Two things were wrong:
 *
 *  - nothing told an idle panel that a turn had started somewhere else. The
 *    API now publishes `chat-session.turn` (`started` / `ended`) at the
 *    turn-state insert point, and every open window hears it. The first spec
 *    below is that push: tab 1 is never focused, clicked or reloaded, and it
 *    still renders tab 2's prompt and streams the reply.
 *  - the refocus repaint refused an ordinary turn: an unseen assistant tail
 *    was painted only when the tail still awaited its reply, so a window that
 *    came back to a finished turn kept the old transcript. The second spec
 *    withholds the push from one window (its realtime connection never
 *    connects) and proves the refocus catch-up paints a plain chat — one that
 *    never had a `[Task update]`, channel or delegated row.
 *
 *   LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 LOCAL_LLM_BASIC_MODEL=fake-stream \
 *   LOCAL_LLM_ADVANCED_MODEL=fake-stream E2E_LOCAL_START_STACK=1 \
 *   E2E_FAKE_LLM_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-two-window-sync --project chromium --retries 0
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { FakeLlmServer, marker, token } from "../../apps/desktop/e2e/streaming/fake-llm-server"

const API = process.env.E2E_API_URL || "http://localhost:8002"
const LLM_PORT = Number(process.env.E2E_FAKE_LLM_PORT || 18765)
/** Budget for a pushed turn to reach the other window; CI runners are slow, the path is one event. */
const PUSH_RENDER_MS = Number(process.env.E2E_PUSH_RENDER_MS || 25_000)

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

async function openProject(page: Page, sessionId: string): Promise<Page> {
  await page.goto(`/projects/${encodeURIComponent(projectOf.get(sessionId)!)}`)
  const switchToText = page.getByText("Switch to text input", { exact: true })
  if (await switchToText.isVisible().catch(() => false)) await switchToText.click()
  await expect(composer(page)).toBeVisible({ timeout: 120_000 })
  return page
}

async function newWindow(sessionId: string): Promise<Page> {
  return openProject(await context.newPage(), sessionId)
}

/**
 * A window that will never hear the push: its realtime socket and SSE channel
 * are refused before the app boots, so the turn can only reach it through the
 * refocus catch-up. That is the SHO-53 path — the one SHO-299 had to stop
 * refusing for an ordinary turn.
 */
async function newWindowWithoutRealtime(sessionId: string): Promise<Page> {
  const page = await context.newPage()
  await page.routeWebSocket(/\/api\/workspaces\/[^/]+\/rt/, (ws) => ws.close())
  await page.route(/\/api\/workspaces\/[^/]+\/conversations\/events/, (route) => route.abort())
  return openProject(page, sessionId)
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

async function waitForIdle(page: Page, timeoutMs = 90_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs && (await stopShown(page))) await page.waitForTimeout(200)
}

async function waitForTurnStart(page: Page, timeoutMs = 90_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs && !(await stopShown(page))) await page.waitForTimeout(100)
  await page.waitForTimeout(500)
}

/**
 * Bring the window back to the person. `bringToFront` is a real activation,
 * but a headless runner has no window manager to hand the page the events the
 * app listens for, so deliver the same `focus` / `visibilitychange` pair the
 * browser would.
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

test.describe("a chat open in two windows", () => {
  test("the window that did not send renders the other window's turn as it happens", async () => {
    const sid = await createChat("two windows live")
    const tab1 = await newWindow(sid)
    const tab2 = await newWindow(sid)
    await tab2.bringToFront()
    // Let tab1's mount probes settle, so nothing below can be mistaken for a
    // refocus catch-up: the window is never brought forward again.
    await tab1.waitForTimeout(6_000)

    const prompt = `hello from tab 2 ${Date.now()}`
    const tag = "w1"
    const tokens = 100
    await send(tab2, `${prompt} ${marker("long", tag, tokens, { ms: 100 })}`)
    await llm.waitForTurn(tag, 90_000)

    // Nothing is sent to tab1 from here: no focus, no click, no reload. The
    // pushed `chat-session.turn` event is the only thing that can tell it.
    await expect
      .poll(() => countOnScreen(tab1, prompt), {
        timeout: PUSH_RENDER_MS,
        message: "tab 1 shows tab 2's prompt without being touched",
      })
      .toBe(1)
    await expect
      .poll(() => stopShown(tab1), {
        timeout: PUSH_RENDER_MS,
        message: "tab 1 is streaming tab 2's reply, not waiting for one",
      })
      .toBe(true)

    await waitForIdle(tab2)
    const reply = token(tag, tokens)
    await expect
      .poll(() => countOnScreen(tab1, reply), {
        timeout: PUSH_RENDER_MS,
        message: "tab 1 ends with the finished reply",
      })
      .toBe(1)

    // Both windows show one transcript, and the sender was not disturbed: no
    // duplicate prompt, no second attach, no reply painted twice.
    soft(await countOnScreen(tab1, prompt), "tab 1 shows the prompt once").toBe(1)
    soft(await countOnScreen(tab1, reply), "tab 1 shows the reply once").toBe(1)
    soft(await countOnScreen(tab2, prompt), "tab 2 shows its own prompt once").toBe(1)
    soft(await countOnScreen(tab2, reply), "tab 2 shows the reply once").toBe(1)
    soft(await stopShown(tab2), "tab 2 is idle again").toBe(false)

    await tab1.close()
    await tab2.close()
  })

  test("a window that never heard the turn paints it on refocus (an ordinary chat)", async () => {
    const sid = await createChat("two windows refocus")
    // Opened first, and deaf: no realtime, so the only way this window learns
    // about the turn is the refocus repaint — the path SHO-299 unblocked for an
    // ordinary turn. This chat has no delegated, channel or `[Task update]` row.
    const behind = await newWindowWithoutRealtime(sid)
    const tab2 = await newWindow(sid)
    await tab2.bringToFront()
    await behind.waitForTimeout(6_000)

    const prompt = `said while you were behind ${Date.now()}`
    const tag = "w2"
    const tokens = 20
    await send(tab2, `${prompt} ${marker("long", tag, tokens, { ms: 20 })}`)
    await llm.waitForTurn(tag, 90_000)
    await waitForTurnStart(tab2)
    await waitForIdle(tab2)

    const reply = token(tag, tokens)
    soft(
      await countOnScreen(behind, prompt),
      "the deaf window has not seen the prompt yet (nothing was pushed to it)",
    ).toBe(0)

    await refocus(behind)
    await expect
      .poll(() => countOnScreen(behind, prompt), {
        timeout: PUSH_RENDER_MS,
        message: "the refocus paints the prompt another window sent",
      })
      .toBe(1)
    await expect
      .poll(() => countOnScreen(behind, reply), {
        timeout: PUSH_RENDER_MS,
        message: "the refocus paints the finished reply, not just the prompt",
      })
      .toBe(1)

    soft(await countOnScreen(behind, prompt), "the prompt is not duplicated").toBe(1)
    soft(await countOnScreen(behind, reply), "the reply is not duplicated").toBe(1)

    await behind.close()
    await tab2.close()
  })
})
