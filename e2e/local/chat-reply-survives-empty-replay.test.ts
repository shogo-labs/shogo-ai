// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-85 — reopening a chat whose turn the runtime reports as live, but whose
 * buffer has nothing left to replay, must not empty the transcript.
 *
 * The panel drops the unfinished copy of the assistant message before a resume
 * replay rebuilds it (`beforeResumeReplayRef` → `dropUnfinishedAssistantTail`).
 * That is only safe when the replay actually carries the message back. A
 * runtime that answers with a heartbeat and nothing else — the turn ended while
 * the client was away, the buffer was consumed or cleared, and the revalidate
 * that would repaint from `/chat-messages` is blocked (see the E.1 guard) —
 * used to leave the transcript with no copy at all: the reply Russell watched
 * finish was simply gone.
 *
 * The chat POST, the `/turn` probe, `/stream` and `/chat-messages` are mocked
 * here; the local API still serves workspaces/projects and the panel is real.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-reply-survives-empty-replay --project chromium
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { startProjectWithBootstrapTurn } from "./helpers"

test.setTimeout(180_000)

const CHAT_POST_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"
const STREAM_GLOB = "**/api/{projects,workspaces}/*/chat/*/stream*"
const MESSAGES_GLOB = "**/api/chat-messages*"

const TURN_ID = "turn_reopened"
const BOOTSTRAP_PROMPT = "Build a tiny app for the resume-replay E2E"
const BOOTSTRAP_REPLY = "Bootstrap done."
const PROMPT = "Does the reply survive the reopen?"
const REPLY_MARKER = "the reply the server already wrote"

function sseFrame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

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
 * What `/stream` answers when the turn is over but `/turn` has not caught up:
 * the buffer's last heartbeat and then EOF, no frame that rebuilds the message.
 */
const EMPTY_REPLAY = sseFrame({ type: "data-turn-seq", data: { turnId: TURN_ID, seq: 91 }, transient: true })

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
    // No `data-turn-timing.completedAt` and no `data-turn-complete`: the client
    // cannot tell this reply finished, which is exactly the copy the resume
    // path is willing to drop.
    parts: JSON.stringify([{ type: "text", text }]),
    createdAt,
  }
}

interface ReplayState {
  /** `/stream` attaches served, to prove the resume path really ran. */
  streams: number
}

/**
 * The transcript as `/chat-messages` reports it: one finished bootstrap turn,
 * then a turn whose reply is on screen but which the server has not marked
 * complete.
 */
async function installReopenMocks(page: Page): Promise<ReplayState> {
  const state: ReplayState = { streams: 0 }
  const sessionId = "sess_reopened"
  const base = Date.now() - 60_000

  await page.route(MESSAGES_GLOB, async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        total: 4,
        items: [
          savedRow("m-bootstrap-user", sessionId, "user", BOOTSTRAP_PROMPT, base + 1),
          savedRow("m-bootstrap-reply", sessionId, "assistant", BOOTSTRAP_REPLY, base + 2),
          savedRow("m-prompt", sessionId, "user", PROMPT, base + 3),
          savedRow("m-reply", sessionId, "assistant", REPLY_MARKER, base + 4),
        ],
      }),
    })
  })

  await page.route(CHAT_POST_GLOB, async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: completedTurn("msg_bootstrap", BOOTSTRAP_REPLY),
    })
  })

  await page.route(TURN_GLOB, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "active", turnId: TURN_ID, lastSeq: 91 }),
    })
  })

  await page.route(STREAM_GLOB, async (route: Route) => {
    state.streams += 1
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache",
        "X-Turn-Id": TURN_ID,
        "X-Turn-Status": "active",
        "Access-Control-Expose-Headers": "X-Turn-Id, X-Last-Seq, X-Turn-Status",
      },
      body: EMPTY_REPLAY,
    })
  })

  return state
}

test("a resume whose replay has nothing left to rebuild keeps the reply on screen", async ({ page }) => {
  const state = await installReopenMocks(page)
  await startProjectWithBootstrapTurn(page)

  // The panel probes `/turn`, sees the turn as active and attaches a replay.
  await expect
    .poll(() => state.streams, { timeout: 30_000, message: "the panel never attached the replay" })
    .toBeGreaterThan(0)

  // The replay carried no frame that rebuilds the message, so the transcript
  // must still show it — exactly once, and still there once the panel settles.
  await expect(
    page.getByText(REPLY_MARKER, { exact: false }).first(),
    "the reply is on screen after the empty replay",
  ).toBeVisible({ timeout: 15_000 })
  expect(
    await page.getByText(REPLY_MARKER, { exact: false }).count(),
    "the reply is shown once, not twice",
  ).toBe(1)

  await page.waitForTimeout(2_500)
  expect(
    await page.getByText(REPLY_MARKER, { exact: false }).count(),
    "the reply is still on screen once the panel has settled",
  ).toBe(1)
})
