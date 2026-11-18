// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin → AI Analytics → Quality & Efficiency: the **Cache hit** line reads a
 * percentage, not a fraction (SHO-411).
 *
 * `getQualityTimeseries` documents every rate in its point as 0–100 and builds
 * `agentEscalatedRate` / `agentLoopRate` / `agentMaxTurnsRate` with `pct()`, but
 * `cacheHitRatio` came from `promptCacheHitRatio`, which returns a 0–1
 * fraction. The chart formats it with `PCT`, which only appends `%`, so a ~90%
 * cache day rendered as "0.9%" — the data was right, the units were not.
 *
 * The server half is pinned by `analytics-rollups.golden.test.ts` (it asserts
 * `100 * 50/150`). This spec pins what a person actually sees: the Quality &
 * Efficiency chart's y-axis ticks and its hover tooltip both print the value on
 * the same 0–100 scale as the sibling rate lines.
 *
 * Needs the local stack (`E2E_LOCAL_START_STACK=1` starts it).
 */
import { expect, test, type Page } from "@playwright/test"
import { api, signInByApi } from "./team-nav-seed"

/** A ~90% cache day, as the daily series now reports it (0–100). */
const CACHE_HIT = 90
const DAYS = 3

/** Same shape `getQualityTimeseries` returns, one point per day. */
function qualityFixture() {
  return Array.from({ length: DAYS }, (_, i) => ({
    date: `2026-07-0${i + 1}`,
    cacheHitRatio: CACHE_HIT,
    costPerMessage: 0.02,
    costPerActiveUser: 0.4,
    agentEscalatedRate: 10,
    agentLoopRate: 5,
    agentMaxTurnsRate: 2,
  }))
}

let page: Page

/**
 * The Quality & Efficiency card, found by its own title. The page renders
 * several `stacked-chart-area` charts (spend, quality, activity), so the chart
 * has to be scoped to this card rather than taken as the first on the page.
 */
function qualityChart() {
  return page
    .getByText("Quality & Efficiency", { exact: true })
    .locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]')
    .getByTestId("stacked-chart-area")
}

test.describe("Admin quality chart cache-hit units", () => {
  test.describe.configure({ mode: "serial" })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    await signInByApi(page)
    await page.route(/\/api\/admin\/analytics\/quality-timeseries/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: qualityFixture() }),
      }),
    )
    await page.goto("/ai-analytics")
    await expect(page.getByText("Quality watch")).toBeVisible({ timeout: 60_000 })
  })

  test.afterAll(async () => {
    await page.context().close()
  })

  test("the Cache hit line's y-axis ticks are percentages, not fractions", async () => {
    const chart = qualityChart()
    await expect(chart).toBeVisible({ timeout: 30_000 })

    // The tick labels are the chart's own `formatY` output. A 0–1 series would
    // print "0.9%" here; a 0–100 series prints "90%".
    await expect(chart).toContainText(`${CACHE_HIT}%`)
    await expect(chart).not.toContainText(`${CACHE_HIT / 100}%`)
  })

  test("hovering a day shows the cache-hit rate as a percentage in the tooltip", async () => {
    const chart = qualityChart()
    await chart.getByTestId("stacked-chart-hit-0").hover()

    // "Date · value" is the tooltip header — the `·` separator appears nowhere
    // else — and the value is the day's cache-hit rate on the 0–100 scale.
    await expect(chart).toContainText(`· ${CACHE_HIT}%`, { timeout: 15_000 })
  })

  test("the live endpoint returns cacheHitRatio on the 0–100 scale", async () => {
    const res = await api(page, "GET", "/api/admin/analytics/quality-timeseries?period=30d")
    expect(res.status).toBe(200)

    const points = (res.json?.data ?? []) as Array<{ cacheHitRatio: number }>
    expect(Array.isArray(points)).toBe(true)
    for (const point of points) {
      expect(typeof point.cacheHitRatio).toBe("number")
      // A fraction would still sit inside this range, so the scale itself is
      // pinned by the golden test; this guards the endpoint's contract (a
      // percentage can never exceed 100) and that the field is still a number.
      expect(point.cacheHitRatio).toBeGreaterThanOrEqual(0)
      expect(point.cacheHitRatio).toBeLessThanOrEqual(100)
    }
  })
})
