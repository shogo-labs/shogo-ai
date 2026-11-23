// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phone navigation standard (SHO-490): every screen you push and every
 * full-screen pane wears the DM's floating glass header — a 44px glass Back (or
 * Close), a glass title pill and glass trailing actions, absolutely positioned
 * over the content with no bar, no border and no fill — instead of the bordered
 * rows, hand-rolled back arrows and small `X` close buttons it grew per screen.
 *
 * The DM is the baseline (AC3): the conversation screen's header must be
 * unchanged. Each surface below is then held to the same shape, and the wide-web
 * side pane keeps its own `PaneHeader` (AC4).
 *
 * Viewport is the card's 390×844. Screenshots of every surface land in
 * `test-results/qa-sho490/` for review.
 *
 * Not covered here, and why: the profile *pane* opened from a conversation
 * (`?profile=`) is side-pane-only (`resolvePanes`: `sidePane && !!profileId`),
 * so on a phone there is no pane to check and it is the wide-web side pane that
 * is asserted below. The full-screen `/people/[userId]` and `/agents/[key]`
 * pages *are* covered, each opened by URL in a fresh context — the case where
 * nothing had loaded their workspace list when they mounted.
 */
import { mkdirSync } from "fs"
import { resolve } from "path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { activateTeamWorkspace, api, cleanupTeamNav, seedTeamNav, signInByApi, type TeamNavSeed } from "./team-nav-seed"

const PHONE = { width: 390, height: 844 }
const WIDE = { width: 1440, height: 900 }
const SHOTS = resolve(__dirname, "../../test-results/qa-sho490")

/** The one phone header, and the glass circle every action in it is drawn with. */
const header = (page: Page) => page.getByTestId("phone-screen-header").first()
const pill = (page: Page) => page.getByTestId("phone-screen-header-title").first()

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) })
}

/** A control is the 44px glass circle, not a 16-24px inline glyph. */
async function expectGlassCircle(control: Locator, name: string) {
  await expect(control, `${name} is on screen`).toBeVisible()
  const box = await control.boundingBox()
  expect(box, `${name} has a box`).not.toBeNull()
  expect(Math.round(box!.width), `${name} is the 44px glass circle`).toBe(44)
  expect(Math.round(box!.height), `${name} is the 44px glass circle`).toBe(44)
}

/**
 * The header floats: absolutely positioned, no border, no background of its
 * own, over the content rather than in a bar above it.
 */
async function expectFloats(page: Page, name: string) {
  const styles = await header(page).evaluate((el) => {
    const s = getComputedStyle(el as HTMLElement)
    return {
      position: s.position,
      borderBottom: s.borderBottomWidth,
      background: s.backgroundColor,
      top: (el as HTMLElement).getBoundingClientRect().top,
    }
  })
  expect(styles.position, `${name}: the header floats over the content`).toBe("absolute")
  expect(styles.borderBottom, `${name}: no border under the header`).toBe("0px")
  expect(["rgba(0, 0, 0, 0)", "transparent"], `${name}: no filled bar behind the header`).toContain(
    styles.background,
  )
  expect(styles.top, `${name}: the header starts at the top of the screen`).toBeLessThanOrEqual(1)
}

/** The screen padded its content by the header, so nothing hides under the glass. */
async function expectContentClearsHeader(page: Page, content: Locator, name: string) {
  const head = await header(page).boundingBox()
  const first = await content.boundingBox()
  if (!head || !first) throw new Error(`${name}: missing a box to measure`)
  expect(first.y, `${name}: content starts below the measured header, not under it`).toBeGreaterThanOrEqual(
    head.y + head.height - 1,
  )
}

