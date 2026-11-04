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
import { LOCAL_API_BASE, startProjectWithBootstrapTurn } from "./helpers"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

test.setTimeout(240_000)

const CHAT_POST_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"
const STREAM_GLOB = "**/api/{projects,workspaces}/*/chat/*/stream*"
// Playwright's `*` stops at `/`, so this needs `**` to also catch
// `/api/chat-messages/session/:id/changes`.
const MESSAGES_GLOB = "**/api/chat-messages**"
const CONVERSATION_MESSAGES = /\/api\/conversations\/[^/]+\/messages(\?|$)/

const BOOTSTRAP_PROMPT = "Build a tiny app for the resume-replay E2E"
const BOOTSTRAP_REPLY = "Bootstrap done."
/** Written by another client between the two opens; only a delta can carry it. */
const REMOTE_MARKER = "a message another window posted"
/** A busy chat: 50 rows of padded parts, so a page download is ~50 KB. */
const BUSY_HISTORY_SIZE = 50
const HISTORY_ROW_MARKER = "older message"
/** What a reopen may spend on the wire — a delta, not a 50-row page. */
const REOPEN_BYTE_BUDGET = 15_000

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
    parts: JSON.stringify([{ type: "text", text, padding: "x".repeat(1_000) }]),
    createdAt,
    updatedAt: createdAt,
  }
}

/**
 * Epoch millis from a row timestamp. The rows this spec serves carry numbers
 * (that is what the panel's store expects), and `new Date(String(1793404957871))`
 * is an Invalid Date — which silently filtered every "changed" row out of the
 * delta and made the spec fail for the wrong reason (SHO-260).
 */
