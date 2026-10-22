// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-148 — clicking "Send now" on a queued message takes it out of the dock.
 *
 * The server's send-now route promotes the row, stops the active turn and then
 * fires the dispatch *without awaiting it*, so it answers with the row still
 * `pending`. The client reloads the queue inside that POST and reads the row
 * before the server has deleted it, and the only thing that would notice the
 * delete afterwards is the 1.5 s poll — which stops the moment the new turn
 * starts streaming. Russell's report: "when I click send on a queued message it
 * should dissapear from the dock because now it has been sent".
 *
 * Four cases, all through the real ChatPanel:
 *   1. a turn is streaming and two rows are queued; Send now on the second one
 *      takes it out of the dock *while the mocked server still holds it* (the
 *      shape `main` gets wrong), the other row stays, and the sent message
 *      reaches the transcript exactly once with its reply, never coming back.
 *   2. idle session with a row the server restored (queued by an earlier
 *      window, so this one never enqueued it): it leaves the dock on the click
 *      and its turn runs.
 *   3. the send-now POST is refused: the row stays in the dock and can be sent
 *      again.
 *   4. the dispatch fails after the POST: the row comes back with its error and
 *      can be deleted.
 *
 * The queue is the server's — `rows` stands in for the `chat_queued_message`
 * table, so the spec decides when a row is dispatched. Queue, history and turn
 * probe are `page.route` mocks; the chat POST and the resume stream are patched
 * on `window.fetch` so they really stream (a `route.fulfill` SSE body arrives
 * as one chunk and never renders "streaming").
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-send-now-leaves-dock --project chromium --retries 0
 */
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Route,
} from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"

test.setTimeout(180_000)

const CHAT_URL_GLOB = "**/api/{projects,workspaces}/*/chat"
const QUEUE_URL_GLOB = "**/api/chat-queued-messages**"
const MESSAGES_GLOB = "**/api/chat-messages*"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"

/** Per-frame gap for the mocked streams (the same cadence SHO-147's spec uses). */
const FRAME_MS = 120

const AGENT_STOP_SELECTOR = '[data-testid="stop-streaming"], [aria-label="Stop"]'
const SEND_NOW_LABEL = "Send queued message now"
const DELETE_LABEL = "Delete queued message"

type QueueRow = Record<string, unknown>

/**
 * What POST /:id/send-now does in the mocked server.
 * `hold`  — promote the row and keep it: the real dispatch latency.
 * `refuse`— 502, nothing was sent.
 * `fail`  — promote it and leave it `failed` with its error.
 */
type SendNowMode = "hold" | "refuse" | "fail"

type QueueState = {
  /** The server's queue table. */
  rows: QueueRow[]
  sendNowMode: SendNowMode
  /** Ids the client asked to send now, in order. */
  sendNowCalls: string[]
  nextRowId: number
  /** Saved chat messages, oldest first. */
  history: Array<{ id: string; role: "user" | "assistant"; text: string }>
  leadEnded: boolean
  sentTurnActive: boolean
  sentTurnEnded: boolean
  sessionId: string | null
  chatPosts: number
}

function newState(): QueueState {
  return {
    rows: [],
    sendNowMode: "hold",
    sendNowCalls: [],
    nextRowId: 0,
    history: [],
    leadEnded: false,
    sentTurnActive: false,
    sentTurnEnded: false,
    sessionId: null,
    chatPosts: 0,
  }
}