test.describe("Phone navigation standard: one floating glass header", () => {
  test.describe.configure({ mode: "serial" })

  let seed: TeamNavSeed
  let itemId: string
  let itemKey: string
  let threadRootId: string
  let seeder: Page

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext()
    seeder = await context.newPage()
    await signInByApi(seeder)
    seed = await seedTeamNav(seeder)

    // A board on the channel plus one card in it, so the card view (the surface
    // the screenshot in the card most likely showed) is reachable by URL.
    const boardRes = await api(seeder, "POST", `/api/workspaces/${seed.workspaceId}/boards`, {
      name: `QA glass ${seed.suffix}`,
      conversationId: seed.channelId,
    })
    const boardId = boardRes.json?.board?.id
    expect(boardId, `board create: ${JSON.stringify(boardRes.json)}`).toBeTruthy()
    const itemRes = await api(seeder, "POST", `/api/boards/${boardId}/items`, { title: `Glass header card ${seed.suffix}` })
    itemId = itemRes.json?.item?.id
    itemKey = itemRes.json?.item?.key
    expect(itemId, `card create: ${JSON.stringify(itemRes.json)}`).toBeTruthy()

    // A thread, so the header the thread view already had is held to the same
    // standard (AC3: it looks as it did, which is now this component).
    const rootText = `thread root ${seed.suffix}`
    await api(seeder, "POST", `/api/conversations/${seed.channelId}/messages`, { text: rootText })
    const list = await api(seeder, "GET", `/api/conversations/${seed.channelId}/messages`)
    threadRootId = ((list.json?.messages ?? []) as Array<{ id: string; text?: string; threadRootId?: string }>).find(
      (m) => !m.threadRootId && m.text === rootText,
    )?.id
    expect(threadRootId, "seeded thread root message").toBeTruthy()
  })

  test.afterAll(async () => {
    await cleanupTeamNav(seeder, seed)
    await seeder.context().close()
  })

  test.beforeEach(async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize(PHONE)
    await signInByApi(page)
    await activateTeamWorkspace(page, seed.workspaceId)
  })

  test("the DM is the baseline: 44px glass Back, glass title pill, no bar", async ({ page }) => {
    await page.goto(`/c/${seed.dmId}`)
    await expect(page.getByTestId("floating-conversation-header")).toBeVisible({ timeout: 60_000 })
    await expectGlassCircle(page.getByRole("button", { name: "Back" }).first(), "the DM's Back")
    await expect(page.getByTestId("phone-screen-header-title")).toHaveCount(0)
    await shot(page, "01-dm-baseline")
  })

  test("the thread header is the same floating glass, Back included (AC3)", async ({ page }) => {
    await page.goto(`/c/${seed.channelId}?thread=${threadRootId}`)
    const threadHeader = page.getByTestId("floating-thread-header").first()
    await expect(threadHeader).toBeVisible({ timeout: 60_000 })
    const styles = await threadHeader.evaluate((el) => {
      const s = getComputedStyle(el as HTMLElement)
      return { position: s.position, border: s.borderBottomWidth, background: s.backgroundColor }
    })
    expect(styles.position, "thread header floats").toBe("absolute")
    expect(styles.border, "thread header has no border").toBe("0px")
    expect(["rgba(0, 0, 0, 0)", "transparent"]).toContain(styles.background)
    await expectGlassCircle(page.getByRole("button", { name: "Back to conversation" }).first(), "the thread's Back")
    await shot(page, "05-thread")
  })

  test("a card opened from a channel wears the glass header (AC2)", async ({ page }) => {
    await page.goto(`/c/${seed.channelId}?card=${itemId}`)
    await expect(header(page)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId("card-pane")).toBeVisible()
    await expect(pill(page)).toContainText(String(itemKey ?? "Card"))
    await expectFloats(page, "card view")
    // Close is the glass circle, and the card's own actions are glass buttons.
    await expectGlassCircle(page.getByTestId("card-pane-close"), "the card's Close")
    await expectGlassCircle(page.getByRole("button", { name: "Archive card" }), "the card's Archive")
    // The desktop row it replaced drew a 16px X inside a 28px pressable.
    const close = await page.getByTestId("card-pane-close").boundingBox()
    expect(Math.round(close!.width), "card view: the small X row is gone").toBeGreaterThan(28)
    await shot(page, "02-card-pane")
  })

  test("the files pane wears the glass header (AC2)", async ({ page }) => {
    await page.goto(`/c/${seed.channelId}?files=1`)
    await expect(page.getByTestId("files-pane")).toBeVisible({ timeout: 60_000 })
    await expect(header(page)).toBeVisible()
    await expect(pill(page)).toContainText("Files in")
    await expectFloats(page, "files pane")
    await expectGlassCircle(page.getByTestId("files-close"), "the files pane's Close")
    await expectContentClearsHeader(page, page.getByPlaceholder("Search files by name"), "files pane")
    await shot(page, "03-files-pane")
  })

  test("the channel doc wears the glass header (AC2)", async ({ page }) => {
    await page.goto(`/c/${seed.channelId}?doc=1`)
    await expect(header(page)).toBeVisible({ timeout: 60_000 })
    await expect(pill(page)).not.toBeEmpty()
    await expectFloats(page, "channel doc")
    await expectGlassCircle(page.getByTestId("doc-close"), "the doc's Close")
    await shot(page, "04-doc-pane")
  })

  test("notifications wear the glass header (AC2)", async ({ page }) => {
    await page.goto("/notifications")
    await expect(header(page)).toBeVisible({ timeout: 60_000 })
    await expect(pill(page)).toContainText("Notifications")
    await expectFloats(page, "notifications")
    await expectGlassCircle(page.getByRole("button", { name: "Back" }).first(), "notifications' Back")
    await shot(page, "07-notifications")
  })

  test("Starred's back control is the glass circle, not a plain arrow (AC2)", async ({ page }) => {
    await page.goto("/starred")
    const back = page.getByTestId("phone-back-button")
    await expect(back).toBeVisible({ timeout: 60_000 })
    await expectGlassCircle(back, "the Starred screen's Back")
    // The glass circle paints the shared backdrop; the plain arrow did not.
    await expect(back.locator(":scope > div").first()).toHaveCount(1)
    await shot(page, "08-starred")
  })

  test("a person's profile wears the glass header on a cold deep link (AC2)", async ({ page }) => {
    await page.goto(`/people/${seed.dmPeerId}`)
    await expect(page.getByTestId("user-profile-screen")).toBeVisible({ timeout: 60_000 })
    await expect(header(page)).toBeVisible()
    await expect(pill(page)).toContainText("Profile")
    await expectFloats(page, "person profile")
    await expectGlassCircle(page.getByRole("button", { name: "Back" }).first(), "the person profile's Back")
    await shot(page, "12-person-profile")
  })

  test("an agent's profile wears the glass header on a cold deep link (AC2)", async ({ page }) => {
    await page.goto("/agents/ws")
    await expect(page.getByTestId("agent-profile-screen")).toBeVisible({ timeout: 60_000 })
    await expect(header(page)).toBeVisible()
    await expect(pill(page)).not.toBeEmpty()
    await expectFloats(page, "agent profile")
    await expectGlassCircle(page.getByRole("button", { name: "Back" }).first(), "the agent profile's Back")
    await shot(page, "13-agent-profile")
  })

  test("wide web keeps the side-pane rows and gets no phone header (AC4)", async ({ page }) => {
    test.setTimeout(240_000)
    await page.setViewportSize(WIDE)

    await page.goto(`/c/${seed.channelId}?files=1`)
    await expect(page.getByTestId("files-pane")).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId("phone-screen-header")).toHaveCount(0)
    await expect(page.getByText("Files in", { exact: false }).first()).toBeVisible()
    await shot(page, "09-wide-files-pane")

    // The profile pane is side-pane-only, so this is where it still renders.
    await page.goto(`/c/${seed.channelId}?profile=${seed.dmPeerId}`)
    await expect(page.getByTestId("user-profile-pane")).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId("phone-screen-header")).toHaveCount(0)
    const paneClose = await page.getByTestId("user-profile-close").boundingBox()
    expect(Math.round(paneClose!.width), "wide web keeps the small inline X").toBeLessThan(44)
    await shot(page, "10-wide-profile-pane")

    await page.goto("/notifications")
    await expect(page.getByText("Notifications", { exact: true }).first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId("phone-screen-header")).toHaveCount(0)
    await shot(page, "11-wide-notifications")
  })
})
