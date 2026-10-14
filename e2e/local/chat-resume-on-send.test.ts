// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A window that is not attached to a chat's live turn: it must still end up
 * showing that turn, at the latest once the user sends a message, and its Stop
 * button must stop the turn that is actually running.
 *
 * Runs the real local API + agent runtime against the scripted fake model from
 * apps/desktop/e2e/streaming, so nothing on the chat path is mocked. Start the
 * stack pointed at the fake model's port first:
 *
 *   LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 LOCAL_LLM_BASIC_MODEL=fake-stream \
 *   LOCAL_LLM_ADVANCED_MODEL=fake-stream SHOGO_LOCAL_MODE=true bun --no-env-file apps/api/src/entry.ts
 *   EXPO_PUBLIC_LOCAL_MODE=true EXPO_PUBLIC_API_URL=http://localhost:8002 bun run web:dev
 *
 *   E2E_API_URL=http://localhost:8002 npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-resume-on-send --project chromium --retries 0
 *
 * Checks are soft, so one run lists every way a scenario goes wrong.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { FakeLlmServer, marker } from "../../apps/desktop/e2e/streaming/fake-llm-server"

const API = process.env.E2E_API_URL || "http://localhost:8002"
const LLM_PORT = Number(process.env.E2E_FAKE_LLM_PORT || 18765)
/** How long a window may take to show a turn it should be showing. */
const FOLLOW_MS = Number(process.env.E2E_FOLLOW_MS || 10_000)
/** How far (in tokens) the window may trail the model and still count as following it. */
const TRAIL_TOKENS = 80

const soft = expect.configure({ soft: true })

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

function chatUrl(): string {
  return `${API}/api/workspaces/${encodeURIComponent(workspaceId)}/chat`
}

/**
 * Starts a turn the window under test did not start: another device, another
 * person in the workspace, a schedule or a channel message all reach the API
 * this way. Its response is drained in the background like a real client's.
 */
async function startTurnElsewhere(sessionId: string, text: string): Promise<number> {
  const res = await fetch(chatUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chat-session-id": sessionId,
      cookie: await cookieHeader(),
      origin: baseURL,
    },
    body: JSON.stringify({
      id: sessionId,
      sessionId,
      chatSessionId: sessionId,
      messages: [{ id: `m-${Date.now()}`, role: "user", parts: [{ type: "text", text }] }],
    }),
  })
  void res.body?.pipeTo(new WritableStream()).catch(() => undefined)
  return res.status
}

/** The runtime's view of the chat's turn: active | completed | aborted | failed | unknown. */
async function serverTurn(sessionId: string): Promise<string> {
  const res = await fetch(`${API}/api/workspaces/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(sessionId)}/turn`, {
    headers: { cookie: await cookieHeader() },
  })
  const body = (await res.json().catch(() => ({}))) as { status?: string }
  return body.status ?? "unknown"
}

// ── Window helpers ──────────────────────────────────────────────────────────

const composer = (page: Page) => page.getByTestId("project-composer-input").filter({ visible: true }).first()

