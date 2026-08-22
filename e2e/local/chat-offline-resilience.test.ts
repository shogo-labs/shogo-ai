// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page, type Route } from "@playwright/test"

/**
 * Offline-resilient chat — mock E2E tests.
 *
 * Exercises the client-visible half of the "network-resilient chat turns on
 * desktop" plan entirely through Playwright network mocking, with NO real AI
 * provider / model call anywhere in the run:
 *
 *   1. `data-connectivity-wait` heartbeat frames (see
 *      `packages/agent/src/connectivity.ts` +
 *      `packages/agent-runtime/src/gateway.ts`'s `onConnectivityWait` /
 *      `onConnectivityReconnected`) drive the "No internet connection.
 *      Waiting to resume…" banner in `ChatPanel.tsx`, and its Cancel button
 *      maps to the normal stop control.
 *   2. A `state: 'reconnected'` frame flips that to a brief "Back online —
 *      resuming…" confirmation that self-clears after ~3s.
 *   3. A chat POST that fails on a genuine client-side network error (no
 *      response at all — DNS/connection-refused/reset, simulated here via
 *      `route.abort()`) gets silently queued (`ChatInput`'s "N waiting to
 *      send" strip) instead of surfacing as a hard error, and is
 *      automatically redelivered — exactly once, no duplicate turn — once
 *      connectivity looks restored.
 *
 * Every `POST **\/api/projects/:id/chat` in this file is intercepted and
 * fulfilled with a hand-built UI message stream (see `sseFrame`/`turn`
 * below) — this test never talks to a real model, so it needs no API keys
 * and runs fully offline itself. `GET **\/api/ai/upstream-health` (the probe
 * `ChatPanel`'s offline send queue polls before redraining, mirroring the
 * server-side park tier) is mocked the same way.
 *
 * `route.fulfill()` delivers its whole body as one already-completed
 * response — Playwright has no supported API for a test to drip-feed SSE
 * chunks with real timing gaps into an in-flight fetch (see
 * https://github.com/microsoft/playwright/issues/33564). Each mocked stream
 * here is therefore built so the assertion holds on the STABLE end state of
 * processing that stream, not on catching a transient mid-stream frame:
 *   - the "parked" test's stream ends right after the `waiting` frames
 *     (no `reconnected`, no `finish`) — `connectivityWait` has nothing
 *     downstream to overwrite it, so the banner is a stable end state.
 *   - the "reconnected" test's banner visibility window is anchored to a
 *     real 3s `setTimeout` in `ChatPanel` (not to stream delivery timing),
 *     so it reliably stays visible long enough for Playwright to observe it
 *     regardless of how the mocked body happens to get chunked on the wire.
 *
 * Local-mode auto-signs in — no login step needed (same assumption as
 * `local-api-key-dialog.test.ts`).
 *
 * Start the local stack first:
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *
 * Then:
 *   npx playwright test --config e2e/local/playwright.config.ts chat-offline-resilience
 *
 * Override the frontend URL with E2E_TARGET_URL / STAGING_URL.
 */

const CHAT_URL_GLOB = "**/api/projects/*/chat"
const UPSTREAM_HEALTH_URL_GLOB = "**/api/ai/upstream-health"

// ─── SSE frame builders ──────────────────────────────────────────────────
//
// Mirrors the real wire protocol emitted by `uiWriter.write(...)` in
// `packages/agent-runtime/src/gateway.ts` (AI SDK `UIMessageChunk`s, one
// JSON object per `data: ` line) — see `node_modules/ai/dist/index.d.mts`'s
// `UIMessageChunk` union for the authoritative shape.

let frameCounter = 0
function nextId(prefix: string): string {
  frameCounter += 1
  return `${prefix}_${frameCounter}`
}

function sseFrame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/** A normal, fully-completed turn: some assistant text and a clean finish. */
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

