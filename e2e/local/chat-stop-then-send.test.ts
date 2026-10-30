// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Stop, then send.
 *
 * Stop used to be treated as "this turn never finished": the partial reply was
 * dropped from the transcript on the next replay, and the message sent right
 * after Stop was queued behind the turn Stop had just cancelled — so the new
 * reply rendered under the old message, with no bubble of its own.
 *
 * Runs the real local API + agent runtime against the scripted fake model from
 * apps/desktop/e2e/streaming, so nothing on the chat path is mocked. Start the
 * stack pointed at the fake model's port first:
 *
 *   LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 LOCAL_LLM_BASIC_MODEL=fake-stream \
 *   LOCAL_LLM_ADVANCED_MODEL=fake-stream SHOGO_LOCAL_MODE=true bun --no-env-file apps/api/src/entry.ts
 *   EXPO_PUBLIC_LOCAL_MODE=true EXPO_PUBLIC_API_URL=http://localhost:8002 bun run web:dev
 *
 *   E2E_FAKE_LLM_STACK=1 E2E_API_URL=http://localhost:8002 npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-stop-then-send --project chromium --retries 0
 *
 * Checks are soft, so one run lists every way the scenario goes wrong.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { FakeLlmServer, marker } from "../../apps/desktop/e2e/streaming/fake-llm-server"

const API = process.env.E2E_API_URL || "http://localhost:8002"
const LLM_PORT = Number(process.env.E2E_FAKE_LLM_PORT || 18765)
/** How long a window may take to show a turn it should be showing. */
const FOLLOW_MS = Number(process.env.E2E_FOLLOW_MS || 10_000)

const soft = expect.configure({ soft: true })

// Needs the API pointed at the fake model, which would change every other
// local spec; CI runs it in its own job (ci.yml "E2E (chat resume windows)").
test.skip(
  process.env.E2E_FAKE_LLM_STACK !== "1",
  "needs an API started with LOCAL_LLM_BASE_URL pointing at the fake model (see the header); set E2E_FAKE_LLM_STACK=1",
)

test.setTimeout(240_000)

let llm: FakeLlmServer
let context: BrowserContext
let baseURL: string
let workspaceId: string
/** Project of each chat: a project has exactly one chat (its pinned workspace session). */
const projectOf = new Map<string, string>()

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(300_000)
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

async function cookieHeader(): Promise<string> {
  return (await context.cookies(API)).map((c) => `${c.name}=${c.value}`).join("; ")
}

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

/**
 * A new project, opened once so the app creates its chat, then closed again.
 * Returns that chat's session id.
 */
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

/** The runtime's view of the chat's turn: its status and the id of that turn. */
async function serverTurn(sessionId: string): Promise<{ status: string; turnId: string | null }> {
  const res = await fetch(`${API}/api/workspaces/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(sessionId)}/turn`, {
    headers: { cookie: await cookieHeader() },
  })
  const body = (await res.json().catch(() => ({}))) as { status?: string; turnId?: string }
  return { status: body.status ?? "unknown", turnId: body.turnId ?? null }
}

// ── Window helpers ──────────────────────────────────────────────────────────

const composer = (page: Page) => page.getByTestId("project-composer-input").filter({ visible: true }).first()