/** A row already on the server's queue, queued by a window before this one. */
function restoredRow(content: string, id = "queue-e2e-restored"): QueueRow {
  return {
    id,
    sessionId: "queued-elsewhere",
    userId: "local-e2e-user",
    position: 0,
    status: "pending",
    content,
    parts: JSON.stringify([{ type: "text", text: content }]),
    body: "{}",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * The server dispatching `ids`: it saves each row as a user message (with the
 * row's own id) and starts its turn, so the rows leave the queue.
 */
function dispatchRows(state: QueueState, ...ids: string[]) {
  for (const id of ids) {
    const index = state.rows.findIndex((row) => row.id === id)
    if (index < 0) continue
    const [row] = state.rows.splice(index, 1)
    state.history.push({ id: String(row.id), role: "user", text: String(row.content) })
    state.rows.forEach((candidate, position) => {
      candidate.position = position
    })
  }
}

/**
 * Patch `window.fetch` so the chat POST and the resume stream really stream.
 * Everything else is left to the network so `page.route` answers it.
 *
 * The lead turn is *gated*: it streams its text and then holds the stream open
 * until the spec sets `__sho148ReleaseLead`, which is how the spec gets a
 * genuinely streaming turn to queue and click Send now inside.
 */
async function installStreamingFetch(
  page: Page,
  state: QueueState,
  prompts: { lead: string; leadReply: string; sentReply: string },
): Promise<void> {
  await page.exposeFunction("__sho148LeadStarted", () => {
    state.chatPosts += 1
  })
  await page.exposeFunction("__sho148LeadEnded", () => {
    state.leadEnded = true
  })
  await page.exposeFunction("__sho148SentReplayStarted", () => {
    state.sentTurnActive = true
  })
  await page.exposeFunction("__sho148SentReplayEnded", () => {
    state.sentTurnEnded = true
  })

  await page.addInitScript(
    ({ frameMs, lead, leadReply, sentReply }) => {
      const originalFetch = window.fetch.bind(window)
      const encoder = new TextEncoder()
      const frame = (event: Record<string, unknown>) =>
        `data: ${JSON.stringify(event)}\n\n`
      const head = (messageId: string, text: string) => {
        const frames = [
          frame({ type: "start", messageId }),
          frame({ type: "start-step" }),
          frame({ type: "text-start", id: `${messageId}-t` }),
        ]
        text.split(" ").forEach((word, index) => {
          frames.push(
            frame({
              type: "text-delta",
              id: `${messageId}-t`,
              delta: index === 0 ? word : ` ${word}`,
            }),
          )
        })
        return frames
      }
      const tail = (messageId: string, turnId: string) => [
        frame({ type: "text-end", id: `${messageId}-t` }),
        frame({ type: "finish-step" }),
        frame({
          type: "data-turn-complete",
          data: { turnId, status: "completed", lastSeq: 1, completedAt: Date.now() },
        }),
        frame({ type: "finish", finishReason: "stop" }),
      ]

      const respond = (
        headFrames: string[],
        tailFrames: string[],
        opts: { gated?: boolean; onEnd?: () => void } = {},
      ) =>
        new Response(
          new ReadableStream({
            start(controller) {
              let index = 0
              let closed = false
              let timer: ReturnType<typeof setInterval> | null = null
              const finish = () => {
                if (closed) return
                closed = true
                for (const chunk of tailFrames) controller.enqueue(encoder.encode(chunk))
                if (timer) clearInterval(timer)
                timer = null
                try {
                  controller.close()
                } catch {
                  // the page cancelled the stream
                }
                opts.onEnd?.()
              }
              const push = () => {
                if (closed) return
                if (index < headFrames.length) {
                  controller.enqueue(encoder.encode(headFrames[index]))
                  index += 1
                  return
                }
                // The gated turn stays open until the spec sends the row: that
                // is the window a person queues and clicks Send now in.
                if (opts.gated && !(window as any).__sho148ReleaseLead) return
                finish()
              }
              push()
              timer = setInterval(push, frameMs)
            },
            cancel() {
              // Stopped by the page: nothing left to emit.
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "X-Turn-Id": "turn_stream",
              "X-Turn-Status": "active",
              "Access-Control-Expose-Headers": "X-Turn-Id, X-Last-Seq, X-Turn-Status",
            },
          },
        )

      const patched = async (input: any, init?: RequestInit): Promise<Response> => {
        const rawUrl =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : String(input)
        const url = new URL(rawUrl, window.location.href)
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
        const chatPost = /^\/api\/(projects|workspaces)\/[^/]+\/chat$/
        const replay = /^\/api\/(projects|workspaces)\/[^/]+\/chat\/[^/]+\/stream/

        if (method === "POST" && chatPost.test(url.pathname)) {
          const body = typeof init?.body === "string" ? init.body : ""
          if (!body.includes(lead)) {
            // The workspace agent's own chat: one finished turn.
            return respond(head("msg_other", "ok"), tail("msg_other", "turn_other"))
          }
          ;(window as any).__sho148LeadStarted?.()
          return respond(
            head("msg_lead_reply", leadReply),
            tail("msg_lead_reply", "turn_lead"),
            { gated: true, onEnd: () => (window as any).__sho148LeadEnded?.() },
          )
        }
        if (method === "GET" && replay.test(url.pathname)) {
          // The send-now turn's own stream: the assistant reply alone. Its user
          // row has to reach the transcript from the panel, not from here.
          ;(window as any).__sho148SentReplayStarted?.()
          return respond(
            head("msg_sent_reply", sentReply),
            tail("msg_sent_reply", "turn_sent"),
            { onEnd: () => (window as any).__sho148SentReplayEnded?.() },
          )
        }
        return originalFetch(input, init)
      }
      window.fetch = patched as typeof window.fetch
    },
    { frameMs: FRAME_MS, ...prompts },
  )
}

function installServerMocks(page: Page, state: QueueState): Promise<unknown> {
  return Promise.all([
    page.route(QUEUE_URL_GLOB, async (route: Route) => {
      const request = route.request()
      const url = new URL(request.url())
      const parts = url.pathname.split("/").filter(Boolean)
      const resourceIndex = parts.indexOf("chat-queued-messages")
      const id = parts[resourceIndex + 1]
      const sessionId = url.searchParams.get("sessionId")

      if (request.method() === "GET") {
        if (sessionId) {
          state.sessionId = sessionId
          // A row queued by an earlier window carries that window's session
          // id; the server's list is per session, so adopt the caller's.
          for (const row of state.rows) row.sessionId = sessionId
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, items: state.rows, total: state.rows.length }),
        })
        return
      }
      if (request.method() === "POST" && parts.length === resourceIndex + 1) {
        const body = request.postDataJSON() as Record<string, unknown>
        const row = {
          id: `queue-e2e-${++state.nextRowId}`,
          sessionId: body.sessionId,
          userId: "local-e2e-user",
          position: state.rows.length,
          status: "pending",
          content: body.content,
          parts: body.parts,
          body: body.body,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        state.rows.push(row)
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: row }),
        })
        return
      }
      if (!id) return route.continue()
      const index = state.rows.findIndex((row) => row.id === id)
      if (request.method() === "PATCH") {
        Object.assign(state.rows[index], request.postDataJSON())
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: state.rows[index] }),
        })
        return
      }
      if (request.method() === "DELETE") {
        if (index >= 0) state.rows.splice(index, 1)
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) })
        return
      }
      if (request.method() === "POST" && parts.at(-1) === "send-now") {
        state.sendNowCalls.push(id)
        if (state.sendNowMode === "refuse") {
          await route.fulfill({
            status: 502,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: { message: "The active turn could not be stopped" },
            }),
          })
          return
        }
        if (index < 0) {
          await route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: { message: "Queued message not found" },
            }),
          })
          return
        }
        // The route promotes the row and stops the turn, then dispatches
        // without waiting — so it answers with the row still on the queue.
        const [promoted] = state.rows.splice(index, 1)
        state.rows.unshift(promoted)
        state.rows.forEach((row, position) => {
          row.position = position
        })
        promoted.updatedAt = Date.now()
        if (state.sendNowMode === "fail") {
          promoted.status = "failed"
          promoted.error = "The turn could not be started"
          promoted.updatedAt = Date.now() + 1
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: promoted }),
        })
        return
      }
      await route.continue()
    }),
    page.route(MESSAGES_GLOB, async (route: Route) => {
      if (route.request().method() !== "GET") return route.continue()
      const url = new URL(route.request().url())
      const limit = Number(url.searchParams.get("limit") || 50)
      const offset = Number(url.searchParams.get("offset") || 0)
      const items = state.history.map((row, index) => ({
        id: row.id,
        sessionId: state.sessionId,
        role: row.role,
        content: row.text,
        parts: JSON.stringify([{ type: "text", text: row.text }]),
        createdAt: index + 1,
      }))
      // The API answers newest first; the panel sorts ascending itself.
      const newestFirst = items.reverse()
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          items: newestFirst.slice(offset, offset + limit),
          total: newestFirst.length,
        }),
      })
    }),
    page.route(TURN_GLOB, async (route: Route) => {
      const active = state.sentTurnActive && !state.sentTurnEnded
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          active
            ? { status: "active", turnId: "turn_sent", lastSeq: 1 }
            : { status: "completed" },
        ),
      })
    }),
  ])
}