/**
 * A turn that's "parked" polling connectivity (Layer 7 in `agent-loop.ts`)
 * when the client's connection to it drops — the stream ends right after
 * the heartbeats, with no `reconnected` or `finish` frame. Deliberately
 * open-ended so `connectivityWait` in `ChatPanel` is left as the last thing
 * written and nothing later in the (nonexistent) rest of the stream
 * overwrites it.
 */
function buildParkedStream(ticks: Array<{ attempt: number; elapsedMs: number; nextProbeInMs: number }>): string {
  return [
    sseFrame({ type: "start", messageId: nextId("msg") }),
    sseFrame({ type: "start-step" }),
    ...ticks.map((tick) => sseFrame({ type: "data-connectivity-wait", data: { state: "waiting", ...tick } })),
  ].join("")
}

/** A turn that reconnects (Layer 7 resolved) and then answers normally. */
function buildReconnectedTurnStream(text: string): string {
  const textId = nextId("text")
  return [
    sseFrame({ type: "start", messageId: nextId("msg") }),
    sseFrame({ type: "start-step" }),
    sseFrame({ type: "data-connectivity-wait", data: { state: "reconnected" } }),
    sseFrame({ type: "text-start", id: textId }),
    sseFrame({ type: "text-delta", id: textId, delta: text }),
    sseFrame({ type: "text-end", id: textId }),
    sseFrame({ type: "finish-step" }),
    sseFrame({ type: "finish" }),
  ].join("")
}

// ─── Route mocking ────────────────────────────────────────────────────────
//
// One persistent `page.route` handler per mocked endpoint for the whole
// test file, driven by a mutable "what should the NEXT chat POST do"
// script so individual tests just set `nextChatMock` right before sending
// rather than juggling `route`/`unroute` themselves. Defaults to an
// innocuous instant success so anything that isn't the test's own send
// (notably the project-bootstrap turn `ChatPanel` auto-sends on mount)
// completes cleanly without ever reaching a real model.

type ChatMock = { kind: "abort" } | { kind: "stream"; body: string }

let nextChatMock: ChatMock | null = null
let chatPostCount = 0

async function installMocks(page: Page) {
  await page.route(CHAT_URL_GLOB, async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.continue()
      return
    }
    chatPostCount++
    const mock = nextChatMock ?? { kind: "stream", body: buildCompletedTurnStream("OK, got it.") }
    nextChatMock = null // one-shot — each send scripts its own response
    if (mock.kind === "abort") {
      await route.abort("failed")
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: mock.body,
    })
  })

  // Always "reachable" by default — the offline-queue-drain test flips this
  // implicitly by simply succeeding the retried POST; nothing here needs to
  // report unreachable since we drive the client's offline path via a hard
  // `route.abort()` on the chat POST itself, not via this probe.
  await page.route(UPSTREAM_HEALTH_URL_GLOB, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reachable: true, target: "direct", checkedAt: Date.now(), cached: false }),
    })
  })
}

// ─── Composer helpers ─────────────────────────────────────────────────────

function homeComposerInput(page: Page) {
  return page.getByTestId("home-composer-input").or(
    page.getByRole("textbox", { name: "Describe the agent you want to build" }),
  )
}

function projectComposerInput(page: Page) {
  return page.getByTestId("project-composer-input")
}

const AGENT_STOP_SELECTOR = '[data-testid="stop-streaming"], [aria-label="Stop"]'

async function waitForAgentIdle(page: Page, timeoutMs = 30_000) {
  await page.waitForSelector(AGENT_STOP_SELECTOR, { state: "detached", timeout: timeoutMs }).catch(() => {})
}

