// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-439: on the wide pane the transcript runs *under* the composer instead of
 * stopping above an opaque band.
 *
 * The wide footer (running-agents dock, the reserved typing slot, the composer)
 * is now measured and pulled up over the list with `marginTop: -footerHeight`
 * and `pointerEvents="box-none"`, and the list gets `insets.bottom =
 * footerHeight` — the mechanism the phone pane already used. The band bug was
 * that the list ended where the footer began, so the ~110px between the newest
 * message and the input painted the pane's own background and clipped anything
 * scrolled under it.
 *
 * These tests drive the real wide team-chat pane in Chromium: the transcript's
 * scroll box has to reach the bottom of the pane, the newest message has to
 * clear the composer at rest, the empty band above the input has to pass a real
 * wheel gesture through to the transcript, and the jump-to-latest pill has to
 * sit above the composer.
 *
 *   npx playwright test --config e2e/local/playwright.config.ts \
 *     team-chat-footer-overlay --project chromium --retries 0
 *
 * (add `E2E_LOCAL_STACK=1`/`E2E_LOCAL_START_STACK=1` to have Playwright boot
 * the local stack.)
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { api, signIn, teamWorkspaceId } from "./team-nav-seed"

/** Enough messages that the transcript is taller than a 720px pane. */
const MESSAGES = 24

let seeder: Page
let workspaceId: string
let channelId: string
let suffix: string
let newest: string

interface ScrollBox {
  top: number
  bottom: number
  height: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * The box the transcript actually scrolls: the nearest ancestor that scrolls
 * vertically. Measured on a message, because the list itself is inverted and
 * has no stable selector across the app's versions.
 */
const transcript = (target: Locator) =>
  target.evaluate((element): ScrollBox | null => {
    let node: HTMLElement | null = element.parentElement
    while (node) {
      const style = getComputedStyle(node)
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) {
        const rect = node.getBoundingClientRect()
        return {
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
        }
      }
      node = node.parentElement
    }
    return null
  })

const newestMessage = (page: Page) => page.getByText(newest).last()

async function openChannel(page: Page): Promise<void> {
  await page.goto(`/c/${channelId}`)
  await expect(newestMessage(page)).toBeVisible({ timeout: 60_000 })
}

test.describe("SHO-439: the wide transcript runs under the composer", () => {
  test.describe.configure({ mode: "serial" })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    const context = await browser.newContext()
    seeder = await context.newPage()
    await signIn(seeder)
    suffix = Date.now().toString(36)
    workspaceId = await teamWorkspaceId(seeder)

    const created = await api(seeder, "POST", `/api/workspaces/${workspaceId}/conversations`, {
      name: `footer-overlay-${suffix}`,
      kind: "public",
    })
    channelId = created.json?.conversation?.id
    expect(channelId, `channel create: ${JSON.stringify(created.json)}`).toBeTruthy()

    for (let i = 1; i <= MESSAGES; i += 1) {
      await api(seeder, "POST", `/api/conversations/${channelId}/messages`, {
        text: `overlay message ${i} of ${MESSAGES} for ${suffix}`,
      })
    }
    newest = `newest over the composer ${suffix}`
    await api(seeder, "POST", `/api/conversations/${channelId}/messages`, { text: newest })
  })

  test.afterAll(async () => {
    if (channelId) {
      await seeder?.request
        .delete(`${process.env.E2E_API_URL || "http://localhost:8002"}/api/conversations/${channelId}`)
        .catch(() => {})
    }
    await seeder?.context().close()
  })

  test.beforeEach(async ({ page }) => {
    await signIn(page)
    await page.addInitScript((id) => {
      localStorage.setItem("shogo:active-workspace-id", id)
      localStorage.setItem("shogo:active-workspace-kind", JSON.stringify({ id, kind: "team" }))
    }, workspaceId)
    // The wide desktop layout: the band only existed on this one.
    await page.setViewportSize({ width: 1280, height: 720 })
  })

  test("the transcript reaches the bottom of the pane and the newest message clears the composer", async ({ page }) => {
    await openChannel(page)

    const list = await transcript(newestMessage(page))
    expect(list, "the timeline has a scroll box").not.toBeNull()
    const paneBottom = await page.evaluate(() => window.innerHeight)
    // The band bug: the list stopped at the footer's top edge, ~110px short of
    // the pane's bottom, and that gap painted the pane background.
    expect(list!.bottom, "the transcript runs to the pane's bottom edge, not the footer's top").toBeGreaterThan(
      paneBottom - 8,
    )

    const composer = page.getByLabel("Message", { exact: true }).last()
    const composerTop = await composer.evaluate((element) => element.getBoundingClientRect().top)
    const newestBottom = await newestMessage(page).evaluate((element) => element.getBoundingClientRect().bottom)
    expect(newestBottom, "the newest message is not hidden behind the composer").toBeLessThan(composerTop - 2)
    // It sits just above the footer, where it did before — no bigger gap.
    expect(newestBottom, "the newest message sits just above the composer").toBeGreaterThan(composerTop - 140)
  })

  test("the empty band above the input passes a wheel through, and the jump pill clears the composer", async ({
    page,
  }) => {
    await openChannel(page)

    const slot = page.getByTestId("typing-slot")
    await expect(slot).toBeVisible()
    const before = await transcript(newestMessage(page))
    expect(before!.scrollTop, "the channel opens at the newest message").toBeLessThan(40)

    const point = await slot.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const x = rect.left + rect.width * 0.5
      const y = rect.top + rect.height * 0.5
      const hit = document.elementFromPoint(x, y) as HTMLElement | null
      // Walk up from whatever was hit to the scroll box, the way the browser
      // routes a wheel gesture.
      let node: HTMLElement | null = hit
      let inTranscript = false
      while (node) {
        const style = getComputedStyle(node)
        if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) {
          inTranscript = true
          break
        }
        node = node.parentElement
      }
      const inFooter = !!hit?.closest('[data-testid="composer-footer"]')
      return { x, y, inTranscript, inFooter, hitTag: hit?.tagName ?? null }
    })

    // Nothing draws or catches in the empty slot: the pointer reaches the
    // transcript behind it (`box-none`).
    expect(point.inTranscript, `the point over the empty slot hits the transcript (hit ${point.hitTag})`).toBe(true)
    expect(point.inFooter, "the footer does not catch the pointer over the empty slot").toBe(false)

    await page.mouse.move(point.x, point.y)
    await page.mouse.wheel(0, -240)
    await expect
      .poll(async () => (await transcript(newestMessage(page)))!.scrollTop, { timeout: 10_000 })
      .toBeGreaterThan(80)

    // Away from the newest message, so the jump pill is up — and it has to sit
    // above the composer, not on it (`bottom: insets.bottom + 12`).
    await page.mouse.wheel(0, -240)
    const pill = page.getByLabel("Jump to latest message")
    await expect(pill).toBeVisible({ timeout: 15_000 })
    const pillBox = await pill.boundingBox()
    const inputTop = await page
      .getByLabel("Message", { exact: true })
      .last()
      .evaluate((element) => element.getBoundingClientRect().top)
    expect(pillBox, "the jump pill is laid out").not.toBeNull()
    expect(
      pillBox!.y + pillBox!.height,
      `the jump pill clears the composer (pill ${JSON.stringify(pillBox)}, input top ${inputTop})`,
    ).toBeLessThan(inputTop)
  })
})
