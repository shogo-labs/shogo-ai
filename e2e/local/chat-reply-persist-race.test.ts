// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-85 — a finished reply must survive a paint from saved history.
 *
 * The API writes the assistant row *after* the stream EOFs (`trackUsageFromStream`
 * → `persistAssistantSnapshot`: EOF, billing close, possible auto-resume), so
 * the panel can finish the turn while the reply exists only on screen. These
 * specs delay the "persist" of the assistant row in the mocked API and hold the
 * client to three promises:
 *   1. the reply is still on screen while the row does not exist, and the panel
 *      did read saved history after the turn ended (so a paint really raced it);
 *   2. a refocus (which forces a real fetch) does not drop it either;
 *   3. once the row lands, the transcript shows it exactly once, from the row.
 *
 * Scope note (QA round 1, 2026-10-20): this is durability coverage, not the
 * red-on-main repro. `route.fulfill` sends the SSE in one chunk, so `isStreaming`
 * never renders `true`, Effect 1's post-turn revalidate exits at the "Fix E.1"
 * sending guard, and nothing can paint the reply away here — main passes these
 * too. The path that does empty the transcript (a resume replay with nothing
 * left to rebuild) is `chat-reply-survives-empty-replay.test.ts`, which fails on
 * `main` and passes on this branch.
 *
 * The chat stream, the turn probe and `/chat-messages` are mocked here; the
 * local API still serves workspaces/projects and the panel is the real one.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-reply-persist-race --project chromium
 *
 * `E2E_PERSIST_DELAY_MS` overrides how long the mocked API waits before it
 * reports the reply row.
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { startProjectWithBootstrapTurn } from "./helpers"

test.setTimeout(180_000)

const CHAT_POST_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"
const STREAM_GLOB = "**/api/{projects,workspaces}/*/chat/*/stream*"
const MESSAGES_GLOB = "**/api/chat-messages*"

const BOOTSTRAP_PROMPT = "Build a tiny app for the resume-replay E2E"
const BOOTSTRAP_REPLY = "Bootstrap done."
const REPLY_MARKER = "the reply survived the repaint"
const SAVED_SUFFIX = " (saved)"

interface HistoryState {
  sessionId: string | null
  prompt: string | null
  promptAt: number | null
  /** When the mocked API starts reporting the assistant row. */
  replyRowAt: number | null
  /** `/chat-messages` GETs served, so a spec can see the paint actually raced. */
  reads: number
  /** The turn under test reached the mocked API, so its stream is under way. */
  turnServed: boolean
}

const AGENT_STOP_SELECTOR = '[data-testid="stop-streaming"], [aria-label="Stop"]'

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

/**
 * One saved `/chat-messages` row, in the shape the panel's store expects.
 * `parts` is the JSON string the API persists (the panel renders the reply from
 * it, not from `content`), so a row without it is not a row the transcript can
 * paint.
 */
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