function projectComposerInput(page: Page) {
  return page
    .getByTestId("project-composer-input")
    .or(page.getByRole("textbox", { name: "Chat message input" }))
}

/**
 * A row in the "N Queued" dock. The shell can mount more than one chat panel,
 * so callers use `.first()` to assert presence and `toHaveCount(0)` otherwise.
 */
function queuedRow(page: Page, text: string) {
  return page.getByLabel("Queued message", { exact: true }).filter({ hasText: text })
}

/** How many transcript bubbles carry `text` (dock rows and the composer excluded). */
async function transcriptCount(page: Page, text: string): Promise<number> {
  return page.evaluate((needle) => {
    const composer = document.querySelector('[aria-label="Chat message input"]')
    const composerRoot = composer?.parentElement ?? null
    const hidden = (start: Element | null) => {
      for (let el: Element | null = start; el; el = el.parentElement) {
        if (el.getAttribute("aria-label") === "Queued message") return true
        if (el.getAttribute("aria-hidden") === "true") return true
        if (composerRoot && el === composerRoot) return true
        const style = (el as HTMLElement).style
        if (style && (style.pointerEvents === "none" || style.color === "transparent")) {
          return true
        }
      }
      return false
    }
    let count = 0
    const walker = document.createTreeWalker(document.body!, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (hidden(node.parentElement)) continue
      if ((node.nodeValue ?? "").includes(needle)) count += 1
    }
    return count
  }, text)
}

