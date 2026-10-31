// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-258 §1 — "build first, then ask" has to be usable on a phone.
 *
 * The build brief now tells the agent to ship a first version before it plans,
 * which means the very first turn of a brand-new project is a *build* turn: the
 * user types one sentence on the home composer, lands in the project, and reads
 * a reply in the transcript. Every one of those surfaces has to fit a 390×844
 * canvas — the phone the app actually opens on — or the first-run experience
 * breaks exactly where activation happens.
 *
 * The spec walks that path at 390×844 with the network mocked (`**\/chat` POST
 * is fulfilled with a UI-message stream and the `/turn` probe answers "no live
 * turn"), and asserts, at each step, that:
 *   • the surface is visible rather than pushed off-screen,
 *   • nothing is wider than the viewport (no horizontal document overflow),
 *   • the composer and its send affordance sit fully inside the canvas.
 *
 * Start the local stack first:
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *
 * Then:
 *   npx playwright test --config e2e/local/playwright.config.ts phone-build-first
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"

const CHAT_URL_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_URL_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"

const PHONE = { width: 390, height: 844 } as const

const BUILD_PROMPT = "Build a tiny habit tracker"
const BUILD_REPLY = "Built the first version — habit list and a daily check-off."

// ─── SSE frames (AI SDK `UIMessageChunk`s, one JSON object per `data:` line) ──

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

// ─── Mocks ───────────────────────────────────────────────────────────────────

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
      body: buildCompletedTurnStream(BUILD_REPLY),
    })
  })
}

async function answerTurnProbe(page: Page) {
  await page.route(TURN_URL_GLOB, async (route: Route) => {
    await route
      .fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "completed" }),
      })
      .catch(() => undefined)
  })
}

// ─── Phone assertions ────────────────────────────────────────────────────────

/** The page never gains a horizontal scrollbar — nothing spilled off the canvas. */
async function expectNoHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      viewport: window.innerWidth,
    }
  })
  expect(
    overflow.scrollWidth,
    `${where}: page is ${overflow.scrollWidth}px wide on a ${overflow.viewport}px canvas`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1)
}

/** An element is laid out inside the 390px canvas and has real size. */
async function expectInsideCanvas(page: Page, selector: string, label: string) {
  const box = await page.locator(selector).first().boundingBox()
  expect(box, `${label} has no layout box`).not.toBeNull()
  const { x, width } = box!
  expect(width, `${label} has zero width`).toBeGreaterThan(0)
  expect(x, `${label} starts off-canvas at x=${x}`).toBeGreaterThanOrEqual(-1)
  expect(
    x + width,
    `${label} ends at ${Math.round(x + width)}px, past the ${PHONE.width}px canvas`,
  ).toBeLessThanOrEqual(PHONE.width + 1)
}

const homeComposer = (page: Page) =>
  page
    .getByTestId("home-composer-input")
    .or(page.getByRole("textbox", { name: "Describe the agent you want to build" }))
    .first()

const projectComposer = (page: Page) => page.getByTestId("project-composer-input").first()

/**
 * Open the phone builder.
 *
 * `e2e/local/helpers.ts#openTeamHome` waits on the sidebar's
 * `navigation[name="App sidebar"]`, which a 390px viewport does not render —
 * phone chrome is the hamburger + bottom dock. The explicit builder route
 * (`/(app)/new-project`) is the phone's build entry point and paints without
 * the sidebar, so the phone path goes through it.
 */
async function openPhoneBuilder(page: Page): Promise<void> {
  await page.goto("/")

  // A fresh local stack starts signed out with only a personal workspace; the
  // team workspace appears once onboarding completes (`/api/local/auto-sign-in`
  // → `/api/onboarding/complete`, the same pair `mobile-personal-walkthrough`
  // uses). Both are idempotent.
  const workspaceId = await page.evaluate(async (apiBase) => {
    const signIn = await fetch(`${apiBase}/api/local/auto-sign-in`, {
      method: "POST",
      credentials: "include",
    })
    if (!signIn.ok) {
      throw new Error(`Local auto-sign-in failed (${signIn.status})`)
    }
    await fetch(`${apiBase}/api/onboarding/complete`, {
      method: "POST",
      credentials: "include",
    }).catch(() => undefined)

    const res = await fetch(`${apiBase}/api/workspaces`, { credentials: "include" })
    const body = await res.json()
    const items = (body?.items ?? body?.data?.items ?? []) as Array<{
      id: string
      kind?: string
    }>
    return (
      items.find((w) => w.kind !== "personal")?.id ??
      items.find((w) => w.kind === "personal")?.id ??
      null
    )
  }, LOCAL_API_BASE)
  expect(workspaceId, "local stack has no workspace to build in").not.toBeNull()

  await page.evaluate((id) => {
    localStorage.setItem("shogo:active-workspace-id", id)
    localStorage.setItem("shogo:active-workspace-kind", "team")
  }, workspaceId!)

  await page.goto("/(app)/new-project")
  await page
    .getByTestId("home-composer-input")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
}

test.describe("build-first onboarding on a phone", () => {
  test.use({ viewport: { ...PHONE } })

  test("a build prompt goes from the home composer to a readable build reply at 390×844", async ({
    page,
  }) => {
    test.setTimeout(180_000)

    await installChatMock(page)
    await answerTurnProbe(page)

    await openPhoneBuilder(page)

    // ── the entry surface fits ──────────────────────────────────────────────
    await expectNoHorizontalOverflow(page, "home")
    await expectInsideCanvas(page, '[data-testid="home-composer-input"]', "home composer")
    await expect(homeComposer(page)).toBeVisible()

    // ── send a build prompt, exactly like a first-run user ──────────────────
    const input = homeComposer(page)
    await input.click()
    await input.fill(BUILD_PROMPT)
    await expect(input).toHaveValue(BUILD_PROMPT)
    await page.getByRole("button", { name: "Send message" }).first().click()

    await page.waitForURL(/\/projects\//, { timeout: 60_000 })
    await projectComposer(page).waitFor({ state: "visible", timeout: 20_000 })

    // ── the project view keeps the user's words and shows the build reply ───
    await expect(page.getByText(BUILD_PROMPT, { exact: false }).first()).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText(BUILD_REPLY, { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    })

    // ── and, crucially, still fits the canvas ───────────────────────────────
    await expectNoHorizontalOverflow(page, "project chat")
    await expectInsideCanvas(page, '[data-testid="project-composer-input"]', "project composer")

    // The reply must be readable without horizontal scrolling: the bubble that
    // carries it stays inside the canvas too.
    const reply = page.getByText(BUILD_REPLY, { exact: false }).first()
    const replyBox = await reply.boundingBox()
    expect(replyBox, "build reply has no layout box").not.toBeNull()
    expect(
      replyBox!.x + replyBox!.width,
      `build reply overflows the ${PHONE.width}px canvas`,
    ).toBeLessThanOrEqual(PHONE.width + 1)
  })
})
