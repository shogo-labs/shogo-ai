// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-602 AC5 — the edges of an off-screen turn arrive on the realtime stream,
 * not on a timer.
 *
 * The card cut the `active-chats` + `agent-tasks` cadence from 5 s to 60 s for
 * a turn running on a chat this screen is not watching, which is only safe
 * because `chat-session.turn` (SHO-299) carries both edges: one uncached
 * refresh per edge, no faster timer. This spec is that claim, end to end:
 *
 *   - the mocked `active-chats` answer is the only thing that changes, and it
 *     changes *after* the frame arrives, so the refresh the edge triggers is
 *     what paints both ends;
 *   - every assertion gets 15 s (`AC5`'s budget) while the net is 60 s, so a
 *     build that polled would miss the deadline rather than pass slowly;
 *   - `active-chats` request counts are asserted, so "it reacted quickly" cannot
 *     be explained by a cadence that quietly went back to 5 s.
 *
 * The edge is pushed down the `…/conversations/events` leg, which is the one
 * live in the local harness: `…/rt` answers 403 there, so a proxied socket is
 * one the app has already abandoned (`lib/team-chat-realtime.ts` falls back to
 * the stream). Either leg lands in the same `handleFrame`, which is what the
 * row actually listens to.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     sho-602-turn-edges --project chromium
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { signIn } from "./team-nav-seed"

test.setTimeout(300_000)

/** AC5's number: both edges reflected within 15 s of the turn starting/ending. */
const EDGE_BUDGET_MS = 15_000

type Turn = { chatSessionId: string; startedAt: string }
type TurnEdge = { chatSessionId: string; turnId: string; state: "started" | "ended" }

function chatsPanel(page: Page) {
  return page.getByTestId("workspace-chats-panel")
}

function chatRow(page: Page, name: string) {
  return chatsPanel(page).getByLabel(`Chat: ${name}`, { exact: true })
}

async function localSignIn(page: Page): Promise<void> {
  await page.request.post(`${LOCAL_API_BASE}/api/local/auto-sign-in`).catch(() => undefined)
  await page.request.post(`${LOCAL_API_BASE}/api/onboarding/complete`).catch(() => undefined)
  await signIn(page)
}

async function personalWorkspaceId(page: Page): Promise<string> {
  const res = await page.request.get(`${LOCAL_API_BASE}/api/workspaces`)
  const json = await res.json()
  const items = (json?.items ?? json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
  const id = items.find((w) => w.kind === "personal")?.id
  if (!id) throw new Error(`local stack has no personal workspace: ${JSON.stringify(json)}`)
  return id
}

async function createChat(
  page: Page,
  workspaceId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await page.request.post(`${LOCAL_API_BASE}/api/workspaces/${workspaceId}/sessions`, {
    data: { name },
  })
  expect(response.status()).toBe(201)
  const body = await response.json()
  return { id: body.session.id, name: body.session.name ?? name }
}

/** The server's answer to "what is running", decided by the spec. */
async function mockActiveChats(page: Page, running: Turn[]): Promise<void> {
  await page.route("**/api/workspaces/*/active-chats", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ chats: running }),
    })
  })
}

/**
 * Hold the app's realtime stream open and hand the spec a way to send a
 * `chat-session.turn` frame down it — the event a turn edge really arrives on.
 *
 * `EventSource` reconnects by itself, so each fulfilled body carries whatever
 * was pushed since the last connection, a `retry` later; a drained queue means
 * an edge is never replayed into a later assertion.
 */
async function pushTurnEdges(page: Page): Promise<(edge: TurnEdge) => void> {
  const pending: TurnEdge[] = []
  let connections = 0
  await page.route(/\/api\/workspaces\/[^/]+\/conversations\/events/, async (route: Route) => {
    connections += 1
    const frames = pending.splice(0)
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body:
        "retry: 1000\n\n" +
        frames
          .map((edge) => `data: ${JSON.stringify({ type: "chat-session.turn", ...edge })}\n\n`)
          .join(""),
    })
  })
  return (edge) => {
    if (connections === 0) {
      throw new Error("the realtime stream never opened, so no turn edge could be pushed")
    }
    pending.push(edge)
  }
}

/** Every `active-chats` ask the page makes, so the cadence can be asserted. */
function countActiveChats(page: Page): { count: () => number } {
  let asked = 0
  page.on("request", (request) => {
    if (/\/api\/workspaces\/[^/]+\/active-chats/.test(request.url())) asked += 1
  })
  return { count: () => asked }
}

test.describe("SHO-602 turn edges (local)", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("a turn in a chat this screen is not watching paints both ends off the realtime stream", async ({
    page,
  }) => {
    await localSignIn(page)
    const workspaceId = await personalWorkspaceId(page)
    const name = `SHO-602 edge ${Date.now()}`
    const chat = await createChat(page, workspaceId, name)

    const running: Turn[] = []
    await mockActiveChats(page, running)
    const pushEdge = await pushTurnEdges(page)
    const asks = countActiveChats(page)

    await page.goto("/")
    await expect(chatsPanel(page)).toBeVisible({ timeout: 90_000 })

    // The row exists and says nothing about a turn: this screen is not watching
    // that chat, and nothing is running.
    await expect(chatRow(page, name)).toBeVisible({ timeout: 30_000 })
    await expect(chatRow(page, name).getByLabel("Chat running").first()).toHaveCount(0)

    // --- the start edge -----------------------------------------------------
    // The server begins reporting the turn, and the frame that announces it is
    // pushed. Nothing here waits for a timer.
    const askBeforeStart = asks.count()
    running.push({ chatSessionId: chat.id, startedAt: new Date().toISOString() })
    pushEdge({ chatSessionId: chat.id, turnId: `turn_${chat.id}`, state: "started" })
    await expect(chatRow(page, name).getByLabel("Chat running").first()).toBeVisible({
      timeout: EDGE_BUDGET_MS,
    })
    // One refresh for the edge, and no faster timer behind it: the net for a
    // turn this screen does not show is 60 s, so anything above a couple of
    // asks in a 15 s window means the cadence went back to 5 s.
    expect(
      asks.count() - askBeforeStart,
      "the edge should cost one refresh, not a running timer",
    ).toBeLessThanOrEqual(2)

    // --- the end edge -------------------------------------------------------
    const askBeforeEnd = asks.count()
    running.length = 0
    pushEdge({ chatSessionId: chat.id, turnId: `turn_${chat.id}`, state: "ended" })
    await expect(chatRow(page, name).getByLabel("Chat running").first()).toHaveCount(0, {
      timeout: EDGE_BUDGET_MS,
    })
    await expect(chatRow(page, name).getByLabel("Chat has new activity").first()).toBeVisible({
      timeout: EDGE_BUDGET_MS,
    })
    expect(
      asks.count() - askBeforeEnd,
      "the end edge should cost one refresh, not a running timer",
    ).toBeLessThanOrEqual(2)

    // The whole exchange — two edges, a 15 s budget each — has to fit inside a
    // single 60 s net tick, which is what makes the assertions above a proof
    // that the stream painted them.
    expect(
      asks.count(),
      "the poll net must not have been the thing that painted the edges",
    ).toBeLessThanOrEqual(6)
  })
})