async function openChat(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/projects/${encodeURIComponent(projectOf.get(sessionId)!)}`)
  const switchToText = page.getByText("Switch to text input", { exact: true })
  if (await switchToText.isVisible().catch(() => false)) await switchToText.click()
  await expect(composer(page)).toBeVisible({ timeout: 120_000 })
}

const DEBUG_T0 = Date.now()

/** E2E_DEBUG_CHAT=1 logs each window's chat requests (send, /turn probe, /stream attach, stop). */
function logChatTraffic(page: Page, name: string): void {
  if (!process.env.E2E_DEBUG_CHAT) return
  const t0 = DEBUG_T0
  page.on("response", (res) => {
    const url = res.url()
    if (!/\/chat(\/|\?|$)|chat-queued-messages|chat-messages/.test(url)) return
    const line = `[${name} +${Date.now() - t0}ms] ${res.request().method()} ${url.replace(API, "")} -> ${res.status()}`
    if (/\/turn$/.test(url)) void res.text().then((body) => console.log(`${line} ${body.slice(0, 200)}`), () => console.log(line))
    else console.log(line)
  })
  page.on("console", (msg) => {
    if (/ChatPanel|resume|probe/i.test(msg.text())) console.log(`[${name} console] ${msg.text().slice(0, 200)}`)
  })
}

let windowCount = 0
async function newWindow(sessionId: string): Promise<Page> {
  const page = await context.newPage()
  logChatTraffic(page, `w${++windowCount}`)
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

/** True while the window shows the live turn `tag` close to where the model is. */
async function isFollowing(page: Page, tag: string): Promise<boolean> {
  const sent = llm.sentAt(tag).length
  const seen = await maxOnScreen(page, tag)
  return seen > 0 && sent - seen <= TRAIL_TOKENS
}

/**
 * The window shows turn `tag` while it streams, with a Stop button.
 * Returns how long that took, or null.
 */
async function expectFollows(page: Page, tag: string, label: string, timeoutMs = FOLLOW_MS): Promise<number | null> {
  const started = Date.now()
  let ok = false
  while (Date.now() - started < timeoutMs) {
    if ((await isFollowing(page, tag)) && (await stopShown(page))) {
      ok = true
      break
    }
    await page.waitForTimeout(150)
  }
  const shown = await maxOnScreen(page, tag)
  soft(ok, `${label}: window shows the running turn "${tag}" (model sent ${llm.sentAt(tag).length}, window shows up to ${shown}, Stop shown: ${await stopShown(page)})`).toBe(true)
  return ok ? Date.now() - started : null
}

/** The window shows exactly 1..n for `tag`. */
async function expectComplete(page: Page, tag: string, n: number, label: string): Promise<void> {
  let seq: number[] = []
  const started = Date.now()
  while (Date.now() - started < 15_000) {
    seq = await tokensOnScreen(page, tag)
    if (seq.length === n && seq.every((v, i) => v === i + 1)) break
    await page.waitForTimeout(250)
  }
  const distinct = new Set(seq).size
  const max = seq.reduce((a, b) => Math.max(a, b), 0)
  soft(
    seq.length === n && seq.every((v, i) => v === i + 1),
    `${label}: reply "${tag}" is complete on screen (want 1..${n}; shows ${seq.length} tokens, ${distinct} distinct, max ${max})`,
  ).toBe(true)
}

async function expectIdle(page: Page, label: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs && (await stopShown(page))) await page.waitForTimeout(200)
  soft(await stopShown(page), `${label}: Stop button gone once nothing runs`).toBe(false)
}

/**
 * Records "Stop is shown but the window shows nothing of what the model is
 * sending" — the stuck state reported from production — until stopped.
 */
function watchForGhostStop(page: Page, tags: string[]) {
  const ghosts: Array<{ at: number; tag: string; sent: number; shown: number }> = []
  let running = true
  const loop = (async () => {
    const lastShown = new Map<string, { shown: number; sent: number; since: number }>()
    while (running && !page.isClosed()) {
      try {
        if (await stopShown(page)) {
          for (const tag of tags) {
            const sent = llm.sentAt(tag).length
            const shown = await maxOnScreen(page, tag)
            const prev = lastShown.get(tag)
            const streaming = llm.turn(tag) && !llm.turn(tag)!.finishedAt && !llm.turn(tag)!.clientClosedAt
            if (streaming && sent - shown > TRAIL_TOKENS * 2) {
              if (!prev || prev.shown !== shown) lastShown.set(tag, { shown, sent, since: Date.now() })
              else if (Date.now() - prev.since > 3000) ghosts.push({ at: Date.now(), tag, sent, shown })
            } else lastShown.delete(tag)
          }
        }
      } catch {
        /* page navigating */
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  })()
  return {
    async stop() {
      running = false
      await loop
      return ghosts
    },
  }
}

/**
 * After the user sends `follow` into a chat where `lead` is still running:
 * the window shows `lead` live, `lead` is not cut short, `follow` runs after
 * it, and both replies are on screen and saved.
 */
async function expectQueuedBehindLiveTurn(page: Page, sessionId: string, lead: string, leadN: number, follow: string, followN: number, label: string) {
  await expectFollows(page, lead, `${label}, after sending`)
  await llm.waitForTokens(lead, leadN, 120_000).catch(() => undefined)
  soft(llm.wasCancelled(lead), `${label}: sending a message cut the running turn "${lead}" short`).toBe(false)
  soft(llm.sentAt(lead).length, `${label}: model finished "${lead}"`).toBe(leadN)

  await llm.waitForTokens(follow, followN, 60_000).catch(() => undefined)
  const leadReq = llm.turn(lead)
  const followReq = llm.turn(follow)
  soft(Boolean(followReq), `${label}: the message sent was run`).toBe(true)
  if (leadReq?.finishedAt && followReq) {
    soft(followReq.startedAt >= leadReq.finishedAt - 50, `${label}: "${follow}" ran after "${lead}" finished, not alongside it`).toBe(true)
  }
  await expectComplete(page, lead, leadN, `${label}, live`)
  await expectComplete(page, follow, followN, `${label}, live`)
  await expectIdle(page, label)

  await page.reload()
  await expect(composer(page)).toBeVisible({ timeout: 120_000 })
  await expectComplete(page, lead, leadN, `${label}, after reload`)
  await expectComplete(page, follow, followN, `${label}, after reload`)
  soft(await serverTurn(sessionId), `${label}: server turn at the end`).not.toBe("active")
}

/**
 * After Stop in `page`: the turn that was running is cancelled at the model,
 * Stop goes away, and anything that runs afterwards is shown.
 */
async function expectStopStopsTheRunningTurn(page: Page, sessionId: string, running: string, label: string, queued?: string) {
  const clicked = Date.now()
  await clickStop(page)
  let cancelledMs: number | null = null
  while (Date.now() - clicked < 5000) {
    if (llm.wasCancelled(running) || llm.turn(running)?.finishedAt) {
      cancelledMs = Date.now() - clicked
      break
    }
    await page.waitForTimeout(50)
  }
  soft(cancelledMs, `${label}: Stop cancelled the turn that was running ("${running}") at the model`).not.toBeNull()
  await page.waitForTimeout(1500)
  // The server may already be running the queued message before the model sees it.
  if (queued && !llm.turn(queued) && (await serverTurn(sessionId)) === "active") {
    await llm.waitForTurn(queued, 5000).catch(() => undefined)
  }
  if (queued && llm.turn(queued) && !llm.turn(queued)!.finishedAt) {
    // A queued message may start once the stopped turn ends; if it does the window must show it.
    await expectFollows(page, queued, `${label}, the queued message started after Stop`)
  } else {
    const q = queued ? llm.turn(queued) : undefined
    const state = `server turn ${await serverTurn(sessionId)}; queued "${queued ?? "-"}" ${q ? (q.finishedAt ? "finished" : "running") : "not started"}`
    soft(await stopShown(page), `${label}: Stop button gone after Stop (${state})`).toBe(false)
  }
  await expectIdle(page, `${label}, after Stop`, 60_000)
  await page.waitForTimeout(1000)
  // Whatever is still running on the server must be visible somewhere: an
  // idle window over an active turn is the "can't see it, can't stop it" state.
  const status = await serverTurn(sessionId)
  if (status === "active") soft(await stopShown(page), `${label}: server still has an active turn but the window shows it as idle`).toBe(true)
}

// ── Scenarios ───────────────────────────────────────────────────────────────

test.describe("chat resumes a live turn it is not attached to", () => {
  test("window already open when a turn starts elsewhere, then the user sends a message", async () => {
    const sid = await createChat("open before turn")
    const page = await newWindow(sid)
    const lead = "oa"
    const leadN = 900
    const status = await startTurnElsewhere(sid, `${marker("long", lead, leadN, { ms: 25 })} elsewhere`)
    expect(status).toBe(200)
    await llm.waitForTokens(lead, 60, 30_000)

    const ghost = watchForGhostStop(page, [lead])
    await send(page, `${marker("long", "ob", 60)} follow-up`)
    await expectQueuedBehindLiveTurn(page, sid, lead, leadN, "ob", 60, "open window sends during a turn started elsewhere")
    const ghosts = await ghost.stop()
    soft(ghosts, "moments the window showed Stop while hiding the running turn").toEqual([])
    await page.close()
  })

  test("window already open when a turn starts elsewhere; the user comes back to the window", async () => {
    const sid = await createChat("open before turn, focus")
    const page = await newWindow(sid)
    const lead = "ka"
    await startTurnElsewhere(sid, `${marker("long", lead, 900, { ms: 25 })} elsewhere`)
    await llm.waitForTokens(lead, 60, 30_000)
    // Nothing pushes a turn started elsewhere to an idle window; coming back to it must.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expectFollows(page, lead, "after the user comes back to the window")
    await llm.waitForTokens(lead, 900, 60_000).catch(() => undefined)
    await expectComplete(page, lead, 900, "after coming back")
    await expectIdle(page, "after coming back")
    await page.close()
  })

  test("window already open when a turn starts elsewhere, user sends, then presses Stop", async () => {
    const sid = await createChat("open before turn, stop")
    const page = await newWindow(sid)
    const lead = "pa"
    await startTurnElsewhere(sid, `${marker("long", lead, 1500, { ms: 25 })} elsewhere`)
    await llm.waitForTokens(lead, 60, 30_000)

    const ghost = watchForGhostStop(page, [lead])
    await send(page, `${marker("long", "pb", 60)} follow-up`)
    await page.waitForTimeout(1500)
    soft(await stopShown(page), "after sending, the window shows the chat as busy").toBe(true)
    await expectFollows(page, lead, "after sending, before Stop")
    await expectStopStopsTheRunningTurn(page, sid, lead, "Stop in a window that joined by sending", "pb")
    const ghosts = await ghost.stop()
    soft(ghosts, "moments the window showed Stop while hiding the running turn").toEqual([])
    soft(llm.sentAt(lead).length, "the model kept streaming the stopped turn").toBeLessThan(1500)
    await page.close()
  })

  test("window opened mid-turn, then the user sends a message", async () => {
    const sid = await createChat("opened mid-turn")
    const lead = "ma"
    const leadN = 900
    await startTurnElsewhere(sid, `${marker("long", lead, leadN, { ms: 25 })} elsewhere`)
    await llm.waitForTokens(lead, 60, 30_000)
    const page = await newWindow(sid)
    await expectFollows(page, lead, "opened mid-turn")
    await send(page, `${marker("long", "mb", 60)} follow-up`)
    await expectQueuedBehindLiveTurn(page, sid, lead, leadN, "mb", 60, "opened mid-turn, then sends")
    await page.close()
  })

  test("window opened mid-turn presses Stop on a turn another client started", async () => {
    const sid = await createChat("opened mid-turn, stop")
    const lead = "na"
    await startTurnElsewhere(sid, `${marker("long", lead, 1500, { ms: 25 })} elsewhere`)
    await llm.waitForTokens(lead, 60, 30_000)
    const page = await newWindow(sid)
    await expectFollows(page, lead, "opened mid-turn")
    await expectStopStopsTheRunningTurn(page, sid, lead, "Stop on a joined turn")
    await page.close()
  })

  test("window opened while the model is still thinking, user sends, then presses Stop", async () => {
    const sid = await createChat("opened while thinking")
    const lead = "ha"
    await startTurnElsewhere(sid, `${marker("hold", lead, 200, { ms: 20 })} elsewhere`)
    await llm.waitForTurn(lead, 30_000)
    const page = await newWindow(sid)
    await page.waitForTimeout(2000)
    soft(await stopShown(page), "a window opened while the model is thinking shows the chat as busy").toBe(true)
    await send(page, `${marker("long", "hb", 60)} follow-up`)
    await page.waitForTimeout(1500)
    soft(llm.turn("hb"), "the follow-up must wait for the thinking turn, not run alongside it").toBeUndefined()
    soft(await stopShown(page), "after sending, the window shows the chat as busy").toBe(true)
    await expectStopStopsTheRunningTurn(page, sid, lead, "Stop while thinking", "hb")
    await page.close()
  })

  test("the turn-status probe fails when the window opens, then the user sends a message", async () => {
    const sid = await createChat("probe fails")
    const lead = "fa"
    const leadN = 900
    await startTurnElsewhere(sid, `${marker("long", lead, leadN, { ms: 25 })} elsewhere`)
    await llm.waitForTokens(lead, 60, 30_000)
    const page = await context.newPage()
    let failed = 0
    await page.route("**/chat/*/turn", async (route) => {
      if (failed++ < 1) return route.fulfill({ status: 503, body: "unavailable" })
      return route.continue()
    })
    await openChat(page, sid)
    await expectFollows(page, lead, "opened while the probe failed once")
    await send(page, `${marker("long", "fb", 60)} follow-up`)
    await expectQueuedBehindLiveTurn(page, sid, lead, leadN, "fb", 60, "probe failed, then sends")
    await page.close()
  })

  test("own stream drops until the window gives up, then the user sends a message", async () => {
    const sid = await createChat("stream drops")
    const page = await newWindow(sid)
    const lead = "da"
    // Long enough to still be running after the window spends up to a minute giving up.
    const leadN = 6000
    await send(page, `${marker("long", lead, leadN, { ms: 15 })} go`)
    await llm.waitForTokens(lead, 80, 30_000)
    await expectFollows(page, lead, "own turn before the drop")

    // Every reconnect fails until the window stops trying (Retry banner).
    await page.route("**/chat/*/stream**", (route) => route.abort("internetdisconnected"))
    await page.context().setOffline(true)
    const gaveUp = Date.now()
    while (Date.now() - gaveUp < 60_000 && (await stopShown(page))) await page.waitForTimeout(500)
    await page.context().setOffline(false)
    await page.unroute("**/chat/*/stream**")
    soft(llm.wasCancelled(lead), "the drop cancelled the turn on the server").toBe(false)
    soft(await serverTurn(sid), "the server is still running the turn after the window gave up").toBe("active")
    await page.waitForTimeout(1000)
    await page.screenshot({ path: test.info().outputPath("after-giving-up.png") })

    await send(page, `${marker("long", "db", 60)} follow-up`)
    await expectQueuedBehindLiveTurn(page, sid, lead, leadN, "db", 60, "after the window gave up on its stream")
    await page.close()
  })

  test("switch to another chat and straight back mid-turn, then send", async () => {
    const sid = await createChat("switch back")
    const other = await createChat("switch other")
    const page = await newWindow(sid)
    const lead = "wa"
    const leadN = 900
    await send(page, `${marker("long", lead, leadN, { ms: 25 })} go`)
    await llm.waitForTokens(lead, 60, 30_000)
    await expectFollows(page, lead, "before switching")

    await page.evaluate((path) => {
      window.history.pushState({}, "", path)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }, `/projects/${projectOf.get(other)}`)
    await page.waitForTimeout(1500)
    await page.goBack()
    await expect(composer(page)).toBeVisible()
    await expectFollows(page, lead, "after switching back")
    await send(page, `${marker("long", "wb", 60)} follow-up`)
    await expectQueuedBehindLiveTurn(page, sid, lead, leadN, "wb", 60, "switched back, then sends")
    await page.close()
  })

  test("leave the project and come back mid-turn, then send", async () => {
    const sid = await createChat("leave and return")
    const page = await newWindow(sid)
    const lead = "la"
    const leadN = 900
    await send(page, `${marker("long", lead, leadN, { ms: 25 })} go`)
    await llm.waitForTokens(lead, 60, 30_000)
    await page.evaluate(() => {
      window.history.pushState({}, "", "/")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await expect(composer(page)).toHaveCount(0, { timeout: 15_000 })
    await page.waitForTimeout(1500)
    await page.goBack()
    await expect(composer(page)).toBeVisible({ timeout: 60_000 })
    await expectFollows(page, lead, "after coming back")
    await send(page, `${marker("long", "lb", 60)} follow-up`)
    await expectQueuedBehindLiveTurn(page, sid, lead, leadN, "lb", 60, "came back, then sends")
    await page.close()
  })
})

test.describe("two windows on one chat", () => {
  test("second window queues a message; the first window shows it run, then sends its own", async () => {
    const sid = await createChat("two windows queue")
    const a = await newWindow(sid)
    const lead = "qa"
    await send(a, `${marker("long", lead, 600, { ms: 25 })} from A`)
    await llm.waitForTokens(lead, 60, 30_000)
    const b = await newWindow(sid)
    await expectFollows(b, lead, "window B opened mid-turn")
    await send(b, `${marker("long", "qb", 600, { ms: 25 })} from B`)
    await llm.waitForTokens("qb", 60, 60_000).catch(() => undefined)

    await expectFollows(b, "qb", "window B, its queued message runs")
    await expectFollows(a, "qb", "window A, the message B queued runs")

    const ghost = watchForGhostStop(a, ["qb"])
    await send(a, `${marker("long", "qc", 60)} from A again`)
    await a.waitForTimeout(1500)
    soft(llm.wasCancelled("qb"), "A's message cut B's running turn short").toBe(false)
    await llm.waitForTokens("qb", 600, 60_000).catch(() => undefined)
    await llm.waitForTokens("qc", 60, 60_000).catch(() => undefined)
    soft(llm.sentAt("qb").length, "B's turn finished").toBe(600)
    await expectComplete(a, "qb", 600, "window A")
    await expectComplete(a, "qc", 60, "window A")
    await expectComplete(b, "qc", 60, "window B")
    await expectIdle(a, "window A")
    await expectIdle(b, "window B")
    const ghosts = await ghost.stop()
    soft(ghosts, "moments window A showed Stop while hiding the running turn").toEqual([])
    await a.close()
    await b.close()
  })

  test("Stop in the window that started the turn clears Stop in the other window", async () => {
    const sid = await createChat("two windows stop A")
    const a = await newWindow(sid)
    const lead = "sa"
    await send(a, `${marker("long", lead, 1500, { ms: 25 })} from A`)
    await llm.waitForTokens(lead, 60, 30_000)
    const b = await newWindow(sid)
    await expectFollows(b, lead, "window B opened mid-turn")
    await expectStopStopsTheRunningTurn(a, sid, lead, "Stop in window A")
    await expectIdle(b, "window B after A stopped", 10_000)
    await a.close()
    await b.close()
  })

  test("Stop in the window that joined clears Stop in the window that started it", async () => {
    const sid = await createChat("two windows stop B")
    const a = await newWindow(sid)
    const lead = "ta"
    await send(a, `${marker("long", lead, 1500, { ms: 25 })} from A`)
    await llm.waitForTokens(lead, 60, 30_000)
    const b = await newWindow(sid)
    await expectFollows(b, lead, "window B opened mid-turn")
    await expectStopStopsTheRunningTurn(b, sid, lead, "Stop in window B")
    await expectIdle(a, "window A after B stopped", 10_000)
    await a.close()
    await b.close()
  })

  test("both windows open before a turn starts elsewhere; both send", async () => {
    const sid = await createChat("two windows both send")
    const a = await newWindow(sid)
    const b = await newWindow(sid)
    const lead = "ua"
    await startTurnElsewhere(sid, `${marker("long", lead, 900, { ms: 25 })} elsewhere`)
    await llm.waitForTokens(lead, 60, 30_000)
    const sampler = process.env.E2E_DEBUG_CHAT
      ? setInterval(async () => {
          try {
            console.log(`[A screen +${Date.now() - DEBUG_T0}ms] ua ${await maxOnScreen(a, "ua")} ub ${await maxOnScreen(a, "ub")} uc ${await maxOnScreen(a, "uc")} stop ${await stopShown(a)}`)
          } catch {}
        }, 1000)
      : undefined
    await send(a, `${marker("long", "ub", 60)} from A`)
    await a.waitForTimeout(500)
    await send(b, `${marker("long", "uc", 60)} from B`)
    await expectFollows(a, lead, "window A after sending")
    await expectFollows(b, lead, "window B after sending")
    await llm.waitForTokens(lead, 900, 90_000).catch(() => undefined)
    soft(llm.wasCancelled(lead), "sending cut the running turn short").toBe(false)
    await llm.waitForTokens("ub", 60, 60_000).catch(() => undefined)
    await llm.waitForTokens("uc", 60, 60_000).catch(() => undefined)
    const order = llm.turns.filter((t) => ["ua", "ub", "uc"].includes(t.tag)).map((t) => ({ tag: t.tag, startedAt: t.startedAt, finishedAt: t.finishedAt }))
    for (let i = 1; i < order.length; i++) {
      soft((order[i].startedAt ?? 0) >= (order[i - 1].finishedAt ?? Infinity) - 50, `"${order[i].tag}" started before "${order[i - 1].tag}" finished`).toBe(true)
    }
    if (process.env.E2E_DEBUG_CHAT) console.log("turns", order.map((t) => `${t.tag} ${t.startedAt - DEBUG_T0}..${(t.finishedAt ?? 0) - DEBUG_T0}`).join(", "))
    for (const [name, page] of [["window A", a], ["window B", b]] as const) {
      await expectComplete(page, lead, 900, name)
      await expectComplete(page, "ub", 60, name)
      await expectComplete(page, "uc", 60, name)
      await expectIdle(page, name)
    }
    if (sampler) clearInterval(sampler)
    await a.close()
    await b.close()
  })
})