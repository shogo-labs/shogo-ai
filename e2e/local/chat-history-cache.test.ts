// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-260 — chat history lives on the device; a reopen asks only for what changed.
 *
 * Before this card every open of a chat downloaded its newest page again: 50
 * rows with their `parts` (tool inputs/outputs), a `count(*)`, an
 * `authorizeChatSession` and a `reconcileCallReplyOnRead` — on every activation
 * older than 5s, on every surface, even when nothing had changed. These specs
 * hold the Gmail model to the promises in the card:
 *
 *   1. Reopening a chat you have seen — including after a full reload — paints
 *      from the device (painted before the delta even answers) and makes
 *      exactly one `…/changes` request whose body is tiny.
 *   2. The full first page is downloaded only when the device has no slice for
 *      that chat, or when the server says `reset` / the row count does not add
 *      up.
 *   3. A row written elsewhere rides in on the delta, and rows this device
 *      already has are not duplicated.
 *   4. Team chat: a channel you have opened does not ask for
 *      `messages?limit=50` again — it asks `changedSince` instead.
 *
 * Note on "0 items": the client sends `cursor − 5 s` so clock skew cannot hide
 * a change, and the server's floor is inclusive, so a steady-state delta echoes
 * the newest row back once (harmless — the merge is by id). The assertion here
 * is therefore "a handful of rows and a body under 2 KB", not literally zero.
 *
 * The project-chat half mocks `/api/chat-messages*` (page + `/session/:id/changes`)
 * and the chat stream, so it needs no model and no keys; the local API still
 * serves workspaces, projects and sessions and the panel is the real one. The
 * team-chat half seeds a real channel through the API and drives the real
 * timeline.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-history-cache --project chromium
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { startProjectWithBootstrapTurn } from "./helpers"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

test.setTimeout(240_000)

const CHAT_POST_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"
const STREAM_GLOB = "**/api/{projects,workspaces}/*/chat/*/stream*"
const MESSAGES_GLOB = "**/api/chat-messages*"
const CONVERSATION_MESSAGES = /\/api\/conversations\/[^/]+\/messages(\?|$)/

const BOOTSTRAP_PROMPT = "Build a tiny app for the resume-replay E2E"
const BOOTSTRAP_REPLY = "Bootstrap done."
/** Written by another client between the two opens; only a delta can carry it. */
const REMOTE_MARKER = "a message another window posted"

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

interface HistoryState {
  sessionId: string | null
  rows: Array<Record<string, unknown>>
  /** The number the API reports as the scope's total. */
  total: number
  pageReads: number
  deltaReads: number
  lastDelta: { size: number; items: number; reset: boolean } | null
  /** Hold the delta response so a spec can prove the paint came from the device. */
  deltaDelayMs: number
  deltaPending: boolean
  forceReset: boolean
}

/**
 * Mock the project chat's reads and stream for one window. `/changes` is
 * answered from the same in-memory rows as the page, with the same inclusive
 * `updatedAt >= since` floor the real route uses, so a spec can move a row and
 * see exactly what the client asks for — and what it paints.
 */
async function installMocks(page: Page): Promise<HistoryState> {
  const state: HistoryState = {
    sessionId: null,
    rows: [],
    total: 0,
    pageReads: 0,
    deltaReads: 0,
    lastDelta: null,
    deltaDelayMs: 0,
    deltaPending: false,
    forceReset: false,
  }

  await page.route(CHAT_POST_GLOB, async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue()
    state.sessionId =
      state.sessionId ?? route.request().headers()["x-chat-session-id"] ?? null
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: completedTurn("msg_bootstrap", BOOTSTRAP_REPLY),
    })
  })

  await page.route(TURN_GLOB, async (route: Route) => {
    // Nothing is running: the bootstrap turn finished.
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
    const request = route.request()
    if (request.method() !== "GET") return route.continue()
    const url = new URL(request.url())

    if (url.pathname.endsWith("/changes")) {
      state.deltaReads += 1
      state.deltaPending = true
      if (state.deltaDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, state.deltaDelayMs))
      }
      const sinceRaw = url.searchParams.get("since")
      const since = sinceRaw ? new Date(sinceRaw).getTime() : 0
      const items = state.forceReset
        ? []
        : state.rows.filter((row) => new Date(String(row.updatedAt)).getTime() >= since)
      let cursor = since
      for (const row of items) {
        const at = new Date(String(row.updatedAt)).getTime()
        if (at > cursor) cursor = at
      }
      const body = {
        ok: true,
        items,
        total: state.total,
        cursor: new Date(cursor).toISOString(),
        reset: state.forceReset,
      }
      const size = JSON.stringify(body).length
      state.lastDelta = { size, items: items.length, reset: state.forceReset }
      state.deltaPending = false
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      })
      return
    }

    state.pageReads += 1
    const limit = Number(url.searchParams.get("limit") || 50)
    const offset = Number(url.searchParams.get("offset") || 0)
    // The API answers newest first; the panel sorts ascending itself.
    const newestFirst = [...state.rows].sort(
      (a, b) => Number(b.createdAt) - Number(a.createdAt),
    )
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        items: newestFirst.slice(offset, offset + limit),
        total: state.total,
      }),
    })
  })

  return state
}

