// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-328 — the reply that vanishes at turn end on a long chat.
 *
 * Russell, 2.6.8 (Samsara, Windows) and the same build on macOS: a reply streamed
 * in full, and once the turn finished it was gone from the screen. Reopening the
 * chat showed it. The rows were saved (prod `chat_messages` had the reply), so
 * this is the client's turn-end paint.
 *
 * Sentry from that machine had the shape on every turn: `historyRows:50,
 * historyTailRole:"user", screenRows:55` — the newest page below the reply, and a
 * guard that compared a 50-row page against a 55-row screen. The specs here put
 * the panel in that shape (a 50+ row chat, the page still ending on the prompt
 * while the reply exists only on screen) and hold it to the promises the card
 * asks for: the reply is still on screen after the stream ends, after a refocus,
 * after the row lands (exactly once, from the row), and after a reload.
 *
 * They also fail on the log line the fix adds — `Paint removed a reply from the
 * screen` — which is the `chat_reply_removed_by_paint` invariant. A paint that
 * deletes a reply is a bug even when a later one puts it back.
 *
 * Scope note, measured: this spec passes on `main` too (two runs), like
 * `chat-reply-persist-race`. The repaint that actually dropped the reply in the
 * report needs the panel to be *inactive* while its stream finishes (the desktop
 * shell's chat tabs / side panel), and a browser page cannot drive that state —
 * `isActive` comes from the shell around the panel, not from anything the web
 * route can toggle. What is red without this branch is the decision itself:
 * `history-paint.test.ts` fails on `main` for the 50-row-page/55-row-screen shape
 * and for `findRemovedReplies`, which is the invariant these specs watch for.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-reply-survives-turn-end-paint --project chromium
 *
 * `E2E_TURN_END_PAINT_DELAY_MS` overrides how long the mocked API waits before it
 * reports the reply row.
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { startProjectWithBootstrapTurn } from "./helpers"

test.setTimeout(180_000)

const CHAT_POST_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"
const STREAM_GLOB = "**/api/{projects,workspaces}/*/chat/*/stream*"
const MESSAGES_GLOB = "**/api/chat-messages**"

const BOOTSTRAP_PROMPT = "Build a tiny app for the turn-end paint E2E"
const BOOTSTRAP_REPLY = "Bootstrap done."
const REPLY_MARKER = "the reply survived the turn-end paint"
const SAVED_SUFFIX = " (saved)"
/** Turns of saved history below the turn under test: 24 with the bootstrap. */
const FILLER_TURNS = 24
const AGENT_STOP_SELECTOR = '[data-testid="stop-streaming"], [aria-label="Stop"]'
/** The fix's invariant, in the words the panel logs it. */
const REMOVED_BY_PAINT = "Paint removed a reply from the screen"

interface HistoryState {
  sessionId: string | null
  prompt: string | null
  promptAt: number | null
  /** When the mocked API starts reporting the assistant row for the turn. */
  replyRowAt: number | null
  /** `/chat-messages` GETs served, so a spec can see the paint actually raced. */
  reads: number
  turnServed: boolean
}

function sseFrame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/** One finished assistant turn, in the wire shape the panel already understands. */
function completedTurn(messageId: string, text: string): string {
  return [
    sseFrame({ type: "start", messageId }),
    sseFrame({ type: "start-step" }),
    sseFrame({ type: "text-start", id: `${messageId}-t` }),
    sseFrame({ type: "text-delta", id: `${messageId}-t`, delta: text }),
    sseFrame({ type: "text-end", id: `${messageId}-t` }),
    sseFrame({ type: "finish-step" }),
    sseFrame({ type: "finish" }),
  ].join("")
}

function savedRow(
  id: string,
  sessionId: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
): Record<string, unknown> {
  return {
    id,
    sessionId,
    role,
    content: text,
    parts: JSON.stringify([{ type: "text", text }]),
    createdAt,
  }
}

function promptOf(body: string | null): string | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as { messages?: any[] }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== "user") continue
      const text = (message.parts ?? [])
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join(" ")
        .trim()
      if (text) return text
    }
  } catch {
    return null
  }
  return null
}

