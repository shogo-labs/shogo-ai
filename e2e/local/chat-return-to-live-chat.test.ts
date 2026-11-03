// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coming back to a chat whose turn is still running (SHO-287).
 *
 * Two things broke on the connection Russell uses (production v2.4.10):
 *
 *  - the reply jumped above the first prompt. Every message the panel builds
 *    itself (the streamed bubble, the resume snapshot) has no `createdAt`, and
 *    the delta merge sorted by `createdAt || 0`, so the reply took index 0 and
 *    stayed there for the rest of the turn;
 *  - the running turn painted as finished — collapsed work log, "Worked for 2s"
 *    — with no Stop button, for the 5-10 s until the window attached.
 *
 * The turn, the probe and the transcript reads are mocked in the browser (the
 * same way e2e/shared/live-turn-replay.ts mocks a live turn), so this runs in
 * the ordinary e2e/local shards and needs no model.
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { openTeamHome, startProjectWithBootstrapTurn } from "./helpers"

test.setTimeout(180_000)

const CHAT_POST_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"
const STREAM_GLOB = "**/api/{projects,workspaces}/*/chat/*/stream*"
// Playwright's `*` stops at `/`, so `**` is needed for `/session/:id/changes`.
const MESSAGES_GLOB = "**/api/chat-messages**"

const BOOTSTRAP_REPLY = "Bootstrap done."
/** Text of the persisted prompt row this chat reopens with. */
const RETURN_PROMPT = "return-prompt-marker"
/** Words the running turn has already written. */
const RETURN_REPLY = "return-reply-marker"
const TURN_ID = "turn_return"

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
 * A turn the runtime opened and has not closed: `data-turn-start`, one open
 * step, the words written so far, and no `finish`. This is what a client that
 * joins mid-turn receives from `/stream`.
 */
function runningTurn(text: string): string {
  return [
    sseFrame({ type: "data-turn-start", data: { turnId: TURN_ID, startedAt: Date.now() } }),
    sseFrame({ type: "start-step" }),
    sseFrame({ type: "text-start", id: "t_running" }),
    sseFrame({ type: "text-delta", id: "t_running", delta: text }),
  ].join("")
}

/** One `/chat-messages` row in the shape the panel's store expects. */
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
    updatedAt: createdAt,
  }
}

interface ReturnState {
  /** Rows the persisted history holds. Replaced once the bootstrap turn is done. */
  rows: Array<Record<string, unknown>>
  /** The chat's turn is running: `/turn` says active and `/stream` replays it. */
  live: boolean
  pageReads: number
  deltaReads: number
  /** Hold the delta so a spec can prove the streamed reply was already on screen. */
  deltaDelayMs: number
  /** Sessions `/chat-messages` was asked for. */
  sessions: Set<string>
}

async function installMocks(page: Page): Promise<ReturnState> {
  const state: ReturnState = {
    rows: [],
    live: false,
    pageReads: 0,
    deltaReads: 0,
    deltaDelayMs: 0,
    sessions: new Set<string>(),
  }

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
    if (!state.live) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ status: "unknown" }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "active", turnId: TURN_ID }),
    })
  })

  await page.route(STREAM_GLOB, async (route: Route) => {
    if (!state.live) {
      await route.fulfill({ status: 204, body: "" })
      return
    }
    const fromSeq = Number(new URL(route.request().url()).searchParams.get("fromSeq") || 0)
    if (fromSeq > 0) {
      // The real `/stream` stays open while the agent works; hold this one so
      // the panel does not see an end-of-stream it would read as "finished".
      await new Promise((resolve) => setTimeout(resolve, 60_000))
      await route.fulfill({ status: 204, body: "" }).catch(() => {})
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache",
        "X-Turn-Id": TURN_ID,
        "X-Turn-Status": "active",
        // As the API sets it; without it a cross-origin client can't read them.
        "Access-Control-Expose-Headers": "X-Turn-Id, X-Last-Seq, X-Turn-Status",
      },
      body: runningTurn(RETURN_REPLY),
    })
  })

  await page.route(MESSAGES_GLOB, async (route: Route) => {
    const request = route.request()
    if (request.method() !== "GET") return route.continue()
    const url = new URL(request.url())
    // The reopen asks for the transcript one of two ways (SHO-260): a page read
    // carries `?sessionId=`, and the delta a device with a saved cursor enables
    // carries it in the path (`/chat-messages/session/:id/changes`). Both name
    // the chat, so record whichever this request used — and nothing when it
    // names none, so a request for the wrong chat can never pass as right.
    const fromPath = url.pathname.match(/\/chat-messages\/session\/([^/]+)\//)?.[1]
    const sessionId = url.searchParams.get("sessionId") ?? (fromPath ? decodeURIComponent(fromPath) : null)
    if (sessionId) state.sessions.add(sessionId)
    const rowSessionId = sessionId ?? "session-under-test"

    if (url.pathname.endsWith("/changes")) {
      state.deltaReads += 1
      if (state.deltaDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, state.deltaDelayMs))
      }
      const sinceRaw = url.searchParams.get("since")
      const since = sinceRaw ? new Date(sinceRaw).getTime() : 0
      const items = state.rows
        .filter((row) => Number(row.updatedAt) >= since)
        .map((row) => ({ ...row, sessionId: rowSessionId }))
      let cursor = 0
      for (const row of state.rows) cursor = Math.max(cursor, Number(row.updatedAt))
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          items,
          total: state.rows.length,
          cursor: new Date(cursor || since).toISOString(),
          reset: false,
        }),
      })
      return
    }

    state.pageReads += 1
    const newestFirst = state.rows
      .map((row) => ({ ...row, sessionId: rowSessionId }))
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, items: newestFirst, total: state.rows.length }),
    })
  })

  return state
}