/**
 * Wait until the device actually holds this chat's slice — the store is what
 * makes a reopen free, so a spec must not race the write.
 */
async function waitForStoredHistory(page: Page, timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const count = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase | null>((resolve) => {
        const open = indexedDB.open("shogo-chat-history", 1)
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => resolve(null)
        open.onblocked = () => resolve(null)
      })
      if (!db) return -1
      return new Promise<number>((resolve) => {
        if (!db.objectStoreNames.contains("project")) return resolve(0)
        const request = db.transaction("project", "readonly").objectStore("project").getAll()
        request.onsuccess = () => resolve(request.result.length)
        request.onerror = () => resolve(-1)
      })
    })
    if (count > 0) return count
    await page.waitForTimeout(250)
  }
  throw new Error("the device never stored this chat's history")
}

test.describe("project chat keeps its history on the device", () => {
  test("a reopen paints from the device and asks only what changed", async ({ page }) => {
    const state = await installMocks(page)
    await startProjectWithBootstrapTurn(page)

    // What the chat's history holds, as the API would serve it.
    const base = Date.now() - 60_000
    const sessionId = () => state.sessionId ?? "session-under-test"
    state.rows = [
      savedRow("m-user", sessionId(), "user", BOOTSTRAP_PROMPT, base),
      savedRow("m-reply", sessionId(), "assistant", BOOTSTRAP_REPLY, base + 1_000),
    ]
    state.total = state.rows.length

    // The cold open is the one time the page is downloaded; its first paint
    // seeds the delta cursor from a `/changes` call.
    await expect
      .poll(() => state.pageReads, { timeout: 60_000, message: "the cold open downloads the page" })
      .toBeGreaterThanOrEqual(1)
    await waitForStoredHistory(page)
    await expect
      .poll(() => state.deltaReads, { timeout: 20_000, message: "the cold open seeded a cursor" })
      .toBeGreaterThanOrEqual(1)
    const pageReadsAfterColdOpen = state.pageReads
    const deltaReadsAfterColdOpen = state.deltaReads

    // AC1: the reload paints from the device — before the delta can answer.
    state.deltaDelayMs = 2_000
    await page.reload()
    await expect
      .poll(() => state.deltaPending, {
        timeout: 30_000,
        message: "the reopen asks for the delta",
      })
      .toBe(true)
    // The request is still held: anything on screen came from the device.
    await expect(
      page.getByText(BOOTSTRAP_REPLY, { exact: false }).first(),
      "the transcript is painted from the device, before /changes answers",
    ).toBeVisible()
    await expect
      .poll(() => state.deltaPending, { timeout: 20_000, message: "the delta answered" })
      .toBe(false)

    // AC2: no full page on the reopen.
    expect(state.pageReads, "the reopen must not download the page again").toBe(
      pageReadsAfterColdOpen,
    )
    expect(state.deltaReads, "exactly one delta request per reopen").toBe(
      deltaReadsAfterColdOpen + 1,
    )
    // AC1: the answer is small — a handful of rows, never 50 with their parts.
    expect(state.lastDelta?.items ?? -1).toBeLessThanOrEqual(2)
    expect(state.lastDelta?.size ?? Infinity).toBeLessThan(2_048)

    // AC3: a row written elsewhere rides in on the delta.
    state.deltaDelayMs = 0
    state.rows.push(savedRow("m-remote", sessionId(), "user", REMOTE_MARKER, Date.now()))
    state.total = state.rows.length
    await page.reload()
    await expect(
      page.getByText(REMOTE_MARKER, { exact: false }).first(),
      "a message written by another window arrives via the delta",
    ).toBeVisible({ timeout: 30_000 })
    expect(state.pageReads, "the delta carried the new row, no page needed").toBe(
      pageReadsAfterColdOpen,
    )

    // AC2: `reset` sends the client back to the full page.
    state.forceReset = true
    await page.reload()
    await expect
      .poll(() => state.pageReads, { timeout: 30_000, message: "reset forces a full page" })
      .toBeGreaterThan(pageReadsAfterColdOpen)
  })

  test("a row count that does not add up falls back to the full page", async ({ page }) => {
    const state = await installMocks(page)
    await startProjectWithBootstrapTurn(page)
    const base = Date.now() - 60_000
    const sessionId = () => state.sessionId ?? "session-under-test"
    state.rows = [
      savedRow("m-user", sessionId(), "user", BOOTSTRAP_PROMPT, base),
      savedRow("m-reply", sessionId(), "assistant", BOOTSTRAP_REPLY, base + 1_000),
    ]
    state.total = state.rows.length
    await expect.poll(() => state.pageReads, { timeout: 60_000 }).toBeGreaterThanOrEqual(1)
    await waitForStoredHistory(page)
    await expect.poll(() => state.deltaReads, { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
    const pageReadsAfterColdOpen = state.pageReads

    // A truncate-from or an edit that re-sent the tail: the scope shrank and the
    // delta cannot express the deletion, so the count is the only signal.
    state.rows = state.rows.slice(0, 1)
    state.total = 1
    await page.reload()
    await expect
      .poll(() => state.pageReads, {
        timeout: 30_000,
        message: "a count mismatch must re-download the page",
      })
      .toBeGreaterThan(pageReadsAfterColdOpen)
    await expect(page.getByText(BOOTSTRAP_PROMPT, { exact: false }).first()).toBeVisible()
  })
})

test.describe("team chat keeps its history on the device", () => {
  test("reopening a channel asks only what changed", async ({ page }) => {
    await signIn(page)
    const workspaceId = await teamWorkspaceId(page)
    await activateTeamWorkspace(page, workspaceId)
    const suffix = Date.now().toString(36)
    const channel = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, {
      name: `history-${suffix}`,
      kind: "public",
    })
    const channelId = channel.json?.conversation?.id
    if (!channelId) throw new Error(`channel create failed: ${JSON.stringify(channel.json)}`)

    const marker = `history-marker-${suffix}`
    try {
      for (let i = 0; i < 3; i += 1) {
        await api(page, "POST", `/api/conversations/${channelId}/messages`, {
          text: `${marker}-${i}`,
          clientMsgId: crypto.randomUUID(),
        })
      }

      /** Every timeline read of this channel: a page read or a delta read. */
      const reads: Array<{ changedSince: boolean }> = []
      page.on("request", (request) => {
        if (request.method() !== "GET") return
        const url = new URL(request.url())
        if (!CONVERSATION_MESSAGES.test(`${url.pathname}?`)) return
        reads.push({ changedSince: url.searchParams.has("changedSince") })
      })

      await page.goto(`/c/${channelId}`)
      await expect(page.getByText(`${marker}-2`, { exact: false }).first()).toBeVisible({
        timeout: 60_000,
      })
      await waitForTeamHistory(page, channelId)

      const coldOpenReads = reads.length
      expect(coldOpenReads, "the cold open downloads the newest page").toBeGreaterThan(0)

      // AC1 for team chat: the reopen asks `changedSince`, never the page again.
      await page.reload()
      await expect(page.getByText(`${marker}-2`, { exact: false }).first()).toBeVisible({
        timeout: 30_000,
      })
      await expect
        .poll(() => reads.slice(coldOpenReads).length, { timeout: 20_000 })
        .toBeGreaterThan(0)
      const reopen = reads.slice(coldOpenReads)
      expect(
        reopen.filter((read) => read.changedSince).length,
        "the reopen asked for the delta",
      ).toBeGreaterThan(0)
      expect(
        reopen.filter((read) => !read.changedSince).length,
        "the reopen must not download the channel's newest page again",
      ).toBe(0)
    } finally {
      await api(page, "PATCH", `/api/conversations/${channelId}`, { archived: true }).catch(
        () => {},
      )
    }
  })
})

/** Wait for the team-chat slice to reach the device, keyed by the channel id. */
async function waitForTeamHistory(
  page: Page,
  channelId: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await page.evaluate(
      (id) =>
        new Promise<boolean>((resolve) => {
          const open = indexedDB.open("shogo-chat-history", 1)
          open.onsuccess = () => {
            const db = open.result
            if (!db.objectStoreNames.contains("team")) return resolve(false)
            const request = db.transaction("team", "readonly").objectStore("team").getAllKeys()
            request.onsuccess = () =>
              resolve(request.result.some((key) => String(key).includes(id)))
            request.onerror = () => resolve(false)
          }
          open.onerror = () => resolve(false)
          open.onblocked = () => resolve(false)
        }),
      channelId,
    )
    if (found) return
    await page.waitForTimeout(250)
  }
  throw new Error("the device never stored this channel's timeline")
}