async function openChat(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/projects/${encodeURIComponent(projectOf.get(sessionId)!)}`)
  const switchToText = page.getByText("Switch to text input", { exact: true })
  if (await switchToText.isVisible().catch(() => false)) await switchToText.click()
  await expect(composer(page)).toBeVisible({ timeout: 120_000 })
}

async function newWindow(sessionId: string): Promise<Page> {
  const page = await context.newPage()
  await openChat(page, sessionId)
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

async function clickStop(page: Page): Promise<void> {
  const buttons = page.getByTestId("stop-streaming")
  const count = await buttons.count()
  for (let i = 0; i < count; i++) {
    const b = buttons.nth(i)
    const visible = await b.evaluate((el) => {
      let node: Element | null = el
      while (node) {
        if (getComputedStyle(node).opacity === "0") return false
        node = node.parentElement
      }
      return true
    })
    if (visible) {
      await b.click()
      return
    }
  }
  throw new Error("no visible Stop button to click")
}

/** Token numbers of turn `tag` on screen, in DOM order. */
async function tokensOnScreen(page: Page, tag: string): Promise<number[]> {
  return page.evaluate((t) => {
    const re = new RegExp(`t${t}w(\\d{4})`, "g")
    const out: number[] = []
    let m: RegExpExecArray | null
    const text = document.body?.innerText ?? ""
    while ((m = re.exec(text))) out.push(Number(m[1]))
    return out
  }, tag)
}

async function maxOnScreen(page: Page, tag: string): Promise<number> {
  const seq = await tokensOnScreen(page, tag)
  return seq.reduce((a, b) => Math.max(a, b), 0)
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

/** Where `needle` first appears in the rendered transcript (-1 when absent). */
async function indexOnScreen(page: Page, needle: string): Promise<number> {
  return page.evaluate((n) => (document.body?.innerText ?? "").indexOf(n), needle)
}

/** The window shows turn `tag` while it streams, with a Stop button. */
async function expectFollows(page: Page, tag: string, label: string, timeoutMs = FOLLOW_MS): Promise<void> {
  const started = Date.now()
  let ok = false
  while (Date.now() - started < timeoutMs) {
    if ((await maxOnScreen(page, tag)) > 0 && (await stopShown(page))) {
      ok = true
      break
    }
    await page.waitForTimeout(150)
  }
  soft(ok, `${label}: window shows the running turn "${tag}" (shows up to ${await maxOnScreen(page, tag)}, Stop shown: ${await stopShown(page)})`).toBe(true)
}

async function expectIdle(page: Page, label: string, timeoutMs = 60_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs && (await stopShown(page))) await page.waitForTimeout(200)
  soft(await stopShown(page), `${label}: Stop button gone once nothing runs`).toBe(false)
}

/** The reply to `tag` is complete on screen (1..n, no gaps). */
async function expectComplete(page: Page, tag: string, n: number, label: string): Promise<void> {
  let seq: number[] = []
  const started = Date.now()
  while (Date.now() - started < 15_000) {
    seq = await tokensOnScreen(page, tag)
    if (seq.length === n && seq.every((v, i) => v === i + 1)) break
    await page.waitForTimeout(250)
  }
  soft(
    seq.length === n && seq.every((v, i) => v === i + 1),
    `${label}: reply "${tag}" is complete on screen (want 1..${n}; shows ${seq.length} tokens, max ${seq.reduce((a, b) => Math.max(a, b), 0)})`,
  ).toBe(true)
}

// ── Scenario ────────────────────────────────────────────────────────────────

test.describe("Stop, then send", () => {
  test("the stopped reply stays on screen and the next message gets its own bubble", async () => {
    const sid = await createChat("stop then send")
    const page = await newWindow(sid)
    const first = "xa"
    const second = "xb"
    // Unique words, so a bubble can be counted in the transcript.
    const firstText = "alpha-stop-first"
    const secondText = "bravo-next-second"

    await send(page, `${marker("long", first, 1500, { ms: 25 })} ${firstText}`)
    await llm.waitForTokens(first, 80, 60_000)
    await expectFollows(page, first, "before Stop")

    const beforeStop = await serverTurn(sid)
    soft(beforeStop.status, "the first turn is running before Stop").toBe("active")
    soft(Boolean(beforeStop.turnId), "the runtime reported a turn id for the first turn").toBe(true)

    const clicked = Date.now()
    await clickStop(page)
    while (Date.now() - clicked < 5000 && !llm.wasCancelled(first) && !llm.turn(first)?.finishedAt) {
      await page.waitForTimeout(50)
    }
    soft(Boolean(llm.wasCancelled(first) || llm.turn(first)?.finishedAt), "Stop cancelled the running turn at the model").toBe(true)

    // Stop reaches the runtime a beat after the window: until it does, the
    // turn it cancelled still reads `active` on the probe. That is what made
    // the next message queue behind it.
    await page.route("**/chat/*/turn", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "active", turnId: beforeStop.turnId, lastSeq: 1 }),
      })
    })
    await page.waitForTimeout(1500)

    const stoppedTokens = await tokensOnScreen(page, first)
    soft(stoppedTokens.length, "the stopped reply is still on screen after Stop").toBeGreaterThan(0)

    await send(page, `${marker("long", second, 60, { ms: 20 })} ${secondText}`)
    await llm.waitForTurn(second, 60_000).catch(() => undefined)
    // `wasCancelled` is true by definition here: Stop cut the first request
    // short. What matters is that the send did not start it *again* — one
    // request for the stopped turn, ever.
    soft(llm.requestsFor(first).length, "sending after Stop did not start a second run of the stopped turn").toBe(1)
    soft(llm.requestsFor(second).length, "the message sent after Stop ran exactly once").toBe(1)

    // The stale probe has done its job. Leaving it installed would answer the
    // reload's probe with a phantom `active` turn whose id is the stopped one —
    // and after a reload nothing remembers it was stopped, so the window would
    // attach to a live turn instead of just loading history.
    await page.unroute("**/chat/*/turn")

    await llm.waitForTokens(second, 60, 90_000).catch(() => undefined)
    await expectComplete(page, second, 60, "after sending")
    await expectIdle(page, "after sending")

    // Two bubbles, in order, the new one last — never the new reply under the
    // old message with no bubble of its own.
    const firstBubbles = await countOnScreen(page, firstText)
    const secondBubbles = await countOnScreen(page, secondText)
    soft(firstBubbles, `the first message has exactly one bubble (found ${firstBubbles})`).toBe(1)
    soft(secondBubbles, `the message sent after Stop has exactly one bubble (found ${secondBubbles})`).toBe(1)

    const firstAt = await indexOnScreen(page, firstText)
    const secondAt = await indexOnScreen(page, secondText)
    const firstReplyAt = await indexOnScreen(page, `t${first}w`)
    soft(firstAt !== -1 && firstAt < secondAt, "the first message is above the message sent after Stop").toBe(true)
    soft(firstReplyAt !== -1 && firstReplyAt < secondAt, "the stopped reply stayed above the next message").toBe(true)

    const afterSend = await tokensOnScreen(page, first)
    soft(
      afterSend.length >= stoppedTokens.length,
      `the stopped reply is still visible after the next reply (had ${stoppedTokens.length} tokens, shows ${afterSend.length})`,
    ).toBe(true)

    // A reload must show the same order: A, the stopped reply, B, the reply to B.
    await page.reload()
    await expect(composer(page)).toBeVisible({ timeout: 120_000 })
    await expectComplete(page, second, 60, "after reload")
    soft(await countOnScreen(page, firstText), "after reload: one bubble for the first message").toBe(1)
    soft(await countOnScreen(page, secondText), "after reload: one bubble for the message sent after Stop").toBe(1)
    const reloadFirstAt = await indexOnScreen(page, firstText)
    const reloadSecondAt = await indexOnScreen(page, secondText)
    soft(reloadFirstAt !== -1 && reloadFirstAt < reloadSecondAt, "after reload: the messages are in the order they were sent").toBe(true)
    soft(await maxOnScreen(page, first), "after reload: the stopped reply is still shown").toBeGreaterThan(0)

    await page.close()
  })
})
