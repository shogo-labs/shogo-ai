// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A sent message must appear in the transcript before anything reaches the
 * network. `ChatInput` clears the composer synchronously on Enter, and
 * `ChatPanel.handleSendMessage` then probes the chat's live turn — up to 1.5s
 * on a cold runtime — before the send starts. The echo has to be on screen
 * across that window, at the BOTTOM of the transcript, exactly once.
 *
 * Everything here is mocked: the `**\/chat` POST is fulfilled with a
 * hand-built UI message stream (same frame protocol as
 * `chat-offline-resilience.test.ts`) and the `/turn` probe is held open for
 * `PROBE_DELAY_MS`, so no model is called and the delay is deterministic.
 *
 * Start the local stack first:
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *
 * Then:
 *   npx playwright test --config e2e/local/playwright.config.ts chat-send-echo-timing
 */
import { test, expect, type Page, type Route } from "@playwright/test"
import { openTeamHome } from "./helpers"

// Local project chats run on the merged workspace runtime (/api/workspaces/:id/chat).
const CHAT_URL_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_URL_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"

/** How long the live-turn probe is held open — the freeze the echo must not sit behind. */
const PROBE_DELAY_MS = 1_500
/** How long the bubble may take to paint, measured from the Enter keypress. */
const ECHO_BUDGET_MS = Number(process.env.E2E_ECHO_BUDGET_MS || 100)
const REPLY_TEXT = "Echo timing reply."

// ─── SSE frames (AI SDK `UIMessageChunk`s, one JSON object per `data:` line) ─