function msOf(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = new Date(value).getTime()
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

interface HistoryState {
  sessionId: string | null
  rows: Array<Record<string, unknown>>
  /** The number the API reports as the scope's total. */
  total: number
  pageReads: number
  deltaReads: number
  /** Bytes of `/chat-messages` JSON served so far — the card is about wire cost. */
  bytes: number
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
    bytes: 0,
    lastDelta: null,
    deltaDelayMs: 0,
    deltaPending: false,
    forceReset: false,
  }

  // A busy chat looking like the ones the card is about: 50 rows whose `parts`
  // are big, so re-downloading the page is unmistakable in bytes on the wire.
  // Installed before the first paint: the cold open's cursor seed must report
  // the same total the page does, or the next delta looks like a mismatch.
  const base = Date.now() - 3_600_000
  state.rows = Array.from({ length: BUSY_HISTORY_SIZE }, (_, index) =>
    savedRow(
      `m-${index}`,
      "",
      index % 2 === 0 ? "user" : "assistant",
      `${HISTORY_ROW_MARKER}-${index}`,
      base + index * 60_000,
    ),
  )
  state.rows.push(savedRow("m-reply", "", "assistant", BOOTSTRAP_REPLY, Date.now() - 60_000))
  state.total = state.rows.length

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
    const sessionId = state.sessionId ?? url.searchParams.get("sessionId") ?? "session-under-test"

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
        : state.rows
            .filter((row) => msOf(row.updatedAt) >= since)
            .map((row) => ({ ...row, sessionId }))
      // The real route answers with the newest `updatedAt` in scope, and with
      // the scope's newest row when nothing changed — never by echoing `since`.
      // Echoing it would walk the client's floor 5 s backwards on every quiet
      // reopen (the client sends `cursor − 5 s`) and hide a real regression.
      let cursor = 0
      for (const row of state.rows) {
        const at = msOf(row.updatedAt)
        if (at > cursor) cursor = at
      }
      const body = {
        ok: true,
        items,
        total: state.total,
        cursor: cursor ? new Date(cursor).toISOString() : new Date(since).toISOString(),
        reset: state.forceReset,
      }
      const size = JSON.stringify(body).length
      state.bytes += size
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
    const newestFirst = state.rows
      .map((row) => ({ ...row, sessionId }))
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
    const pageBody = JSON.stringify({
      ok: true,
      items: newestFirst.slice(offset, offset + limit),
      total: state.total,
    })
    state.bytes += pageBody.length
    await route.fulfill({ status: 200, contentType: "application/json", body: pageBody })
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
        const open = indexedDB.open("shogo-chat-history")
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

    // The history must already agree with the page the cold open serves when it
    // seeds its cursor: a seed taken against an empty history reports total 0,
    // and the next delta then looks like a count mismatch and re-downloads.
    expect(state.rows.length, "the fixture history is installed before the first paint").toBe(
      BUSY_HISTORY_SIZE + 1,
    )
    expect(state.total).toBe(BUSY_HISTORY_SIZE + 1)

    // The cold open is the one time the page is downloaded; its first paint
    // seeds the delta cursor from a `/changes` call.
    await expect
      .poll(() => state.pageReads, { timeout: 60_000, message: "the cold open downloads the page" })
      .toBeGreaterThanOrEqual(1)
    await waitForStoredHistory(page)
    await expect
      .poll(() => state.deltaReads, { timeout: 20_000, message: "the cold open seeded a cursor" })
      .toBeGreaterThanOrEqual(1)
    const deltaReadsAfterColdOpen = state.deltaReads

    // The cold page alone is ~50 KB; that is the number a reopen must not repeat.
    expect(state.bytes, "the cold open really did download a padded page").toBeGreaterThan(
      REOPEN_BYTE_BUDGET,
    )

    // AC1: the reload paints from the device — before the delta can answer,
    // and without either loader (SHO-309).
    await watchForLoaders(page)
    const bytesBeforeReopen = state.bytes
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
    expect(
      await loaderHits(page),
      "a reopen may not show \"Loading conversation...\" for a chat the device holds",
    ).toEqual([])
    await expect
      .poll(() => state.deltaPending, { timeout: 20_000, message: "the delta answered" })
      .toBe(false)

    // AC1 + AC2: the reopen must not spend a page on the wire. Measured in bytes
    // rather than request counts because more than one part of the page reads
    // this chat, and only the volume tells a delta from a re-download.
    const reopenBytes = state.bytes - bytesBeforeReopen
    expect(reopenBytes, "the reopen must not re-download the page").toBeLessThan(
      REOPEN_BYTE_BUDGET,
    )
    expect(state.deltaReads, "the reopen asks for the delta").toBeGreaterThanOrEqual(
      deltaReadsAfterColdOpen + 1,
    )
    // AC1: the answer is a handful of rows, never 50 with their parts.
    expect(state.lastDelta?.items ?? -1).toBeLessThanOrEqual(2)
    expect(state.lastDelta?.size ?? Infinity).toBeLessThan(2_048)

    // AC3: a row written elsewhere rides in on the delta.
    const bytesBeforeDeltaReopen = state.bytes
    state.deltaDelayMs = 0
    state.rows.push(savedRow("m-remote", "", "user", REMOTE_MARKER, Date.now()))
    state.total = state.rows.length
    await page.reload()
    await expect(
      page.getByText(REMOTE_MARKER, { exact: false }).first(),
      "a message written by another window arrives via the delta",
    ).toBeVisible({ timeout: 30_000 })
    expect(
      state.bytes - bytesBeforeDeltaReopen,
      "the delta carried the new row, no page needed",
    ).toBeLessThan(REOPEN_BYTE_BUDGET)

    // AC2: `reset` sends the client back to the full page.
    state.forceReset = true
    const pageReadsBeforeReset = state.pageReads
    await page.reload()
    await expect
      .poll(() => state.pageReads, { timeout: 30_000, message: "reset forces a full page" })
      .toBeGreaterThan(pageReadsBeforeReset)
  })

  test("a row count that does not add up falls back to the full page", async ({ page }) => {
    const state = await installMocks(page)
    await startProjectWithBootstrapTurn(page)
    await expect.poll(() => state.pageReads, { timeout: 60_000 }).toBeGreaterThanOrEqual(1)
    await waitForStoredHistory(page)
    await expect.poll(() => state.deltaReads, { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
    const pageReadsAfterColdOpen = state.pageReads

    // A truncate-from or an edit that re-sent the tail: the scope shrank and the
    // delta cannot express the deletion, so the count is the only signal.
    // The one row the server still has is the prompt itself, so the assertion
    // below can only pass if the re-downloaded page is what reaches the screen —
    // the prompt is never served by the cold page, only by this one.
    const kept = state.rows[0]
    state.rows = [
      {
        ...kept,
        role: "user",
        content: BOOTSTRAP_PROMPT,
        parts: JSON.stringify([{ type: "text", text: BOOTSTRAP_PROMPT }]),
      },
    ]
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

// ─── SHO-309: a reopen shows no loader at all ────────────────────────────────
//
// Two loaders used to run in series on every open — the workspace screen's
// "Preparing Workspace Agent Chat…" (it threw away the session and profile it
// had just resolved) and the panel's "Loading conversation..." (it started
// empty on a chat whose transcript was already on the device). These watch the
// DOM from navigation start, so a one-frame flash counts.

const PREPARING_LOADER = "Preparing Workspace Agent Chat"
const TRANSCRIPT_LOADER = "Loading conversation"

/**
 * Record every appearance of either loader in this document. Installed with
 * `addInitScript`, so it also runs on a reload — the case a spec that only
 * looks at the network cannot see.
 */
async function watchForLoaders(page: Page): Promise<void> {
  await page.addInitScript(
    (needles: string[]) => {
      const scope = window as unknown as { __loaderHits?: string[] }
      scope.__loaderHits = []
      const record = (text: string) => {
        for (const needle of needles) {
          if (text.includes(needle)) scope.__loaderHits!.push(needle)
        }
      }
      // Nodes the router mounts (either loader is its own subtree).
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) recordText(node)
        }
      }).observe(document, { childList: true, subtree: true })
      function recordText(node: Node) {
        record(node.textContent ?? "")
      }
      // …and a frame-level sweep, for a loader whose text an existing node
      // has re-rendered into (React updates the text node in place).
      const startedAt = Date.now()
      const sweep = () => {
        if (document.body) record(document.body.textContent ?? "")
        if (Date.now() - startedAt < 30_000) requestAnimationFrame(sweep)
      }
      requestAnimationFrame(sweep)
    },
    [PREPARING_LOADER, TRANSCRIPT_LOADER],
  )
}

