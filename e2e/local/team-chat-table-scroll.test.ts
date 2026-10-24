// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A markdown table inside team chat scrolls on both axes (SHO-162).
 *
 * Team chat renders its timeline as an *inverted* `FlatList`. On web,
 * react-native-web attaches a `wheel` listener to that list which reads only
 * `deltaY`, measures scrollability on `ev.target` (the `<td>` under the
 * pointer, never Streamdown's `overflow-x-auto overflow-y-auto` wrapper) and
 * always calls `preventDefault`. A table wider than the thread sidebar
 * therefore never moved sideways, and the gesture was swallowed whole.
 *
 * These tests drive real Chromium wheel events over a real table in the real
 * shell — thread sidebar (the narrow pane Russell hit) and the channel
 * timeline — and assert both what the browser did (the wrapper's `scrollLeft`)
 * and that the timeline still reaches the newest message with the pointer over
 * a table.
 *
 *   npx playwright test --config e2e/local/playwright.config.ts \
 *     team-chat-table-scroll --project chromium --retries 0
 *
 * (add `E2E_LOCAL_START_STACK=1` to have Playwright boot the local stack.)
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { api, signIn, teamWorkspaceId } from "./team-nav-seed"

let seeder: Page
let workspaceId: string
let channelId: string
let threadRootId: string
let suffix: string

/**
 * Every cell is one long unbreakable token: with nothing to wrap, the table's
 * min-content width runs well past any pane, which is what makes it overflow.
 * (A hyphen or space would give the browser a place to break, and the table
 * would fold itself into the pane instead.)
 */
const token = (tag: string, i: number) => `${tag}${i}`.padEnd(34, "0123456789")

const WIDE_TABLE = (marker: string) =>
  [
    "| service | owner | p50 | p95 | p99 | errors | saturation | notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...Array.from(
      { length: 6 },
      (_, i) =>
        `| ${token("checkoutservice", i)} | ${token("platformoncall", i)} | ${token("p50ms", i)} | ${token("p95ms", i)} | ${token("p99ms", i)} | ${token("errors", i)} | ${token("saturation", i)} | ${token("rollbackready", i)}${marker.replace(/-/g, "")} |`,
    ),
  ].join("\n")

/** How many replies the thread holds, so the sidebar has somewhere to scroll. */
const REPLIES = 26

/** The table in the timeline, with the wrapper Streamdown puts around it. */
const table = (page: Page) => page.locator('table[data-streamdown="table"]').last()

interface Metrics {
  /** The wrapper Streamdown puts around the table — the box that must scroll. */
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
  overflowX: string
  className: string
}

/** Measured on the `<table>`: its parent is Streamdown's scroll wrapper. */
const wrapperMetrics = (target: Locator) =>
  target.evaluate((element): Metrics => {
    const wrapper = element.parentElement as HTMLElement
    return {
      scrollLeft: wrapper.scrollLeft,
      scrollWidth: wrapper.scrollWidth,
      clientWidth: wrapper.clientWidth,
      overflowX: getComputedStyle(wrapper).overflowX,
      className: wrapper.className,
    }
  })

interface TimelineMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * The box the browser would scroll for a vertical gesture at this element: the
 * nearest scrollable ancestor, which is the inverted list's own scroll node.
 */
const timelineMetrics = (target: Locator) =>
  target.evaluate((element): TimelineMetrics | null => {
    let node: HTMLElement | null = element.parentElement
    while (node) {
      const style = getComputedStyle(node)
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) {
        return { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }
      }
      node = node.parentElement
    }
    return null
  })

/**
 * A viewport point that hit-tests inside the table, so a wheel event lands on a
 * cell — the element RN-web misreads — and not on a chip the row overlays it
 * with.
 *
 * Measured against the table's *wrapper*: the table itself starts moving left
 * as it scrolls, so its own box leaves the pane and a point derived from it
 * lands outside. The wrapper stays put, and once scrolled every point inside it
 * is still over a cell.
 */
