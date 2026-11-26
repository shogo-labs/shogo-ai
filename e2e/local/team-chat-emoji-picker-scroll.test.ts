// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The emoji picker must scroll on web, and must never open taller than the
 * window it opens into.
 *
 * The picker is a 312px panel whose body is a `FlatList`; on web that list is
 * the only scroll box, so two things can go wrong and both read to the user as
 * "the picker has no scroll":
 *
 *   - the list's box is not actually scrollable (no range, or a wheel the
 *     browser spends elsewhere), so the emoji below the fold are unreachable;
 *   - the panel is taller than the room it opens in — the composer's emoji
 *     panel sits at the bottom of the pane, so a fixed-height panel runs off the
 *     bottom edge and the rows past the edge can be neither seen nor reached.
 *
 * This spec opens the picker the way a person does — from the composer, and from
 * a message's reaction popover — wheels over it, and asserts the list moved, then
 * asserts the whole panel is inside the viewport at a short window height, which
 * is where a fixed-height body overflows.
 *
 * The reaction popover used to be the hard case: a `FlatList` nested inside
 * another `FlatList`'s tree is rendered non-scrollable by react-native-web
 * (`VirtualizedList._isNestedWithSameOrientation`) even when a `Modal` moves it
 * elsewhere in the DOM, so that picker rendered its whole catalogue into a
 * clipped box with no scroll box at all. The picker now renders a plain
 * `ScrollView` on web, which is what these assertions pin down.
 *
 *   npx playwright test --config e2e/local/playwright.config.ts \
 *     team-chat-emoji-picker-scroll --project chromium --retries 0
 *
 * (add `E2E_LOCAL_START_STACK=1` to have Playwright boot the local stack.)
 */
import { expect, test, type Page } from "@playwright/test"
import { api, signInByApi, teamWorkspaceId } from "./team-nav-seed"
import { writeActiveWorkspaceSelection } from "./helpers"

let seeder: Page
let workspaceId: string
let channelId: string
let suffix: string

interface PickerReport {
  panel: { top: number; bottom: number; left: number; right: number; height: number }
  list: {
    clientHeight: number
    scrollHeight: number
    scrollTop: number
    overflowY: string
    top: number
    bottom: number
  } | null
  viewport: { width: number; height: number }
}

/** Geometry of the open picker: the panel box and its scroll node's metrics. */
const pickerReport = (page: Page) =>
  page.evaluate((): PickerReport | { error: string } => {
    const panel = document.querySelector('[data-testid="emoji-picker"]') as HTMLElement | null
    if (!panel) return { error: "emoji picker not rendered" }
    const rect = panel.getBoundingClientRect()

    let node: HTMLElement | null = null
    const walk = (el: HTMLElement): boolean => {
      for (const child of Array.from(el.children) as HTMLElement[]) {
        const style = getComputedStyle(child)
        if ((style.overflowY === "auto" || style.overflowY === "scroll") && child.scrollHeight > child.clientHeight + 1) {
          node = child
          return true
        }
        if (walk(child)) return true
      }
      return false
    }
    walk(panel)

    const listRect = node ? (node as HTMLElement).getBoundingClientRect() : null
    return {
      panel: {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        height: Math.round(rect.height),
      },
      list: node
        ? {
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            scrollTop: node.scrollTop,
            overflowY: getComputedStyle(node).overflowY,
            top: Math.round(listRect!.top),
            bottom: Math.round(listRect!.bottom),
          }
        : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  })

/** A point inside the list that the browser agrees is painted with the list. */
const listPoint = (page: Page) =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-testid="emoji-picker"]') as HTMLElement | null
    if (!panel) return null
    let node: HTMLElement | null = null
    const walk = (el: HTMLElement): boolean => {
      for (const child of Array.from(el.children) as HTMLElement[]) {
        const style = getComputedStyle(child)
        if ((style.overflowY === "auto" || style.overflowY === "scroll") && child.scrollHeight > child.clientHeight + 1) {
          node = child
          return true
        }
        if (walk(child)) return true
      }
      return false
    }
    walk(panel)
    if (!node) return null
    const rect = (node as HTMLElement).getBoundingClientRect()
    for (let ty = 0.15; ty <= 0.86; ty += 0.2) {
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height * ty
      if (x < 4 || y < 4 || x > window.innerWidth - 4 || y > window.innerHeight - 4) continue
      const hit = document.elementFromPoint(x, y)
      if (hit && (node as HTMLElement).contains(hit)) return { x, y }
    }
    return null
  })

async function openComposerPicker(page: Page) {
  await page.getByLabel("Emoji", { exact: true }).first().click()
  await expect(page.locator('[data-testid="emoji-picker"]')).toBeVisible({ timeout: 15_000 })
}

