// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-147 — a turn that starts right after a finished one must not replace the
 * previous reply.
 *
 * The queue dispatcher and the team-chat dispatcher write the new turn's user
 * row *before* the turn starts, so `/chat-messages` can answer with a prompt
 * the screen has never shown (`[u1, a1, u2]`) while the panel's own reply is
 * still only on screen (`a1` carrying the SDK's live id). The old paint refused
 * that history (`streamed-turn`, SHO-85's rule) and then attached to the new
 * turn anyway — and the stream carries the assistant reply alone, so the SDK
 * appended it after `a1` with no user row between them and the transcript's
 * one-assistant-per-turn grouping gave the new reply the previous reply's
 * bubble. Russell's report: "as soon as a chat finishes another is sent to it
 * … and this causes the message to overwrite".
 *
 * Two cases, both driven from the same window with no reload:
 *   1. reply 1's row is still missing when the next prompt lands. This is the
 *      reported shape and the case that fails without the fix: `main` ends up
 *      with one bubble whose text is reply 2's, no reply 1 and no prompt 2.
 *   2. reply 1's row is saved before the next prompt lands (the panel adopts it
 *      first). Passes before and after — the guard against a fix that only
 *      works while the reply is still unsaved.
 *
 * `route.fulfill` cannot reproduce this (a fulfilled SSE body is one chunk, so
 * `isTransportStreaming` never renders `true` and the post-turn follow never
 * runs). `window.fetch` is patched in an init script instead so the chat POST
 * really streams and the panel's own post-turn path — `followNextTurn` → probe
 * → `reloadAndAttachLiveTurn` → Effect 1 → attach — is the one under test. The
 * `/turn` probe and `/chat-messages` are mocked; the local API still serves
 * workspaces/projects and the panel is the real one.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-next-turn-keeps-previous-reply --project chromium --retries 0
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"

test.setTimeout(180_000)

const MESSAGES_GLOB = "**/api/chat-messages*"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"

const PROMPT_ONE = "Turn one: does the build pass?"
const REPLY_ONE = "reply-one the build passed and here is what it changed"
const PROMPT_TWO = "[Task update] the background build finished after turn one"
const REPLY_TWO = "reply-two the follow-up turn ran on its own"

/** How long turn 1's stream takes, and the gap between its frames. */
const TURN_ONE_FRAME_MS = 140
/** The next turn starts this long after turn 1's stream closed. */
const NEXT_TURN_DELAY_MS = 1_800
/** Reply 1's saved row appears this long after turn 1's stream closed. */
const REPLY_ROW_DELAY_MS = 300

const AGENT_STOP_SELECTOR = '[data-testid="stop-streaming"], [aria-label="Stop"]'

interface WindowState {
  /** When the panel sent the prompt under test. */
  promptOneAt: number | null
  /** `/chat-messages` GETs served. */
  reads: number
  /** `/stream` attaches served — proves the panel attached the next turn. */
  streams: number
  /** When turn 1's stream closed, in the page's clock as reported by the page. */
  turnOneEndedAt: number | null
  /** Reply 1's saved row is visible to `/chat-messages` from here on. */
  replyRowAt: number | null
  /** Turn 2 reads `active` from here on. */
  nextTurnAt: number | null
  /** Turn 2 is over from here on. */
  nextTurnEndedAt: number | null
}

interface SpecOptions {
  /** Save reply 1's row at all: false is the "row still being written" case. */
  saveReplyOne: boolean
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

/**
 * Patch `window.fetch` so the chat POST and the resume replay are real streams.
 * Everything else (`/chat-messages`, `/turn`, the local API) still goes to the
 * network, so `page.route` keeps working for them.
 *
 * The POST is recognised by its prompt, not by call order: the workspace agent
 * chat and the project chat are different documents/sessions. When turn 1's
 * stream closes the page tells the test, which then moves the mocked server
 * clock forward (the next prompt, the saved row).
 */
async function installStreamingFetch(
  page: Page,
  state: WindowState,
): Promise<void> {
  await page.exposeFunction("__sho147TurnOneStarted", () => {
    state.promptOneAt = Date.now()
  })
  await page.exposeFunction("__sho147TurnOneEnded", () => {
    state.turnOneEndedAt = Date.now()
    state.replyRowAt = state.turnOneEndedAt + REPLY_ROW_DELAY_MS
    state.nextTurnAt = state.turnOneEndedAt + NEXT_TURN_DELAY_MS
  })
  await page.exposeFunction("__sho147ReplayStarted", () => {
    state.streams += 1
  })
  await page.exposeFunction("__sho147ReplayEnded", () => {
    state.nextTurnEndedAt = Date.now()
  })
  await page.addInitScript(
    ({ frameMs, replyOne, replyTwo, promptOne }) => {
      const originalFetch = window.fetch.bind(window)
      const encoder = new TextEncoder()
      const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`
      const chunk = (messageId: string, text: string, turnId: string) => [
        frame({ type: "start", messageId }),
        frame({ type: "start-step" }),
        frame({ type: "text-start", id: `${messageId}-t` }),
        frame({ type: "text-delta", id: `${messageId}-t`, delta: text }),
        frame({ type: "text-end", id: `${messageId}-t` }),
        frame({ type: "finish-step" }),
        frame({
          type: "data-turn-complete",
          data: { turnId, status: "completed", lastSeq: 1, completedAt: Date.now() },
        }),
        frame({ type: "finish", finishReason: "stop" }),
      ]
      /** The same turn, spread over ~8 frames so the panel really renders "streaming". */
      const streamedChunk = (messageId: string, text: string, turnId: string) => {
        const words = text.split(" ")
        const frames = [
          frame({ type: "start", messageId }),
          frame({ type: "start-step" }),
          frame({ type: "text-start", id: `${messageId}-t` }),
        ]
        words.forEach((word, index) =>
          frames.push(
            frame({
              type: "text-delta",
              id: `${messageId}-t`,
              delta: index === 0 ? word : ` ${word}`,
            }),
          ),
        )
        frames.push(
          frame({ type: "text-end", id: `${messageId}-t` }),
          frame({ type: "finish-step" }),
          frame({
            type: "data-turn-complete",
            data: { turnId, status: "completed", lastSeq: 1, completedAt: Date.now() },
          }),
          frame({ type: "finish", finishReason: "stop" }),
        )
        return frames
      }

      const respond = (frames: string[], gapMs: number, onEnd?: () => void) => {
        let timer: ReturnType<typeof setInterval> | null = null
        let index = 0
        return new Response(
          new ReadableStream({
            start(controller) {
              const push = () => {
                if (index >= frames.length) {
                  if (timer) clearInterval(timer)
                  timer = null
                  try {
                    controller.close()
                  } catch {
                    // already closed by cancel()
                  }
                  onEnd?.()
                  return
                }
                controller.enqueue(encoder.encode(frames[index]))
                index += 1
              }
              if (gapMs <= 0) {
                while (index < frames.length) push()
                return
              }
              push()
              timer = setInterval(push, gapMs)
            },
            cancel() {
              if (timer) clearInterval(timer)
              timer = null
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
      }

      const patched = async (input: any, init?: RequestInit): Promise<Response> => {
        const rawUrl =
          typeof input === "string" ? input : input instanceof Request ? input.url : String(input)
        const url = new URL(rawUrl, window.location.href)
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
        const chatPost = /^\/api\/(projects|workspaces)\/[^/]+\/chat$/
        const replay = /^\/api\/(projects|workspaces)\/[^/]+\/chat\/[^/]+\/stream/

        if (method === "POST" && chatPost.test(url.pathname)) {
          // Decide by the prompt, not by call order: creating the project from
          // the home composer is a document navigation, so the bootstrap turn
          // and the turn under test are not even served by the same page.
          const body = typeof init?.body === "string" ? init.body : ""
          if (!body.includes(promptOne)) {
            // Anything else is the workspace agent's own chat, which this spec
            // does not drive; answer it with one finished turn.
            return respond(chunk("msg_other", "ok", "turn_other"), 0)
          }
          ;(window as any).__sho147TurnOneStarted?.()
          return respond(streamedChunk("msg_reply_one", replyOne, "turn_one"), frameMs, () => {
            ;(window as any).__sho147TurnOneEnded?.()
          })
        }
        if (method === "GET" && replay.test(url.pathname)) {
          // The next turn's own stream: the assistant reply and nothing else —
          // its user row has to come from the paint, not from here.
          ;(window as any).__sho147ReplayStarted?.()
          return respond(
            streamedChunk("msg_reply_two", replyTwo, "turn_two"),
            frameMs,
            () => {
              ;(window as any).__sho147ReplayEnded?.()
            },
          )
        }
        return originalFetch(input, init)
      }
      window.fetch = patched as typeof window.fetch
    },
    {
      frameMs: TURN_ONE_FRAME_MS,
      replyOne: REPLY_ONE,
      replyTwo: REPLY_TWO,
      promptOne: PROMPT_ONE,
    },
  )
}

async function installServerMocks(
  page: Page,
  state: WindowState,
  options: SpecOptions,
): Promise<void> {
  await page.route(MESSAGES_GLOB, async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue()
    state.reads += 1
    const url = new URL(route.request().url())
    const sessionId = url.searchParams.get("sessionId") ?? "session-under-test"
    const limit = Number(url.searchParams.get("limit") || 50)
    const offset = Number(url.searchParams.get("offset") || 0)
    const now = Date.now()
    const base = state.promptOneAt ?? now

    const rows: any[] = []
    if (state.promptOneAt !== null) {
      // The dispatcher writes a turn's prompt before the turn starts, so the
      // saved row is there while the reply is still streaming (or missing).
      rows.push(savedRow("m-prompt-one", sessionId, "user", PROMPT_ONE, base))
    }
    if (options.saveReplyOne && state.replyRowAt !== null && now >= state.replyRowAt) {
      rows.push(savedRow("m-reply-one", sessionId, "assistant", REPLY_ONE, base + 1))
    }
    if (state.nextTurnAt !== null && now >= state.nextTurnAt) {
      rows.push(savedRow("m-prompt-two", sessionId, "user", PROMPT_TWO, base + 2))
    }
    if (state.nextTurnEndedAt !== null && now >= state.nextTurnEndedAt + 500) {
      rows.push(savedRow("m-reply-two", sessionId, "assistant", REPLY_TWO, base + 4))
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

  await page.route(TURN_GLOB, async (route: Route) => {
    const now = Date.now()
    const active =
      state.nextTurnAt !== null &&
      now >= state.nextTurnAt &&
      (state.nextTurnEndedAt === null || now <= state.nextTurnEndedAt)
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        active ? { status: "active", turnId: "turn_two", lastSeq: 1 } : { status: "completed" },
      ),
    })
  })
}

/**
 * Sign in, create a project and open its chat, with no earlier turn on screen:
 * the transcript the two cases compare against starts at the prompt under test.
 */
async function openProjectChat(page: Page, name: string): Promise<void> {
  await page.goto("/")
  await page
    .getByRole("navigation", { name: "App sidebar" })
    .or(page.getByRole("tab", { name: "Sign Up" }))
    .first()
    .waitFor({ state: "visible", timeout: 60_000 })

  const workspacesResponse = await page.request.get(`${LOCAL_API_BASE}/api/workspaces`)
  const workspaces = await workspacesResponse.json()
  const list: any[] = workspaces?.items ?? workspaces?.data ?? workspaces ?? []
  const workspace = list.find((item) => item?.kind !== "personal") ?? list[0]
  if (!workspace?.id) throw new Error(`no workspace to create a project in: ${JSON.stringify(workspaces).slice(0, 300)}`)

  const createdResponse = await page.request.post(`${LOCAL_API_BASE}/api/projects`, {
    data: {
      name: `${name} ${Date.now()}`,
      workspaceId: workspace.id,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
    },
  })
  const created = await createdResponse.json()
  const projectId: string | undefined = created?.data?.id ?? created?.id
  if (!projectId) throw new Error(`project create failed: ${JSON.stringify(created).slice(0, 300)}`)

  await page.goto(`/projects/${encodeURIComponent(projectId)}`)
  await expect(
    page.getByTestId("project-composer-input").filter({ visible: true }).first(),
    "the project chat is open",
  ).toBeVisible({ timeout: 120_000 })
}

function emptyState(): WindowState {
  return {
    promptOneAt: null,
    reads: 0,
    streams: 0,
    turnOneEndedAt: null,
    replyRowAt: null,
    nextTurnAt: null,
    nextTurnEndedAt: null,
  }
}

async function occurrences(page: Page, needle: string): Promise<number> {
  return page.evaluate((text) => (document.body?.innerText ?? "").split(text).length - 1, needle)
}

async function topOf(page: Page, needle: string): Promise<number | null> {
  return page.evaluate((text) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.includes(text)) continue
      const parent = node.parentElement
      if (!parent) continue
      return parent.getBoundingClientRect().top
    }
    return null
  }, needle)
}

async function sendTurnOne(page: Page): Promise<void> {
  const composer = page.getByTestId("project-composer-input").filter({ visible: true }).first()
  await composer.waitFor({ state: "visible", timeout: 30_000 })
  await composer.click()
  await composer.fill(PROMPT_ONE)
  await page.keyboard.press("Enter")
  await expect(
    page.getByText(REPLY_ONE, { exact: false }).first(),
    "turn 1 streamed into the panel",
  ).toBeVisible({ timeout: 60_000 })
  await page
    .waitForSelector(AGENT_STOP_SELECTOR, { state: "detached", timeout: 30_000 })
    .catch(() => {})
}

/** Runs one case: turn 1, then a server-initiated turn 2 on the same session. */
async function runBackToBack(page: Page, options: SpecOptions): Promise<WindowState> {
  const state = emptyState()
  await installStreamingFetch(page, state)
  await installServerMocks(page, state, options)

  await openProjectChat(page, "next turn keeps reply")
  await sendTurnOne(page)

  // Turn 1 is over and its reply is on screen. From here nothing is typed: the
  // only thing that can produce another turn is the (mocked) server.
  await expect
    .poll(() => state.turnOneEndedAt, {
      timeout: 30_000,
      message: "turn 1's stream never closed",
    })
    .not.toBeNull()

  // The panel follows the turn it just finished: probe `/turn`, find the next
  // one live, reload history and attach. Without the fix the reload is refused
  // and the attach happens anyway, into the previous reply's bubble.
  await expect
    .poll(() => state.streams, {
      timeout: 60_000,
      message: "the panel never attached the turn that followed",
    })
    .toBeGreaterThan(0)

  await expect(
    page.getByText(REPLY_TWO, { exact: false }).first(),
    "the follow-up turn's reply streamed into the panel",
  ).toBeVisible({ timeout: 60_000 })
  await page
    .waitForSelector(AGENT_STOP_SELECTOR, { state: "detached", timeout: 30_000 })
    .catch(() => {})
  // Let the post-turn reconcile and paint settle; the reply must survive them.
  await page.waitForTimeout(3_000)
  return state
}

test("a turn that starts before reply 1 is saved keeps the first turn on screen", async ({
  page,
}) => {
  const state = await runBackToBack(page, { saveReplyOne: false })

  expect(state.reads, "the panel read saved history around the second turn").toBeGreaterThan(0)

  // Two turns, one copy of each reply, and the first reply still where it was.
  expect(
    await occurrences(page, REPLY_ONE),
    "reply 1 is still on screen after the second turn",
  ).toBe(1)
  expect(await occurrences(page, REPLY_TWO), "reply 2 is shown once").toBe(1)
  expect(
    await occurrences(page, PROMPT_TWO),
    "the second turn's prompt is on screen, so the reply cannot belong to turn 1",
  ).toBe(1)

  const replyOne = await topOf(page, REPLY_ONE)
  const promptTwo = await topOf(page, PROMPT_TWO)
  const replyTwo = await topOf(page, REPLY_TWO)
  expect(replyOne, "reply 1 has a position").not.toBeNull()
  expect(promptTwo, "prompt 2 has a position").not.toBeNull()
  expect(replyTwo, "reply 2 has a position").not.toBeNull()
  expect(replyOne! < promptTwo!, "reply 1 sits above the next turn's prompt").toBe(true)
  expect(promptTwo! < replyTwo!, "the next turn's reply sits below its prompt").toBe(true)
})

test("a turn that starts after reply 1 is saved keeps both turns", async ({ page }) => {
  const state = await runBackToBack(page, { saveReplyOne: true })

  expect(state.reads, "the panel read saved history around the second turn").toBeGreaterThan(0)
  expect(
    await occurrences(page, REPLY_ONE),
    "reply 1 is still on screen after the second turn",
  ).toBe(1)
  expect(await occurrences(page, REPLY_TWO), "reply 2 is shown once").toBe(1)
  expect(await occurrences(page, PROMPT_TWO), "the second turn's prompt is on screen").toBe(1)
})
