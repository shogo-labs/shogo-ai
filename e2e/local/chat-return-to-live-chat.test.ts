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

/**
 * What `/stream?snapshot=1` answers with: the whole message so far in one chunk,
 * then the rest of the turn. The resume installs the snapshot in one go
 * (`applyMessageSnapshot`), which is why hiding the stale tail costs nothing.
 */
function snapshotTurn(text: string): string {
  return [
    sseFrame({
      type: "data-message-snapshot",
      data: {
        message: {
          id: "msg_live",
          role: "assistant",
          parts: [
            { type: "data-turn-start", data: { turnId: TURN_ID, startedAt: Date.now() } },
            { type: "text", text },
          ],
        },
      },
    }),
    sseFrame({ type: "text-start", id: "t_live" }),
    sseFrame({ type: "text-delta", id: "t_live", delta: " and more" }),
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
  /** Overrides what `/turn` answers; `null` derives it from `live`. */
  turnStatus: "active" | "completed" | "unknown" | null
  /** How `/stream` answers a resume (SHO-297). */
  streamMode: "replay" | "snapshot" | "error"
  /** Hold the snapshot answer so the rejoin row is observable. */
  streamDelayMs: number
  /** Hold the `/chat-messages` page read so a spec can prove the probe ran first. */
  pageDelayMs: number
  /** When the page read of the current reopen finished. */
  pageResolvedAt: number | null
  /** Text the stale cached reply carries. */
  staleReply: string
  /** Text the live snapshot carries. */
  liveReply: string
  turnRequests: number
  streamCalls: number
  /** When the first `/turn` of the current reopen was answered. */
  turnFirstAt: number | null
  /** When the delta of the current reopen finished. */
  deltaResolvedAt: number | null
}

async function installMocks(page: Page): Promise<ReturnState> {
  const state: ReturnState = {
    rows: [],
    live: false,
    pageReads: 0,
    deltaReads: 0,
    deltaDelayMs: 0,
    sessions: new Set<string>(),
    turnStatus: null,
    streamMode: "replay",
    streamDelayMs: 0,
    pageDelayMs: 0,
    pageResolvedAt: null,
    staleReply: "old-words",
    liveReply: "new-words",
    turnRequests: 0,
    streamCalls: 0,
    turnFirstAt: null,
    deltaResolvedAt: null,
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
    state.turnRequests += 1
    if (state.turnFirstAt === null) state.turnFirstAt = Date.now()
    const status = state.turnStatus ?? (state.live ? "active" : "unknown")
    if (status === "unknown") {
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
      body: JSON.stringify({ status, turnId: TURN_ID }),
    })
  })

  await page.route(STREAM_GLOB, async (route: Route) => {
    state.streamCalls += 1
    if (state.streamMode === "error") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "stream unavailable" }),
      })
      return
    }
    if (state.streamMode === "snapshot") {
      if (state.streamDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, state.streamDelayMs))
      }
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache",
          "X-Turn-Id": TURN_ID,
          "X-Turn-Status": "active",
          "Access-Control-Expose-Headers": "X-Turn-Id, X-Last-Seq, X-Turn-Status",
        },
        body: snapshotTurn(state.liveReply),
      })
      return
    }
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
      state.deltaResolvedAt = Date.now()
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
    if (state.pageDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, state.pageDelayMs))
    }
    state.pageResolvedAt = Date.now()
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

/**
 * Rejoining a turn that is still running (SHO-297).
 *
 * A chat that is not already mounted as a tab paints the half-written reply
 * from when the person left, then waits for the delta and the `/turn` probe
 * before it attaches. For those seconds nothing on screen said the turn was
 * live, so the chat read as frozen. It now hides that stale reply and shows a
 * "Rejoining live reply…" row until the resume snapshot lands.
 */
const REJOIN_ROW = "chat-rejoining-row"

/**
 * Record whether `needle` ever reached the DOM after the watcher is armed.
 *
 * Visibility assertions are point-in-time, and the whole point of the rejoin
 * row is that the stale reply never paints — so an interval sample could miss
 * a one-frame flash. This runs every animation frame and flips a flag the spec
 * reads at the end. Armed through localStorage so the reload that starts the
 * reopen is the moment it starts watching.
 */
async function watchForText(page: Page, needle: string): Promise<void> {
  await page.addInitScript((watched: string) => {
    const w = window as unknown as { __sawWatched?: boolean }
    w.__sawWatched = false
    const armed = () => {
      try {
        return localStorage.getItem("__sho297-watch") === "1"
      } catch {
        return false
      }
    }
    const check = () => {
      if (!armed()) return
      try {
        if (document.body?.innerText.includes(watched)) w.__sawWatched = true
      } catch {
        /* detached document during navigation */
      }
    }
    const loop = () => {
      check()
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }, needle)
}

async function armWatcher(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem("__sho297-watch", "1"))
}

async function sawWatchedText(page: Page): Promise<boolean> {
  return page.evaluate(
    () => Boolean((window as unknown as { __sawWatched?: boolean }).__sawWatched),
  )
}

/**
 * The state a chat is in when someone leaves mid-turn: the prompt is a saved
 * row, and the reply on screen is half-written — no completion frame, so it is
 * an unfinished assistant tail.
 */