/**
 * Sample the page every 25 ms and record whether `text` was in the dock. A row
 * sent with "Send now" must not come back at any point during or after its
 * turn, which a single end-state assertion cannot prove.
 */
async function startDockSampler(page: Page, text: string) {
  await page.evaluate((needle) => {
    const w = window as unknown as {
      __sho148DockSamples: boolean[]
      __sho148DockSampler: ReturnType<typeof setInterval>
    }
    w.__sho148DockSamples = []
    w.__sho148DockSampler = setInterval(() => {
      const rows = Array.from(
        document.querySelectorAll('[aria-label="Queued message"]'),
      ) as HTMLElement[]
      w.__sho148DockSamples.push(
        rows.some((row) => (row.textContent ?? "").includes(needle)),
      )
    }, 25)
  }, text)
}

async function dockSamples(page: Page): Promise<boolean[]> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __sho148DockSamples: boolean[]
      __sho148DockSampler: ReturnType<typeof setInterval>
    }
    clearInterval(w.__sho148DockSampler)
    return w.__sho148DockSamples ?? []
  })
}

async function waitForIdle(page: Page) {
  await page
    .waitForSelector(AGENT_STOP_SELECTOR, { state: "detached", timeout: 30_000 })
    .catch(() => {})
}

async function openProject(page: Page, api: APIRequestContext) {
  await page.goto("/")
  await page.getByRole("navigation", { name: "App sidebar" }).waitFor({
    state: "visible",
    timeout: 20_000,
  })
  const listed = await api.get(`${LOCAL_API_BASE}/api/workspaces?limit=1`)
  if (!listed.ok()) throw new Error(`Unable to list local workspaces: ${listed.status()}`)
  const payload = (await listed.json()) as { items?: Array<{ id: string }> }
  const workspace = payload.items?.[0]
  if (!workspace) throw new Error("No local workspace is available for the queue E2E")

  const created = await api.post(`${LOCAL_API_BASE}/api/projects`, {
    data: {
      name: `Send now E2E ${Date.now()}`,
      description: "Send-now dock E2E fixture",
      workspaceId: workspace.id,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
    },
  })
  if (!created.ok()) throw new Error(`Unable to create local project: ${created.status()}`)
  const project = ((await created.json()) as { data?: { id: string } }).data
  if (!project?.id) throw new Error("Local project response did not include an id")

  await page.goto(`/projects/${project.id}`)
  await page.waitForURL(/\/projects\//, { timeout: 30_000 })
  const switchToText = page.getByText("Switch to text input", { exact: true })
  if (await switchToText.isVisible().catch(() => false)) {
    await switchToText.click()
  }
  await projectComposerInput(page).waitFor({ state: "visible", timeout: 20_000 })
  await waitForIdle(page)
}

/** Unique prompts per run: the local API keeps its database between runs. */
function prompts(stamp: string) {
  return {
    lead: `send-now lead prompt ${stamp}`,
    leadReply: `send-now lead reply ${stamp}`,
    alpha: `alpha stays queued ${stamp}`,
    beta: `beta sent now ${stamp}`,
    betaReply: `beta reply after send now ${stamp}`,
    restored: `restored queued row ${stamp}`,
  }
}

test.describe("send now takes a queued row out of the dock — local UI", () => {
  test("a row sent while another turn streams leaves the dock on the click and reaches the transcript once", async ({
    page,
  }) => {
    const state = newState()
    const { lead, leadReply, alpha, beta, betaReply } = prompts(
      `streaming-${Date.now().toString(36)}`,
    )
    await installStreamingFetch(page, state, {
      lead,
      leadReply,
      sentReply: betaReply,
    })
    await installServerMocks(page, state)
    await openProject(page, page.request)

    // A slow turn: the composer is mid-turn, so the next sends queue.
    await projectComposerInput(page).fill(lead)
    await page.keyboard.press("Enter")
    await expect.poll(() => state.chatPosts, { timeout: 20_000 }).toBe(1)
    await page.waitForSelector(AGENT_STOP_SELECTOR, { timeout: 20_000 })

    await projectComposerInput(page).fill(alpha)
    await page.keyboard.press("Enter")
    await expect(queuedRow(page, alpha).first()).toBeVisible({ timeout: 15_000 })
    await projectComposerInput(page).fill(beta)
    await page.keyboard.press("Enter")
    await expect(queuedRow(page, beta).first()).toBeVisible({ timeout: 15_000 })
    expect(state.rows.map((row) => row.content)).toEqual([alpha, beta])
    await expect.poll(() => transcriptCount(page, beta)).toBe(0)

    const betaId = String(state.rows[1].id)
    await queuedRow(page, beta).first().getByLabel(SEND_NOW_LABEL).click()

    // The click is the send: the row goes, before the server has taken it.
    await expect
      .poll(() => queuedRow(page, beta).count(), { timeout: 1_000 })
      .toBe(0)
    await expect(queuedRow(page, alpha).first()).toBeVisible()
    expect(state.sendNowCalls).toEqual([betaId])
    // Proof this is the optimistic hide and not a poll: the mocked server is
    // still holding the row, exactly as the un-awaited dispatch does.
    expect(state.rows.map((row) => row.content)).toEqual([beta, alpha])
    // From here on the row must never be in the dock again, for a frame.
    await startDockSampler(page, beta)

    // The stop lands, the dispatcher takes the row and starts its turn, and
    // only then does this window see its turn end — the shape the route's
    // un-awaited `dispatchNext` produces.
    dispatchRows(state, betaId)
    state.sentTurnActive = true
    state.history.push({ id: "m-lead-reply", role: "assistant", text: leadReply })
    await page.evaluate(() => {
      ;(window as any).__sho148ReleaseLead = true
    })
    await expect.poll(() => state.leadEnded, { timeout: 20_000 }).toBe(true)
    await waitForIdle(page)

    // The saved message reaches the transcript once, with its reply, and the
    // dock never shows it again — during the turn or after it.
    await expect
      .poll(() => transcriptCount(page, beta), { timeout: 20_000 })
      .toBe(1)
    await expect
      .poll(() => transcriptCount(page, betaReply), { timeout: 20_000 })
      .toBeGreaterThan(0)
    await expect.poll(() => transcriptCount(page, beta)).toBe(1)
    await expect(queuedRow(page, beta)).toHaveCount(0)
    // The row that was not sent is still exactly where it was.
    await expect(queuedRow(page, alpha).first()).toBeVisible()

    const samples = await dockSamples(page)
    expect(samples.length, "the sampler never ran").toBeGreaterThan(10)
    expect(
      samples.filter(Boolean),
      "the sent row came back into the dock",
    ).toEqual([])
  })

  test("a row restored from the server leaves the dock on the click and its turn runs", async ({
    page,
  }) => {
    const state = newState()
    const { restored, betaReply } = prompts(`idle-${Date.now().toString(36)}`)
    state.rows.push(restoredRow(restored))
    await installStreamingFetch(page, state, {
      lead: `unused lead prompt ${Date.now().toString(36)}`,
      leadReply: "unused lead reply",
      sentReply: betaReply,
    })
    await installServerMocks(page, state)
    await openProject(page, page.request)

    // No turn is running: the restored row is the only thing in the dock.
    await expect(queuedRow(page, restored).first()).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => transcriptCount(page, restored)).toBe(0)

    await queuedRow(page, restored).first().getByLabel(SEND_NOW_LABEL).click()
    await expect
      .poll(() => queuedRow(page, restored).count(), { timeout: 1_000 })
      .toBe(0)
    expect(state.sendNowCalls).toEqual(["queue-e2e-restored"])
    // Still on the server's queue: the dock dropped it on the click, not on a poll.
    expect(state.rows.map((row) => row.content)).toEqual([restored])

    dispatchRows(state, "queue-e2e-restored")
    state.sentTurnActive = true
    await expect
      .poll(() => transcriptCount(page, restored), { timeout: 20_000 })
      .toBe(1)
    await expect
      .poll(() => transcriptCount(page, betaReply), { timeout: 20_000 })
      .toBeGreaterThan(0)
    await expect(queuedRow(page, restored)).toHaveCount(0)
  })

  test("a refused send-now leaves the row in the dock and it can be sent again", async ({
    page,
  }) => {
    const state = newState()
    const { alpha } = prompts(`refused-${Date.now().toString(36)}`)
    state.rows.push(restoredRow(alpha))
    state.sendNowMode = "refuse"
    await installStreamingFetch(page, state, {
      lead: `unused lead prompt ${Date.now().toString(36)}`,
      leadReply: "unused lead reply",
      sentReply: "unused sent reply",
    })
    await installServerMocks(page, state)
    await openProject(page, page.request)
    await expect(queuedRow(page, alpha).first()).toBeVisible({ timeout: 15_000 })

    await queuedRow(page, alpha).first().getByLabel(SEND_NOW_LABEL).click()
    await expect.poll(() => state.sendNowCalls).toHaveLength(1)
    // Nothing was sent, so the row is the person's queued message again.
    await expect(queuedRow(page, alpha).first()).toBeVisible({ timeout: 5_000 })
    expect(state.rows.map((row) => row.content)).toEqual([alpha])
    await expect.poll(() => transcriptCount(page, alpha)).toBe(0)

    // And the row is not stuck hidden: sending it now works.
    state.sendNowMode = "hold"
    await queuedRow(page, alpha).first().getByLabel(SEND_NOW_LABEL).click()
    await expect
      .poll(() => queuedRow(page, alpha).count(), { timeout: 1_000 })
      .toBe(0)
    expect(state.sendNowCalls).toHaveLength(2)
  })

  test("a dispatch that fails brings the row back with its error and it can be deleted", async ({
    page,
  }) => {
    const state = newState()
    const { alpha } = prompts(`failed-${Date.now().toString(36)}`)
    state.rows.push(restoredRow(alpha))
    state.sendNowMode = "fail"
    await installStreamingFetch(page, state, {
      lead: `unused lead prompt ${Date.now().toString(36)}`,
      leadReply: "unused lead reply",
      sentReply: "unused sent reply",
    })
    await installServerMocks(page, state)
    await openProject(page, page.request)
    await expect(queuedRow(page, alpha).first()).toBeVisible({ timeout: 15_000 })

    await queuedRow(page, alpha).first().getByLabel(SEND_NOW_LABEL).click()
    // The row comes back, marked failed, with the server's reason on it.
    await expect(queuedRow(page, alpha).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText("The turn could not be started").first()).toBeVisible({
      timeout: 10_000,
    })
    await expect.poll(() => transcriptCount(page, alpha)).toBe(0)

    await queuedRow(page, alpha).first().getByLabel(DELETE_LABEL).click()
    await expect(queuedRow(page, alpha)).toHaveCount(0)
    expect(state.rows).toHaveLength(0)
  })
})