/**
 * Mock the chat's writes and reads for one window: a bootstrap turn from the
 * home composer, then the turn under test, whose assistant row the mocked API
 * only reports `persistDelayMs` after its stream ended.
 */
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
    const body = request.postData()
    const prompt = promptOf(body)
    // Decide by prompt, not by call order: the project's first turn may be
    // served on another route entirely, so the counter cannot be trusted.
    // A streamed POST can also arrive with no readable body.
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
    state.prompt = prompt ?? "second turn"
    state.promptAt = Date.now()
    state.turnServed = true
    // The client finishes the turn as soon as this body ends; the row is not
    // there yet, exactly like the real API behind a slow link.
    state.replyRowAt = Date.now() + persistDelayMs
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: completedTurn("msg_second", REPLY_MARKER),
    })
  })

  await page.route(TURN_GLOB, async (route: Route) => {
    // Nothing is running: the turn finished, and its reply is what is on screen.
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
    if (state.prompt) {
      rows.push(
        savedRow("m-second-user", sessionId, "user", state.prompt, state.promptAt ?? base + 3),
      )
    }
    if (state.replyRowAt !== null && Date.now() >= state.replyRowAt) {
      rows.push(
        savedRow(
          "m-second-reply",
          sessionId,
          "assistant",
          `${REPLY_MARKER}${SAVED_SUFFIX}`,
          (state.replyRowAt ?? base) + 1,
        ),
      )
    }
    // The API answers newest first; the panel sorts ascending itself.
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

/** How many times `needle` appears in the transcript right now. */
async function occurrences(page: Page, needle: string): Promise<number> {
  return page.evaluate((text) => (document.body?.innerText ?? "").split(text).length - 1, needle)
}

async function waitForReply(page: Page): Promise<void> {
  await expect(
    page.getByText(REPLY_MARKER, { exact: false }).first(),
    "the streamed reply is on screen",
  ).toBeVisible({ timeout: 60_000 })
}

/** Sends the turn under test; returns how many history reads the panel had served when it did. */
async function sendSecondTurn(
  page: Page,
  state: HistoryState,
  prompt: string,
): Promise<number> {
  const composer = page.getByTestId("project-composer-input").first()
  await composer.waitFor({ state: "visible", timeout: 20_000 })
  await composer.click()
  await composer.fill(prompt)
  await page.waitForTimeout(150)
  await page.keyboard.press("Enter")
  // Wait for the send to actually reach the (mocked) API — on `main` the reply
  // can be wiped again inside the first frame, so "the reply is visible" is not
  // a reliable way to know the turn started.
  await expect.poll(() => state.turnServed, { timeout: 30_000 }).toBe(true)
  const readsAtTurnEnd = state.reads
  // Let the stream finish and the post-stream settle run before asserting.
  await page
    .waitForSelector(AGENT_STOP_SELECTOR, { state: "detached", timeout: 30_000 })
    .catch(() => {})
  return readsAtTurnEnd
}

/** A window focus event, i.e. the person coming back to the app. */
async function refocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"))
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("focus"))
  })
}

test("a reply the server has not written yet stays on screen when the turn ends", async ({ page }) => {
  const persistDelayMs = Number(process.env.E2E_PERSIST_DELAY_MS || 6_000)
  const state = await installChatMocks(page, persistDelayMs)
  await startProjectWithBootstrapTurn(page)

  const readsAtTurnEnd = await sendSecondTurn(page, state, "Does the reply survive?")

  // The mocked API has not reported the row yet, but the panel must not paint a
  // transcript that is behind the screen: the reply stays, and it is the live
  // text (not the saved row, which does not exist).
  await page.waitForTimeout(2_500)
  expect(await occurrences(page, REPLY_MARKER), "the finished reply is still on screen").toBe(1)
  expect(
    state.reads,
    "the panel read saved history after the turn ended, while the row was missing",
  ).toBeGreaterThan(readsAtTurnEnd)

  // The row lands ~6s in; the reply stays, exactly once.
  await page.waitForTimeout(persistDelayMs)
  await expect(
    page.getByText(REPLY_MARKER, { exact: false }).first(),
    "the reply is still on screen once its row exists",
  ).toBeVisible()
  expect(await occurrences(page, REPLY_MARKER), "the reply is shown once, not twice").toBe(1)
})

test("a refocus while the reply row is still being written does not drop it", async ({ page }) => {
  // Long enough that the refocus happens while the row is definitely missing.
  const persistDelayMs = Number(process.env.E2E_PERSIST_DELAY_MS || 12_000)
  const state = await installChatMocks(page, persistDelayMs)
  await startProjectWithBootstrapTurn(page)

  await sendSecondTurn(page, state, "Does a refocus drop the reply?")
  // The refocus check is rate-limited to one probe per 3s after a load.
  await page.waitForTimeout(3_500)

  await refocus(page)
  await page.waitForTimeout(2_500)

  expect(
    await occurrences(page, REPLY_MARKER),
    "the refocus repaint kept the reply the server has not written yet",
  ).toBe(1)
})

test("the saved row replaces the live reply exactly once when it lands", async ({ page }) => {
  // Lands inside the panel's reconcile window (5 x 400ms), so it takes the row.
  const state = await installChatMocks(page, 900)
  await startProjectWithBootstrapTurn(page)

  await sendSecondTurn(page, state, "Adopt the saved row?")
  await waitForReply(page)

  await expect(
    page.getByText(`${REPLY_MARKER}${SAVED_SUFFIX}`, { exact: false }).first(),
    "the transcript adopts the saved row once it lands",
  ).toBeVisible({ timeout: 20_000 })
  expect(await occurrences(page, REPLY_MARKER), "the reply is not duplicated").toBe(1)
})