function moveToStaleTail(state: ReturnState): void {
  const base = Date.now() - 120_000
  state.rows = [
    savedRow("m-prompt", "", "user", RETURN_PROMPT, base),
    savedRow("m-stale", "", "assistant", state.staleReply, base + 1_000),
  ]
}

test.describe("rejoining a turn that is still running", () => {
  test("a reopen mid-turn hides the stale reply and shows the rejoin row", async ({ page }) => {
    await watchForText(page, "old-words")
    const state = await installMocks(page)
    await openProjectChat(page)

    moveToStaleTail(state)
    // The turn is still running: `/turn` says active, and `/stream` answers with
    // the whole message so far ("new-words") plus the rest of the turn. The
    // delay is what the person sees as "rejoining" instead of a frozen reply.
    state.turnStatus = "active"
    state.streamMode = "snapshot"
    state.streamDelayMs = 1_500
    await armWatcher(page)
    await page.reload()

    await expect(
      page.getByText(RETURN_PROMPT, { exact: false }).first(),
      "the chat reopened",
    ).toBeVisible({ timeout: 60_000 })
    await expect(
      page.getByTestId(REJOIN_ROW),
      "the reopened chat says it is rejoining the live reply",
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByLabel("Stop", { exact: false }).first(),
      "Stop is offered for the turn this window is rejoining",
    ).toBeVisible({ timeout: 2_000 })

    await expect(
      page.getByText("new-words", { exact: false }).first(),
      "the resume snapshot replaces the row with the live reply",
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId(REJOIN_ROW)).toHaveCount(0)

    expect(
      await sawWatchedText(page),
      "the stale half-written reply was painted before the live stream landed",
    ).toBe(false)
  })

  test("the probe runs before the history read finishes", async ({ page }) => {
    const state = await installMocks(page)
    // Opened with nothing saved, so the reopen below has no delta cursor and
    // takes the cold page-read path — the one that used to hold the probe back.
    await openProjectChat(page)

    moveToStaleTail(state)
    state.turnStatus = "active"
    state.streamMode = "snapshot"
    state.streamDelayMs = 1_500
    // The history read is a network round-trip; the probe must not wait behind it.
    state.pageDelayMs = 3_000
    state.turnFirstAt = null
    state.pageResolvedAt = null
    await page.reload()

    await expect(
      page.getByTestId(REJOIN_ROW),
      "the reopen says it is rejoining the live reply",
    ).toBeVisible({ timeout: 60_000 })
    await expect(page.getByLabel("Stop", { exact: false }).first()).toBeVisible({
      timeout: 2_000,
    })

    await expect
      .poll(() => state.pageResolvedAt, { timeout: 30_000, message: "the reopen read history" })
      .not.toBeNull()
    const turnAt = state.turnFirstAt
    const pageAt = state.pageResolvedAt
    expect(turnAt, "the reopen asked /turn").not.toBeNull()
    expect(
      Number(turnAt) < Number(pageAt),
      `the /turn probe (${turnAt}) waited for the history read (${pageAt}) instead of running alongside it`,
    ).toBe(true)
  })

  test("a turn that already finished shows the finished reply, not the row", async ({ page }) => {
    const state = await installMocks(page)
    await openProjectChat(page)

    const base = Date.now() - 60_000
    state.turnStatus = "completed"
    state.rows = [
      savedRow("m-prompt", "", "user", RETURN_PROMPT, base),
      savedRow("m-reply", "", "assistant", "finished-words", base + 1_000),
    ]
    await page.reload()

    await expect(
      page.getByText("finished-words", { exact: false }).first(),
      "history owns the tail again and paints the finished reply",
    ).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId(REJOIN_ROW)).toHaveCount(0)
    expect(state.streamCalls, "a finished turn is not resumed").toBe(0)
  })

  test("an unknown turn puts the saved reply back instead of loading forever", async ({ page }) => {
    const state = await installMocks(page)
    await openProjectChat(page)

    moveToStaleTail(state)
    // The runtime has no buffer for the chat (`/turn` 404s) and history still
    // ends unfinished: SHO-274 behaviour — show what the person read.
    state.turnStatus = "unknown"
    await page.reload()

    await expect(
      page.getByText("old-words", { exact: false }).first(),
      "the saved reply comes back once the probe says there is no live turn",
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      page.getByTestId(REJOIN_ROW),
      "the rejoin row does not spin forever",
    ).toHaveCount(0)
  })

  test("an attach that never lands gives up after 8 s", async ({ page }) => {
    const state = await installMocks(page)
    await openProjectChat(page)

    moveToStaleTail(state)
    state.turnStatus = "active"
    // The turn is live, but the stream never lands: the row must not be forever.
    state.streamMode = "error"
    await page.reload()

    await expect(page.getByTestId(REJOIN_ROW)).toBeVisible({ timeout: 15_000 })
    await expect(
      page.getByText("old-words", { exact: false }).first(),
      "the saved reply is back once rejoining gives up",
    ).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(REJOIN_ROW)).toHaveCount(0)
    await expect(
      page.getByText("Retry", { exact: true }).first(),
      "the transport error offers Retry",
    ).toBeVisible({ timeout: 20_000 })
  })
})