async function createProjectAndWait(page: Page, prompt: string) {
  await page.goto("/")
  await page.waitForSelector("text=What's on your mind", { timeout: 20_000 })

  const input = homeComposerInput(page)
  await input.click()
  await input.fill(prompt)
  await page.waitForTimeout(300)
  await page.keyboard.press("Enter")

  await page.waitForURL(/\/projects\//, { timeout: 30_000 })
  await projectComposerInput(page).waitFor({ state: "visible", timeout: 20_000 })
  // The bootstrap turn ChatPanel auto-fires from `initialMessage` — let the
  // (mocked, instant) reply land so every test starts from an idle composer.
  await waitForAgentIdle(page, 20_000)
}

async function sendProjectMessage(page: Page, text: string) {
  const input = projectComposerInput(page)
  await input.click()
  await input.fill(text)
  await page.waitForTimeout(150)
  await page.keyboard.press("Enter")
}

test.describe("Offline-resilient chat — E2E (mocked)", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await installMocks(page)
    await createProjectAndWait(page, "Build a tiny todo app for offline-resilience E2E testing")
  })

  test.afterAll(async () => {
    await page.close()
  })

  test.beforeEach(() => {
    nextChatMock = null
    chatPostCount = 0
  })

  // ===========================================================================
  // 1. Connectivity-park banner
  // ===========================================================================

  test("shows the waiting-for-connection banner while parked, and Cancel dismisses it", async () => {
    nextChatMock = {
      kind: "stream",
      body: buildParkedStream([
        { attempt: 1, elapsedMs: 0, nextProbeInMs: 1_000 },
        { attempt: 2, elapsedMs: 6_000, nextProbeInMs: 15_000 },
      ]),
    }

    await sendProjectMessage(page, "Ping during an outage")

    const banner = page.getByText(/No internet connection\. Waiting to resume/)
    await expect(banner).toBeVisible({ timeout: 15_000 })

    const cancelBtn = page.getByRole("button", { name: "Cancel and stop waiting for connection" })
    await expect(cancelBtn).toBeVisible()
    await cancelBtn.click()

    await expect(banner).toBeHidden({ timeout: 5_000 })
  })

  // ===========================================================================
  // 2. Reconnected confirmation
  // ===========================================================================

  test("shows a brief 'Back online' confirmation once a parked turn reconnects, then clears itself", async () => {
    nextChatMock = {
      kind: "stream",
      body: buildReconnectedTurnStream("Reconnected — here is your answer."),
    }

    await sendProjectMessage(page, "Are you still there?")

    const reconnectedBanner = page.getByText("Back online — resuming\u2026")
    await expect(reconnectedBanner).toBeVisible({ timeout: 15_000 })

    // Self-clears via a real 3s `setTimeout` in `ChatPanel` — independent of
    // how fast the mocked stream itself was delivered.
    await expect(reconnectedBanner).toBeHidden({ timeout: 6_000 })

    await expect(page.getByText("Reconnected — here is your answer.")).toBeVisible()
    await waitForAgentIdle(page)
  })

  // ===========================================================================
  // 3. Offline send queue — queues on network failure, drains without duplicating
  // ===========================================================================

  test("queues a send that fails on a network error, then delivers it exactly once connectivity returns", async () => {
    nextChatMock = { kind: "abort" }

    await sendProjectMessage(page, "Ping while offline")

    // `deliverMessage` swallows the network-class failure and queues it —
    // no error banner, just the composer's offline strip.
    await expect(page.getByText("1 waiting to send")).toBeVisible({ timeout: 15_000 })
    expect(chatPostCount).toBe(1)

    // Connectivity "returns": the retried POST now succeeds.
    nextChatMock = { kind: "stream", body: buildCompletedTurnStream("Delivered once back online.") }
    await page.evaluate(() => window.dispatchEvent(new Event("online")))

    await expect(page.getByText("1 waiting to send")).toBeHidden({ timeout: 20_000 })
    await expect(page.getByText("Delivered once back online.")).toBeVisible({ timeout: 20_000 })

    // Exactly one retry landed a real turn (the aborted attempt + the one
    // successful redelivery) — no duplicate turn from the offline retry.
    expect(chatPostCount).toBe(2)
    await expect(page.getByText("Delivered once back online.")).toHaveCount(1)

    await waitForAgentIdle(page)
  })
})