let frameCounter = 0
const nextId = (prefix: string) => `${prefix}_${++frameCounter}`
const sseFrame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`

function buildCompletedTurnStream(text: string): string {
  const textId = nextId("text")
  return [
    sseFrame({ type: "start", messageId: nextId("msg") }),
    sseFrame({ type: "start-step" }),
    sseFrame({ type: "text-start", id: textId }),
    sseFrame({ type: "text-delta", id: textId, delta: text }),
    sseFrame({ type: "text-end", id: textId }),
    sseFrame({ type: "finish-step" }),
    sseFrame({ type: "finish" }),
  ].join("")
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

async function installChatMock(page: Page) {
  await page.route(CHAT_URL_GLOB, async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.continue()
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: buildCompletedTurnStream(REPLY_TEXT),
    })
  })
}

/** Holds every live-turn probe open for `delayMs`, then answers "no live turn". */
async function delayTurnProbe(page: Page, delayMs: number) {
  await page.route(TURN_URL_GLOB, async (route: Route) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    await route
      .fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "completed" }),
      })
      .catch(() => undefined)
  })
}

// ─── Window helpers ─────────────────────────────────────────────────────────

const projectComposer = (page: Page) => page.getByTestId("project-composer-input").first()
const homeComposer = (page: Page) =>
  page.getByTestId("home-composer-input").or(page.getByRole("textbox", { name: "Describe the agent you want to build" })).first()

const AGENT_STOP_SELECTOR = '[data-testid="stop-streaming"], [aria-label="Stop"]'

async function waitForAgentIdle(page: Page, timeoutMs = 30_000) {
  await page.waitForSelector(AGENT_STOP_SELECTOR, { state: "detached", timeout: timeoutMs }).catch(() => {})
}

async function createProject(page: Page, prompt: string) {
  await openTeamHome(page)
  const input = homeComposer(page)
  await input.click()
  await input.fill(prompt)
  await page.waitForTimeout(300)
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 30_000 })
  await projectComposer(page).waitFor({ state: "visible", timeout: 20_000 })
  // The bootstrap turn ChatPanel fires from `initialMessage` — let it settle so
  // every scenario starts from an idle composer.
  await waitForAgentIdle(page, 20_000)
}

/**
 * Watches the DOM from inside the page for the first paint of `marker` outside
 * the composer, so the measurement uses the browser's own clock instead of a
 * round trip from the test runner. The composer draws a transparent mirror of
 * its text, so a bare body-text match is not proof of a bubble: a user bubble
 * (`role=button`, "Edit this message …") or text with the composer emptied is.
 */
async function armEchoWatch(page: Page, marker: string) {
  await page.evaluate((m) => {
    const w = window as any
    const composerText = () => {
      const el = document.querySelector('[data-testid="project-composer-input"]') as HTMLTextAreaElement | null
      if (!el) return ""
      return typeof el.value === "string" ? el.value : (el.innerText ?? "")
    }
    const bubbleTexts = () =>
      Array.from(document.querySelectorAll('[role="button"]')).filter((el) =>
        (el.getAttribute("aria-label") || "").includes("Edit this message"),
      )
    const painted = () =>
      bubbleTexts().some((el) => (el.textContent || "").includes(m)) ||
      (document.body.innerText.includes(m) && !composerText().includes(m))
    w.__echoTiming = { sentAt: null, appearedAt: null }
    const observer = new MutationObserver(() => {
      // Only mutations caused by the send count — the composer mirror holds the
      // typed text before that.
      if (w.__echoTiming.sentAt == null || w.__echoTiming.appearedAt != null) return
      if (!painted()) return
      w.__echoTiming.appearedAt = performance.now()
      observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  }, marker)
}

/** Sends `text` and returns how long the bubble took to paint after Enter. */
async function sendAndTimeEcho(page: Page, text: string): Promise<number> {
  await armEchoWatch(page, text)
  const input = projectComposer(page)
  await input.click()
  await input.fill(text)
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    const w = window as any
    w.__echoTiming.sentAt = performance.now()
  })
  await page.keyboard.press("Enter")
  await expect
    .poll(() => page.evaluate(() => (window as any).__echoTiming.appearedAt), { timeout: 10_000 })
    .not.toBeNull()
  const timing = await page.evaluate(() => (window as any).__echoTiming)
  return timing.appearedAt - timing.sentAt
}

/** Where the echo and the last answer sit in the rendered transcript. */
async function transcriptOrder(page: Page, text: string, reply: string) {
  return page.evaluate(
    ({ t, r }) => {
      const body = document.body.innerText
      return {
        echoAt: body.lastIndexOf(t),
        replyAt: body.lastIndexOf(r),
        composer: (document.querySelector('[data-testid="project-composer-input"]') as HTMLTextAreaElement | null)?.value ?? "",
      }
    },
    { t: text, r: reply },
  )
}

test.describe("sent message paints before the live-turn probe — E2E (mocked)", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await installChatMock(page)
    await createProject(page, "Build a tiny todo app for send-echo timing E2E testing")
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("the bubble paints within the budget while the probe hangs, as the last turn", async () => {
    await delayTurnProbe(page, PROBE_DELAY_MS)

    const first = "First message before the slow one"
    await sendAndTimeEcho(page, first)
    await expect(page.getByText(REPLY_TEXT).last()).toBeVisible({ timeout: 15_000 })
    await waitForAgentIdle(page)
    const repliesBefore = await page.getByText(REPLY_TEXT).count()

    const second = "Sent while the turn probe hangs"
    const elapsed = await sendAndTimeEcho(page, second)

    // The probe is still in flight at this point: the bubble cannot be gated on it.
    expect(elapsed).toBeLessThan(ECHO_BUDGET_MS)

    const order = await transcriptOrder(page, second, REPLY_TEXT)
    // Composer cleared synchronously, bubble already at the bottom of the transcript.
    expect(order.composer).toBe("")
    expect(order.echoAt).toBeGreaterThan(order.replyAt)
    // Nothing from the answer has landed yet, so the echo is the newest item.
    expect(await page.getByText(REPLY_TEXT).count()).toBe(repliesBefore)

    await expect(page.getByText(second, { exact: true })).toHaveCount(1)
    await expect(page.getByText(REPLY_TEXT).last()).toBeVisible({ timeout: 20_000 })
    // No duplicate once the real message replaces the echo.
    await expect(page.getByText(second, { exact: true })).toHaveCount(1)
    await waitForAgentIdle(page)
    await page.unroute(TURN_URL_GLOB)
  })

  test("re-sending the same text still paints a new bubble immediately", async () => {
    await delayTurnProbe(page, PROBE_DELAY_MS)

    const repeated = "keep going please"
    await sendAndTimeEcho(page, repeated)
    await expect(page.getByText(REPLY_TEXT).last()).toBeVisible({ timeout: 15_000 })
    await waitForAgentIdle(page)
    await expect(page.getByText(repeated, { exact: true })).toHaveCount(1)

    const elapsed = await sendAndTimeEcho(page, repeated)
    expect(elapsed).toBeLessThan(ECHO_BUDGET_MS)
    await expect(page.getByText(repeated, { exact: true })).toHaveCount(2)

    await expect(page.getByText(REPLY_TEXT).last()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(repeated, { exact: true })).toHaveCount(2)
    await waitForAgentIdle(page)
    await page.unroute(TURN_URL_GLOB)
  })
})