/** The transcript as the person reads it: what is painted, in document order. */
async function transcriptText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText)
}

function positionOf(text: string, marker: string): number {
  return text.replace(/\s+/g, " ").indexOf(marker.replace(/\s+/g, " "))
}

/** Open a project chat through the home composer and wait for its first reply. */
async function openProjectChat(page: Page): Promise<void> {
  await startProjectWithBootstrapTurn(page)
  await expect(page.getByText(BOOTSTRAP_REPLY, { exact: false }).first()).toBeVisible({
    timeout: 60_000,
  })
}

/**
 * The persisted state a chat has when it is left mid-turn: the prompt is a
 * server row, and the reply is a message this browser built from the stream.
 */
function moveToRunningTurn(state: ReturnState): void {
  const base = Date.now() - 120_000
  state.rows = [savedRow("m-prompt", "", "user", RETURN_PROMPT, base)]
  state.live = true
  // The delta answers after the streamed reply is on screen, which is the
  // order the bug needed: the merge then re-sorted what was already painted.
  state.deltaDelayMs = 1_500
}

test.describe("coming back to a live chat", () => {
  test("a reload mid-turn keeps the reply under its own prompt", async ({ page }) => {
    const state = await installMocks(page)
    await openProjectChat(page)

    moveToRunningTurn(state)
    await page.reload()

    await expect(page.getByText(RETURN_PROMPT, { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })
    await expect(page.getByText(RETURN_REPLY, { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })

    // The delta is what used to re-order the screen; wait for it to have
    // answered at least once, then keep sampling for as long as the turn runs.
    await expect
      .poll(() => state.deltaReads, { timeout: 30_000, message: "the reopen asked for the delta" })
      .toBeGreaterThanOrEqual(1)

    const deadline = Date.now() + 6_000
    let worst = ""
    while (Date.now() < deadline) {
      const text = await transcriptText(page)
      const prompt = positionOf(text, RETURN_PROMPT)
      const reply = positionOf(text, RETURN_REPLY)
      if (prompt < 0 || reply < 0 || reply < prompt) {
        worst = text
        break
      }
      await page.waitForTimeout(300)
    }
    expect(
      worst === "",
      `the reply was painted above the prompt it answers:\n${worst.slice(0, 800)}`,
    ).toBe(true)
  })

  test("a return mid-turn shows the turn as running instead of finished", async ({ page }) => {
    const state = await installMocks(page)
    await openProjectChat(page)

    moveToRunningTurn(state)
    await page.reload()

    // Within 2 s of the transcript painting, the running turn must not claim a
    // duration, and Stop must be offered for it.
    await expect(page.getByText(RETURN_PROMPT, { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })
    const paintedAt = Date.now()
    await expect(
      page.getByLabel("Stop", { exact: false }).first(),
      "the running turn offers Stop as soon as /turn says active",
    ).toBeVisible({ timeout: 2_000 })
    expect(Date.now() - paintedAt, "Stop arrived with the transcript").toBeLessThanOrEqual(2_000)

    const text = await transcriptText(page)
    expect(
      /Worked for \d/.test(text),
      `the running turn is labelled finished:\n${text.slice(0, 800)}`,
    ).toBe(false)
  })

  test("F5 mid-turn on the workspace agent chat reopens the same chat", async ({ page }) => {
    const state = await installMocks(page)
    // The landing chat opens empty; give it one saved row so "the same chat"
    // is something the person can see, and so the panel reads its history.
    state.rows = [savedRow("m-landing", "", "user", RETURN_PROMPT, Date.now() - 60_000)]

    // Sign in and pick the team workspace first: `/` is the workspace agent
    // chat, and a cold context would otherwise land on onboarding.
    await openTeamHome(page)
    await page.goto("/")
    await expect(page.getByText(RETURN_PROMPT, { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })

    // The open chat belongs in the URL, so a reload — or Back — returns to it.
    await expect
      .poll(() => new URL(page.url()).searchParams.get("chatSessionId"), {
        timeout: 20_000,
        message: "the workspace agent chat puts its session in the URL",
      })
      .toBeTruthy()
    const sessionId = new URL(page.url()).searchParams.get("chatSessionId")

    state.sessions.clear()
    await page.reload()

    await expect(page.getByText(RETURN_PROMPT, { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })
    expect(new URL(page.url()).searchParams.get("chatSessionId")).toBe(sessionId)
    expect(state.sessions.has(String(sessionId)), "the reopened chat is the one in the URL").toBe(true)
  })
})