async function installChatMocks(page: Page, persistDelayMs: number): Promise<HistoryState> {
  const base = Date.now()
  const state: HistoryState = {
    sessionId: null,
    prompt: null,
    promptAt: null,
    replyRowAt: null,
    reads: 0,
    turnServed: false,
  }

  await page.route(CHAT_POST_GLOB, async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue()
    const request = route.request()
    const prompt = promptOf(request.postData())
    if (prompt === null || prompt === BOOTSTRAP_PROMPT) {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "Cache-Control": "no-cache" },
        body: completedTurn("msg_bootstrap", BOOTSTRAP_REPLY),
      })
      return
    }
    state.sessionId = state.sessionId ?? request.headers()["x-chat-session-id"] ?? null
    state.prompt = prompt
    state.promptAt = Date.now()
    state.turnServed = true
    state.replyRowAt = Date.now() + persistDelayMs
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: completedTurn("msg_turn_end", REPLY_MARKER),
    })
  })

  await page.route(TURN_GLOB, async (route: Route) => {
    // The turn is over: its reply is what is on screen, and the saved page is
    // what the panel reads next (the 404 on `/chat/:id/turn` in the report).
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "completed" }),
    })
  })

  await page.route(STREAM_GLOB, async (route: Route) => {
    await route.fulfill({ status: 204, body: "" })
  })

  await page.route(MESSAGES_GLOB, async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue()
    state.reads += 1
    const url = new URL(route.request().url())
    const sessionId = state.sessionId ?? url.searchParams.get("sessionId") ?? "session-under-test"
    const limit = Number(url.searchParams.get("limit") || 50)
    const offset = Number(url.searchParams.get("offset") || 0)

    const rows: any[] = [
      savedRow("m-bootstrap-user", sessionId, "user", BOOTSTRAP_PROMPT, base + 1),
      savedRow("m-bootstrap-reply", sessionId, "assistant", BOOTSTRAP_REPLY, base + 2),
    ]
    for (let turn = 1; turn <= FILLER_TURNS; turn += 1) {
      rows.push(savedRow(`m-filler-u${turn}`, sessionId, "user", `filler prompt ${turn}`, base + 10 * turn))
      rows.push(
        savedRow(`m-filler-a${turn}`, sessionId, "assistant", `filler reply ${turn}`, base + 10 * turn + 1),
      )
    }
    if (state.prompt) {
      rows.push(
        savedRow("m-turn-end-user", sessionId, "user", state.prompt, state.promptAt ?? base + 400),
      )
    }
    if (state.replyRowAt !== null && Date.now() >= state.replyRowAt) {
      rows.push(
        savedRow(
          "m-turn-end-reply",
          sessionId,
          "assistant",
          `${REPLY_MARKER}${SAVED_SUFFIX}`,
          (state.replyRowAt ?? base) + 1,
        ),
      )
    }
    // The API answers newest first, and the newest page is what the panel paints:
    // until the row lands, that page ends on the prompt, exactly as it did on the
    // machine that reported this bug.
    const newestFirst = rows.reverse()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        items: newestFirst.slice(offset, offset + limit),
        total: newestFirst.length,
      }),
    })
  })

  return state
}

async function occurrences(page: Page, needle: string): Promise<number> {
  return page.evaluate((text) => (document.body?.innerText ?? "").split(text).length - 1, needle)
}

/** Sends the turn under test and waits for its stream to settle. */
async function sendTurnUnderTest(page: Page, state: HistoryState): Promise<void> {
  const composer = page.getByTestId("project-composer-input").first()
  await composer.waitFor({ state: "visible", timeout: 20_000 })
  await composer.click()
  await composer.fill("Does the reply survive the turn-end paint?")
  await page.waitForTimeout(150)
  await page.keyboard.press("Enter")
  await expect.poll(() => state.turnServed, { timeout: 30_000 }).toBe(true)
  await page
    .waitForSelector(AGENT_STOP_SELECTOR, { state: "detached", timeout: 30_000 })
    .catch(() => {})
}

async function refocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"))
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("focus"))
  })
}

test("a finished reply stays on screen on a long chat whose page is still behind it", async ({
  page,
}) => {
  const paintRemovals: string[] = []
  page.on("console", (message) => {
    if (message.text().includes(REMOVED_BY_PAINT)) paintRemovals.push(message.text())
  })

  const persistDelayMs = Number(process.env.E2E_TURN_END_PAINT_DELAY_MS || 8_000)
  const state = await installChatMocks(page, persistDelayMs)
  await startProjectWithBootstrapTurn(page)

  const readsBeforeTurn = state.reads
  await sendTurnUnderTest(page, state)

  // (a) Right after the stream ends: the page still ends on the prompt, so this
  // is the paint that used to take the reply with it.
  await page.waitForTimeout(2_500)
  expect(await occurrences(page, REPLY_MARKER), "the reply is still on screen").toBe(1)
  expect(
    state.reads,
    "the panel did read saved history after the turn ended",
  ).toBeGreaterThan(readsBeforeTurn)

  // (b) The person comes back to the window: one more repaint, same promise.
  await page.waitForTimeout(3_500)
  await refocus(page)
  await page.waitForTimeout(2_500)
  expect(await occurrences(page, REPLY_MARKER), "the refocus did not drop it").toBe(1)

  // The row lands: the transcript adopts it, once.
  await page.waitForTimeout(persistDelayMs)
  await expect(
    page.getByText(`${REPLY_MARKER}${SAVED_SUFFIX}`, { exact: false }).first(),
    "the saved row replaces the live reply",
  ).toBeVisible({ timeout: 20_000 })
  expect(await occurrences(page, REPLY_MARKER), "the reply is shown once, not twice").toBe(1)

  // (c) A reload paints the saved page, and still shows exactly one reply.
  await page.reload()
  await expect(
    page.getByText(REPLY_MARKER, { exact: false }).first(),
    "the reply is still there after a reload",
  ).toBeVisible({ timeout: 60_000 })
  expect(await occurrences(page, REPLY_MARKER), "the reload shows the reply once").toBe(1)

  expect(paintRemovals, "no paint deleted a reply from the screen").toEqual([])
})