test.describe("the team-chat emoji picker scrolls", () => {
  test.describe.configure({ mode: "serial" })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext()
    seeder = await context.newPage()
    await signInByApi(seeder)
    suffix = Date.now().toString(36)
    workspaceId = await teamWorkspaceId(seeder)
    const created = await api(seeder, "POST", `/api/workspaces/${workspaceId}/conversations`, {
      name: `emoji-picker-${suffix}`,
      kind: "public",
    })
    channelId = created.json?.conversation?.id
    expect(channelId, `channel create: ${JSON.stringify(created.json)}`).toBeTruthy()
    await api(seeder, "POST", `/api/conversations/${channelId}/messages`, {
      text: `emoji picker seed ${suffix}`,
    })
  })

  test.afterAll(async () => {
    if (channelId) await seeder?.request.delete(`${apiPath(`/api/conversations/${channelId}`)}`).catch(() => {})
    await seeder?.context().close()
  })

  test.beforeEach(async ({ page }) => {
    await signInByApi(page)
    await page.addInitScript(writeActiveWorkspaceSelection, [workspaceId, "team"] as const)
    await page.setViewportSize({ width: 1280, height: 900 })
  })

  test("a wheel over the open picker scrolls its list", async ({ page }) => {
    await page.goto(`/c/${channelId}`)
    await expect(page.getByText(`emoji picker seed ${suffix}`)).toBeVisible({ timeout: 60_000 })
    await openComposerPicker(page)

    const before = (await pickerReport(page)) as PickerReport
    expect(before.list, "the picker body is a scroll container").not.toBeNull()
    expect(
      before.list!.scrollHeight,
      "the emoji list has more rows than the box shows, so there is something to scroll",
    ).toBeGreaterThan(before.list!.clientHeight + 20)

    const point = await listPoint(page)
    expect(point, "a painted point inside the emoji list").not.toBeNull()
    await page.mouse.move(point!.x, point!.y)
    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(400)

    const after = (await pickerReport(page)) as PickerReport
    expect(after.list!.scrollTop - before.list!.scrollTop, "a wheel over the emoji list must move it").toBeGreaterThan(40)
  })

  test("a category icon jumps the list to that section", async ({ page }) => {
    await page.goto(`/c/${channelId}`)
    await expect(page.getByText(`emoji picker seed ${suffix}`)).toBeVisible({ timeout: 60_000 })
    await openComposerPicker(page)

    const before = (await pickerReport(page)) as PickerReport
    expect(before.list, "the picker body is a scroll container").not.toBeNull()
    expect(before.list!.scrollTop, "the list opens at the top").toBeLessThan(20)

    // Flags is the last section, so a jump that works brings its header to the
    // top of the box — and the rows after it are what the old broken picker
    // could never reach.
    await page.getByLabel("Flags", { exact: true }).first().click()
    await page.waitForTimeout(300)

    const after = (await pickerReport(page)) as PickerReport
    expect(after.list!.scrollTop, "the Flags icon must move the list").toBeGreaterThan(before.list!.scrollTop + 1000)
    const header = await page.getByText("Flags", { exact: true }).boundingBox()
    expect(header, "the Flags header is painted").not.toBeNull()
    expect(
      Math.abs(header!.y - after.list!.top),
      "the Flags header lands at the top of the list, not somewhere above or below it",
    ).toBeLessThan(8)
    expect(header!.y, "the Flags header is inside the list's box").toBeLessThan(after.list!.bottom)
  })

  test("the panel fits a short window instead of running off the bottom", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 620 })
    await page.goto(`/c/${channelId}`)
    await expect(page.getByText(`emoji picker seed ${suffix}`)).toBeVisible({ timeout: 60_000 })
    await openComposerPicker(page)

    const report = (await pickerReport(page)) as PickerReport
    expect(report.list, "the picker body is a scroll container").not.toBeNull()
    expect(
      report.list!.scrollHeight,
      "the list still scrolls the whole catalogue",
    ).toBeGreaterThan(report.list!.clientHeight + 20)
    expect(
      report.panel.bottom,
      "the picker must not run off the bottom of the window",
    ).toBeLessThanOrEqual(report.viewport.height)
    expect(report.panel.top, "the picker must stay on screen").toBeGreaterThanOrEqual(0)
  })

  test("the reaction picker's popover scrolls too", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 700 })
    await page.goto(`/c/${channelId}`)
    const seeded = page.getByText(`emoji picker seed ${suffix}`)
    await expect(seeded).toBeVisible({ timeout: 60_000 })

    await seeded.hover()
    await page.getByLabel("More reactions").first().click()
    await expect(page.locator('[data-testid="reaction-picker-popover"] [data-testid="emoji-picker"]')).toBeVisible({
      timeout: 15_000,
    })

    const before = (await pickerReport(page)) as PickerReport
    expect(before.list, "the popover's picker body is a scroll container").not.toBeNull()
    expect(before.panel.bottom, "the popover must not run off the bottom of the window").toBeLessThanOrEqual(
      before.viewport.height,
    )

    const point = await listPoint(page)
    expect(point, "a painted point inside the popover's emoji list").not.toBeNull()
    await page.mouse.move(point!.x, point!.y)
    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(400)

    const after = (await pickerReport(page)) as PickerReport
    expect(after.list!.scrollTop - before.list!.scrollTop, "a wheel over the popover's list must move it").toBeGreaterThan(
      40,
    )
  })
})

/** `api()` prefixes LOCAL_API_BASE; `page.request.delete` wants a full URL. */
function apiPath(path: string): string {
  return `${process.env.E2E_API_URL || "http://localhost:8002"}${path}`
}