async function pointOverTable(target: Locator): Promise<{ x: number; y: number }> {
  const point = await target.evaluate((element) => {
    const wrapper = element.parentElement as HTMLElement
    const box = wrapper.getBoundingClientRect()
    // A grid, not a few fractions: once the newest message is part-scrolled out
    // of the pane only a thin sliver of the table is still painted, and the
    // point has to land in it.
    for (let ty = 0.05; ty < 1; ty += 0.1) {
      for (let tx = 0.1; tx < 1; tx += 0.15) {
        const x = box.left + box.width * tx
        const y = box.top + box.height * ty
        if (x < 8 || y < 8 || x > window.innerWidth - 8 || y > window.innerHeight - 8) continue
        const hit = document.elementFromPoint(x, y)
        if (hit && wrapper.contains(hit)) return { x, y }
      }
    }
    return null
  })
  if (!point) throw new Error("no point over the table's wrapper is painted inside its pane")
  return point
}

/** A real browser wheel gesture, at the pointer's current position. */
async function wheel(page: Page, target: Locator, deltaX: number, deltaY: number, shift = false): Promise<void> {
  const { x, y } = await pointOverTable(target)
  await page.mouse.move(x, y)
  if (shift) await page.keyboard.down("Shift")
  try {
    await page.mouse.wheel(deltaX, deltaY)
  } finally {
    if (shift) await page.keyboard.up("Shift")
  }
  // Momentum/inertia is not dispatched by Playwright; give the listener a frame.
  await page.waitForTimeout(150)
}