/** The loader text seen in the document currently on screen. */
async function loaderHits(page: Page): Promise<string[]> {
  return page.evaluate(
    () => ((window as unknown as { __loaderHits?: string[] }).__loaderHits ?? []) as string[],
  )
}

async function personalWorkspaceId(page: Page): Promise<string> {
  const res = await page.request.get(`${LOCAL_API_BASE}/api/workspaces`)
  const json = await res.json()
  const items = (json?.items ?? json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
  const id = items.find((w) => w.kind === "personal")?.id
  if (!id) throw new Error(`local stack has no personal workspace: ${JSON.stringify(json)}`)
  return id
}

/** Whether the device holds this workspace agent chat's opening identity. */
async function bootRecordStored(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open("shogo-chat-history")
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains("boot")) return resolve(false)
          const request = db.transaction("boot", "readonly").objectStore("boot").getAll()
          request.onsuccess = () =>
            resolve(
              (request.result ?? []).some(
                (row: any) =>
                  typeof row?.entry?.profile?.name === "string" &&
                  row.entry.profile.name === "Mina",
              ),
            )
          request.onerror = () => resolve(false)
        }
        open.onerror = () => resolve(false)
        open.onblocked = () => resolve(false)
      }),
  )
}

const WORKSPACE_REPLY = "a workspace chat the device has already seen"

interface WorkspaceChatState {
  workspaceId: string
  sessionId: string
  rows: Array<Record<string, unknown>>
  total: number
  pageReads: number
  deltaReads: number
  bytes: number
  primaryReads: number
  profileReads: number
  deltaPending: boolean
  delayMs: number
}

/**
 * A workspace agent chat whose *opening identity* and transcript are served
 * slowly, so anything on screen before they answer came from the device.
 */
async function installWorkspaceChatMocks(
  page: Page,
  workspaceId: string,
): Promise<WorkspaceChatState> {
  const state: WorkspaceChatState = {
    workspaceId,
    sessionId: "ws-session-under-test",
    rows: [],
    total: 0,
    pageReads: 0,
    deltaReads: 0,
    bytes: 0,
    primaryReads: 0,
    profileReads: 0,
    deltaPending: false,
    delayMs: 0,
  }
  const base = Date.now() - 600_000
  state.rows = [
    savedRow(`ws-${0}`, state.sessionId, "user", "open the workspace chat", base),
    savedRow(`ws-${1}`, state.sessionId, "assistant", WORKSPACE_REPLY, base + 60_000),
  ]
  state.total = state.rows.length

  const slow = async () => {
    if (!state.delayMs) return
    await new Promise((resolve) => setTimeout(resolve, state.delayMs))
  }

  // The primary session and the agent profile are exactly the two calls the
  // screen used to block its first paint on.
  await page.route("**/api/workspaces/*/sessions/primary", async (route: Route) => {
    state.primaryReads += 1
    await slow()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session: { id: state.sessionId, workspaceId: state.workspaceId, isPrimary: true },
      }),
    })
  })

  await page.route("**/api/workspaces/*/agent-profile", async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue()
    state.profileReads += 1
    await slow()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        profile: {
          name: "Mina",
          avatarUrl: null,
          tagline: "your agent",
          personality: "warm",
          statusText: null,
        },
      }),
    })
  })

  await page.route(MESSAGES_GLOB, async (route: Route) => {
    const request = route.request()
    if (request.method() !== "GET") return route.continue()
    const url = new URL(request.url())
    const sessionId = state.sessionId

    if (url.pathname.endsWith("/changes")) {
      state.deltaReads += 1
      state.deltaPending = true
      await slow()
      const sinceRaw = url.searchParams.get("since")
      const since = sinceRaw ? new Date(sinceRaw).getTime() : 0
      const items = state.rows
        .filter((row) => msOf(row.updatedAt) >= since)
        .map((row) => ({ ...row, sessionId }))
      let cursor = 0
      for (const row of state.rows) {
        const at = msOf(row.updatedAt)
        if (at > cursor) cursor = at
      }
      const body = {
        ok: true,
        items,
        total: state.total,
        cursor: cursor ? new Date(cursor).toISOString() : new Date(since).toISOString(),
        reset: false,
      }
      state.bytes += JSON.stringify(body).length
      state.deltaPending = false
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      })
      return
    }

    state.pageReads += 1
    await slow()
    const pageBody = JSON.stringify({
      ok: true,
      items: state.rows.map((row) => ({ ...row, sessionId })),
      total: state.total,
    })
    state.bytes += pageBody.length
    await route.fulfill({ status: 200, contentType: "application/json", body: pageBody })
  })

  return state
}

