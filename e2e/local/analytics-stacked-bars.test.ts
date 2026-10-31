// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Analytics → Usage: the daily usage charts are **stacked bars** (SHO-272).
 *
 * The workspace Usage tab is the surface a member can reach without
 * super-admin, so the spec opens it the way a person does (More → Analytics →
 * Usage) and stubs the single dashboard response with a deterministic
 * timeseries: 30 days, two models, one all-zero day. Bars are then asserted on
 * their real SVG geometry — one rect per non-zero (day, series) segment, a
 * day's segments filling that day's slot, no rect at all for the empty day —
 * and hovering a slot must open the tooltip with the date, the day's total and
 * the per-series breakdown.
 *
 * Needs the local stack (`E2E_LOCAL_START_STACK=1` starts it).
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { activateTeamWorkspace, signIn, teamWorkspaceId } from "./team-nav-seed"

const DAYS = 30
/** Day 5 is empty on purpose: it must render no rect at all. */
const EMPTY_DAY = 5
const SPEND_A = 0.5
const SPEND_B = 0.25

interface Segment {
  x: number
  y: number
  w: number
  h: number
}

/** Same shape the panel's single `analytics/dashboard` request returns. */
function dashboardFixture() {
  const days = Array.from({ length: DAYS }, (_, i) => {
    const date = `2026-07-${String(i + 1).padStart(2, "0")}`
    const empty = i === EMPTY_DAY
    return {
      date,
      byModel: { "model-a": empty ? 0 : SPEND_A, "model-b": empty ? 0 : SPEND_B },
      total: empty ? 0 : SPEND_A + SPEND_B,
    }
  })
  const live = DAYS - 1
  const totalSpend = live * (SPEND_A + SPEND_B)
  return {
    window: { from: days[0].date, to: days[DAYS - 1].date, period: "30d" },
    summary: {
      summaries: [],
      totals: {
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalBilledUsd: totalSpend,
        totalRawUsd: totalSpend,
        totalToolCalls: 0,
        uniqueUsers: 0,
        uniqueModels: 2,
      },
      total: 0,
      page: 1,
      limit: 50,
    },
    timeseries: {
      days,
      totals: {
        totalSpendUsd: totalSpend,
        totalIncludedUsd: totalSpend,
        totalOnDemandUsd: 0,
        uniqueModels: 2,
      },
      models: ["model-a", "model-b"],
      groupBy: "model",
      metric: "spend",
    },
    usage: null,
    logCount: 0,
    chat: null,
  }
}

let page: Page

/** Opens the workspace Analytics screen the way a person does — the More tab. */
async function openAnalytics(target: Page) {
  await target.goto("/")
  const rail = target.getByRole("navigation", { name: "Workspace tabs" })
  const dock = target.getByTestId("team-dock")
  const moreTab = rail
    .getByRole("tab", { name: /^More/ })
    .or(dock.getByRole("tab", { name: /^More/ }))
    .or(target.getByRole("tab", { name: /^More/ }))
  await moreTab.first().click({ timeout: 60_000 })

  const analyticsLink = target.getByTestId("more-panel").getByRole("link", { name: "Analytics" })
  await analyticsLink.first().click({ timeout: 30_000 })
  await expect(target.getByTestId("analytics-screen")).toBeVisible({ timeout: 60_000 })
  await target.getByTestId("analytics-view-usage").click()
  await expect(target.getByTestId("usage-section-spend")).toBeVisible({ timeout: 60_000 })
}

/** The chart's real SVG geometry, read off the rendered rects. */
async function readSegments(chart: Locator): Promise<Segment[]> {
  const handles = await chart.locator("svg rect").all()
  const segments: Segment[] = []
  for (const handle of handles) {
    const [x, y, w, h] = await Promise.all([
      handle.getAttribute("x"),
      handle.getAttribute("y"),
      handle.getAttribute("width"),
      handle.getAttribute("height"),
    ])
    if (x == null || y == null || w == null || h == null) continue
    segments.push({ x: +x, y: +y, w: +w, h: +h })
  }
  return segments
}

test.describe("Analytics usage chart bars", () => {
  test.describe.configure({ mode: "serial" })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    await signIn(page)
    const workspaceId = await teamWorkspaceId(page)
    await activateTeamWorkspace(page, workspaceId)
    await page.route(/\/api\/workspaces\/[^/]+\/analytics\/dashboard/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: dashboardFixture() }),
      }),
    )
    await openAnalytics(page)
  })

  test.afterAll(async () => {
    await page.context().close()
  })

  test("each live day is one stacked bar and the empty day draws nothing", async () => {
    const chart = page.getByTestId("stacked-chart-bar")
    await expect(chart).toBeVisible({ timeout: 30_000 })

    const segments = await readSegments(chart)
    // Two series per live day, none for the empty day.
    expect(segments.length).toBe((DAYS - 1) * 2)

    // Group by x: each day's segments share one column and stack without gaps.
    const columns = new Map<number, Segment[]>()
    for (const seg of segments) {
      const key = Math.round(seg.x * 100) / 100
      columns.set(key, [...(columns.get(key) ?? []), seg])
    }
    expect(columns.size).toBe(DAYS - 1)
    for (const column of columns.values()) {
      expect(column.length).toBe(2)
      // Sorted by y: the top segment's bottom edge meets the lower one's top
      // edge, so the two segments tile the day's bar with no gap or overlap.
      const [top, bottom] = [...column].sort((a, b) => a.y - b.y)
      expect(top.y + top.h).toBeCloseTo(bottom.y, 1)
      expect(column[0].w).toBeCloseTo(column[1].w, 1)
      expect(column[0].w).toBeLessThanOrEqual(28)
    }

    // Bars sit in equal slots left-to-right and never overlap.
    const xs = [...columns.keys()].sort((a, b) => a - b)
    for (let i = 1; i < xs.length; i += 1) {
      const prev = columns.get(xs[i - 1])![0]
      expect(prev.x + prev.w).toBeLessThanOrEqual(xs[i] + 0.01)
    }
  })

  test("hovering a bar opens the tooltip with the total and the breakdown", async () => {
    const chart = page.getByTestId("stacked-chart-bar")
    // Nothing is hovered yet, so no series label is on screen.
    await expect(chart).not.toContainText("model-a")

    await page.getByTestId("stacked-chart-hit-10").hover()

    // "Date · total" is the tooltip header — the `·` separator appears nowhere
    // else — then one row per series below it.
    await expect(chart).toContainText("· $0.75", { timeout: 15_000 })
    await expect(chart).toContainText("model-a")
    await expect(chart).toContainText("model-b")
  })

  test("bars still line up, and never overlap, at phone width", async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    const chart = page.getByTestId("stacked-chart-bar")
    await expect(chart).toBeVisible()

    const segments = await readSegments(chart)
    expect(segments.length).toBe((DAYS - 1) * 2)

    const columns = new Map<number, Segment[]>()
    for (const seg of segments) {
      const key = Math.round(seg.x * 100) / 100
      columns.set(key, [...(columns.get(key) ?? []), seg])
    }
    const xs = [...columns.keys()].sort((a, b) => a - b)
    expect(xs.length).toBe(DAYS - 1)
    for (let i = 0; i < xs.length; i += 1) {
      const column = columns.get(xs[i])!
      expect(column[0].w).toBeGreaterThanOrEqual(2)
      if (i > 0) {
        const prev = columns.get(xs[i - 1])![0]
        expect(prev.x + prev.w).toBeLessThanOrEqual(xs[i] + 0.01)
      }
    }
  })
})