test.describe("markdown tables in team chat scroll on both axes", () => {
  test.describe.configure({ mode: "serial" })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    const context = await browser.newContext()
    seeder = await context.newPage()
    await signIn(seeder)
    suffix = Date.now().toString(36)
    workspaceId = await teamWorkspaceId(seeder)

    const created = await api(seeder, "POST", `/api/workspaces/${workspaceId}/conversations`, {
      name: `table-scroll-${suffix}`,
      kind: "public",
    })
    channelId = created.json?.conversation?.id
    expect(channelId, `channel create: ${JSON.stringify(created.json)}`).toBeTruthy()

    const rootText = `thread root ${suffix}`
    await api(seeder, "POST", `/api/conversations/${channelId}/messages`, { text: rootText })
    const listed = await api(seeder, "GET", `/api/conversations/${channelId}/messages`)
    threadRootId = (listed.json?.messages ?? []).find((m: any) => !m.threadRootId && m.text === rootText)?.id
    expect(threadRootId, "seeded thread root message").toBeTruthy()

    for (let i = 1; i <= REPLIES; i += 1) {
      await api(seeder, "POST", `/api/conversations/${channelId}/messages`, {
        text: `reply ${i} of ${REPLIES} in the table thread ${suffix}`,
        threadRootId,
      })
    }
    // The newest reply carries the table, so scrolling down has a destination.
    await api(seeder, "POST", `/api/conversations/${channelId}/messages`, {
      text: `latest-${suffix}\n\n${WIDE_TABLE(`newest-${suffix}`)}`,
      threadRootId,
    })
    // A top-level table for the channel timeline, below the thread in the pane.
    await api(seeder, "POST", `/api/conversations/${channelId}/messages`, {
      text: `channel-table-${suffix}\n\n${WIDE_TABLE(`channel-${suffix}`)}`,
    })
  })

  test.afterAll(async () => {
    if (channelId) await seeder?.request.delete(`${apiPath(`/api/conversations/${channelId}`)}`).catch(() => {})
    await seeder?.context().close()
  })

  test.beforeEach(async ({ page }) => {
    await signIn(page)
    await page.addInitScript((id) => {
      localStorage.setItem("shogo:active-workspace-id", id)
      localStorage.setItem("shogo:active-workspace-kind", JSON.stringify({ id, kind: "team" }))
    }, workspaceId)
    // The wide desktop layout puts the thread in a resizable side pane.
    await page.setViewportSize({ width: 1280, height: 720 })
  })

  test("the thread sidebar scrolls a wide table sideways", async ({ page }) => {
    await page.goto(`/c/${channelId}?thread=${threadRootId}`)
    await expect(page.getByText(`latest-${suffix}`)).toBeVisible({ timeout: 60_000 })

    const tableEl = table(page)
    const cell = tableEl.locator("td").first()
    const before = await wrapperMetrics(tableEl)
    expect(before.overflowX, `Streamdown's table wrapper is the scroll box (${before.className})`).toBe("auto")
    expect(before.scrollWidth, "the table is wider than the thread sidebar").toBeGreaterThan(before.clientWidth + 40)
    expect(before.scrollLeft).toBe(0)

    // A trackpad swipe: deltaX only, the gesture RN-web drops entirely.
    await wheel(page, cell, 160, 0)
    const swiped = await wrapperMetrics(tableEl)
    expect(swiped.scrollLeft, "a sideways swipe moves the table").toBeGreaterThan(40)

    // Shift + mouse wheel, the desktop equivalent.
    await wheel(page, cell, 0, 160, true)
    const shifted = await wrapperMetrics(tableEl)
    expect(shifted.scrollLeft, "shift+wheel moves the table further").toBeGreaterThan(swiped.scrollLeft + 40)

    // The far columns are reachable.
    for (let i = 0; i < 12; i += 1) await wheel(page, cell, 400, 0)
    const end = await wrapperMetrics(tableEl)
    expect(end.scrollLeft, "the table reaches its last column").toBeGreaterThan(end.scrollWidth - end.clientWidth - 8)
  })

  test("the thread sidebar scrolls down to the newest message with the pointer over a table", async ({ page }) => {
    await page.goto(`/c/${channelId}?thread=${threadRootId}`)
    await expect(page.getByText(`latest-${suffix}`)).toBeVisible({ timeout: 60_000 })

    const cell = table(page).locator("td").first()
    const opened = await timelineMetrics(cell)
    expect(opened, "the thread has its own scroll box").not.toBeNull()
    expect(opened!.scrollHeight, "the thread is taller than the pane").toBeGreaterThan(opened!.clientHeight + 100)
    expect(opened!.scrollTop, "the thread opens at the newest message").toBeLessThan(40)

    // A nibble upwards, over a cell: enough to prove the gesture reaches the
    // timeline, small enough that the table is still painted for the way back.
    await wheel(page, cell, 0, -120)
    const older = await timelineMetrics(cell)
    expect(older!.scrollTop, "the pointer over a table still scrolls the thread up").toBeGreaterThan(80)

    // ...and back down to the newest message, over the same table.
    await wheel(page, cell, 0, 900)
    const newest = await timelineMetrics(cell)
    expect(newest!.scrollTop, "the thread reaches the bottom again").toBeLessThan(40)
    await expect(page.getByText(`latest-${suffix}`)).toBeInViewport()

    // Past the end it stays put rather than stalling short of the newest message.
    await wheel(page, cell, 0, 900)
    const settled = await timelineMetrics(cell)
    expect(settled!.scrollTop, "scrolling past the newest message is a no-op").toBeLessThan(40)
    await expect(page.getByText(`latest-${suffix}`)).toBeInViewport()
  })

  test("the channel timeline scrolls a wide table sideways", async ({ page }) => {
    await page.goto(`/c/${channelId}`)
    await expect(page.getByText(`channel-table-${suffix}`)).toBeVisible({ timeout: 60_000 })

    const tableEl = table(page)
    const cell = tableEl.locator("td").first()
    const before = await wrapperMetrics(tableEl)
    expect(before.scrollWidth, "the channel pane is narrower than the table").toBeGreaterThan(before.clientWidth + 40)

    await wheel(page, cell, 200, 0)
    expect((await wrapperMetrics(tableEl)).scrollLeft, "a sideways swipe moves the table").toBeGreaterThan(40)
  })
})

/** `api()` prefixes LOCAL_API_BASE; `page.request.delete` wants a full URL. */
function apiPath(path: string): string {
  return `${process.env.E2E_API_URL || "http://localhost:8002"}${path}`
}