test.describe("a workspace agent chat opens from the device", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("reopening it shows neither loader, in-app or on a reload", async ({ page }) => {
    await watchForLoaders(page)
    await signIn(page)
    const state = await installWorkspaceChatMocks(page, await personalWorkspaceId(page))

    await page.goto("/")
    const chats = page.getByTestId("workspace-chats-panel")
    await expect(chats).toBeVisible({ timeout: 90_000 })
    const row = chats.getByRole("link", { name: /^Chat: / }).first()
    await expect(row).toBeVisible({ timeout: 60_000 })

    // ── The first-ever open: the device holds nothing, so the loader is honest
    // and the chat arrives when the network answers.
    state.delayMs = 1_500
    await row.click()
    await expect
      .poll(() => loaderHits(page), { timeout: 60_000, message: "first open waits for the chat" })
      .toContain(PREPARING_LOADER)
    await expect(page.getByText(WORKSPACE_REPLY, { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })
    await waitForStoredHistory(page)
    // What the screen resolved is now on the device: that is what the next
    // open paints (SHO-309).
    await expect
      .poll(() => bootRecordStored(page), {
        timeout: 20_000,
        message: "the screen stored the chat it opens",
      })
      .toBe(true)

    // ── Reopening inside the app: back to the list, then forward into the chat
    // again — a client-side round trip, no document reload.
    await page.goBack()
    await expect(chats).toBeVisible({ timeout: 60_000 })
    const hitsBeforeInApp = (await loaderHits(page)).length
    const pageReadsBeforeInApp = state.pageReads
    state.delayMs = 2_500
    await page.goForward()
    await expect(
      page.getByText(WORKSPACE_REPLY, { exact: false }).first(),
      "the chat is painted from the device while the session and profile are still in flight",
    ).toBeVisible({ timeout: 20_000 })
    expect(
      (await loaderHits(page)).slice(hitsBeforeInApp),
      "neither loader may appear when the chat is reopened inside the app",
    ).toEqual([])
    expect(state.pageReads, "an in-app reopen must not download the page again").toBe(
      pageReadsBeforeInApp,
    )

    // ── Reopening by a full reload. The device is cold; the store is not.
    const bytesBeforeReload = state.bytes
    const pageReadsBeforeReload = state.pageReads
    await page.reload()
    await expect(
      page.getByText(WORKSPACE_REPLY, { exact: false }).first(),
      "a reload paints the transcript from the device",
    ).toBeVisible({ timeout: 30_000 })
    expect(await loaderHits(page), "neither loader may appear on a reload").toEqual([])
    expect(
      state.pageReads,
      "the reopen must not download the chat's first page again",
    ).toBe(pageReadsBeforeReload)
    expect(state.deltaReads, "the reopen asks only for what changed").toBeGreaterThan(0)
    expect(state.bytes - bytesBeforeReload, "the reopen stays small on the wire").toBeLessThan(
      REOPEN_BYTE_BUDGET,
    )
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
      // Other parts of the channel page fetch the conversation too, so the
      // absolute count is not the timeline's own. What must not happen is the
      // reopen downloading *more* full pages than the cold open did — with the
      // timeline's own first page on top, a re-download makes it grow.
      const coldOpen = reads.slice(0, coldOpenReads)
      expect(
        reopen.filter((read) => !read.changedSince).length,
        "the reopen must not re-download the channel's newest page",
      ).toBeLessThanOrEqual(coldOpen.filter((read) => !read.changedSince).length)
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
          const open = indexedDB.open("shogo-chat-history")
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
