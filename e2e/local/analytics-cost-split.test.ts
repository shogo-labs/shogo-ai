// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Analytics → Usage: spend is two lines, a **Model cost** and a **Shogo fee**,
 * on top of the same Total a person already sees (SHO-288).
 *
 * The plan's acceptance criterion is "the Usage tab on a cloud workspace and a
 * desktop workspace shows Model cost + Shogo fee = Total", and the split is
 * computed server-side per row (one clamp, before summing). So this spec fixes
 * the two shapes at the boundary — a cloud workspace, where `billedUsd` is
 * `rawUsd × 1.20`, and a desktop workspace, where `billedUsd` is 0 and the
 * provider cost lives in `rawUsd` — and asserts what the tab renders for each:
 * the Total, the two lines under it, and the pre-2026-04-24 note for billed
 * rows that have no provider cost recorded.
 *
 * The arithmetic is the point, so the fixtures are hand-computable:
 *   cloud row       billed 1.20, raw 1.00  → model 1.00, fee 0.20
 *   desktop row     billed 0.00, raw 1.00  → model 1.00, fee 0.00
 *   pre-itemised    billed 1.00, raw null  → unitemised 1.00
 *   Total 3.20 = 2.00 model + 0.20 fee + 1.00 unitemised
 *
 * The last test reads the live endpoint and checks the invariant the UI depends
 * on — model + fee + unitemised adds up to the Total — so a stubbed payload
 * cannot hide a server that stopped sending the fields.
 *
 * Needs the local stack (`E2E_LOCAL_START_STACK=1` starts it).
 */
import { expect, test, type Page } from "@playwright/test"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

interface SplitTotals {
  totalSpendUsd: number
  modelCostUsd: number
  shogoFeeUsd: number
  unitemizedUsd: number
  shogoFeePercent?: number
}

/** A cloud workspace: billed is the provider price plus the 20% Shogo fee. */
const CLOUD: SplitTotals = {
  totalSpendUsd: 3.2,
  modelCostUsd: 2.0,
  shogoFeeUsd: 0.2,
  unitemizedUsd: 1.0,
  shogoFeePercent: 20,
}

/** A desktop workspace: nothing is billed, the provider cost is in `rawUsd`. */
const DESKTOP: SplitTotals = {
  totalSpendUsd: 2.0,
  modelCostUsd: 2.0,
  shogoFeeUsd: 0,
  unitemizedUsd: 0,
  shogoFeePercent: 20,
}

const CLOUD_MODEL = "anthropic/claude-sonnet-4-5"
const DESKTOP_MODEL = "ollama/qwen3-coder"

/** One user × model row, shaped exactly like `getUsageSummary` returns it. */
function summaryRow(model: string, totals: SplitTotals) {
  return {
    userId: "qa-sho288-user",
    userName: "QA",
    userEmail: "qa@shogo.ai",
    userImage: null,
    model,
    provider: model.startsWith("ollama") ? "ollama" : "anthropic",
    requestCount: 2,
    totalInputTokens: 1000,
    totalOutputTokens: 200,
    totalTokens: 1200,
    totalBilledUsd: totals.totalSpendUsd,
    totalRawUsd: totals.modelCostUsd,
    modelCostUsd: totals.modelCostUsd,
    shogoFeeUsd: totals.shogoFeeUsd,
    unitemizedUsd: totals.unitemizedUsd,
    avgDurationMs: 400,
    unpricedRequests: 0,
  }
}

/** One request row, shaped exactly like `getUsageLog` returns it. */
function logEntry(id: string, model: string, totals: Omit<SplitTotals, "totalSpendUsd" | "shogoFeePercent">, total: number) {
  return {
    id,
    userId: "qa-sho288-user",
    userName: "QA",
    userEmail: "qa@shogo.ai",
    userImage: null,
    model,
    provider: model.startsWith("ollama") ? "ollama" : "anthropic",
    inputTokens: 500,
    outputTokens: 100,
    totalTokens: 600,
    billedUsd: total,
    rawUsd: totals.modelCostUsd,
    modelCostUsd: totals.modelCostUsd,
    shogoFeeUsd: totals.shogoFeeUsd,
    unitemizedUsd: totals.unitemizedUsd,
    durationMs: 250,
    success: true,
    createdAt: "2026-11-02T12:00:00.000Z",
  }
}

/** The `/analytics/dashboard` body: the whole Usage tab in one request. */
function dashboardPayload(totals: SplitTotals, model: string) {
  return {
    ok: true,
    data: {
      window: { from: "2026-10-04", to: "2026-11-02", period: "30d" },
      summary: {
        summaries: [summaryRow(model, totals)],
        totals: {
          totalRequests: 2,
          totalInputTokens: 1000,
          totalOutputTokens: 200,
          totalTokens: 1200,
          totalBilledUsd: totals.totalSpendUsd,
          totalRawUsd: totals.modelCostUsd,
          modelCostUsd: totals.modelCostUsd,
          shogoFeeUsd: totals.shogoFeeUsd,
          unitemizedUsd: totals.unitemizedUsd,
          shogoFeePercent: totals.shogoFeePercent,
          unpricedRequests: 0,
          totalToolCalls: 0,
          uniqueUsers: 1,
          uniqueModels: 1,
        },
        total: 1,
        page: 1,
        limit: 50,
      },
      timeseries: {
        days: [],
        totals: { ...totals, uniqueModels: 1 },
        models: [model],
        groupBy: "model",
        metric: "spend",
      },
      usage: null,
      logCount: 1,
      chat: null,
    },
  }
}

let page: Page
let workspaceId: string

/** Opens the workspace Analytics screen the way a person does — the More tab. */
async function openUsageTab(target: Page) {
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

/** Point both Usage-tab requests at a fixture, so the numbers are exact. */
async function stubUsageTab(target: Page, totals: SplitTotals, model: string) {
  await target.unroute(/\/api\/workspaces\/[^/]+\/analytics\/dashboard/).catch(() => {})
  await target.unroute(/\/api\/workspaces\/[^/]+\/analytics\/usage-log/).catch(() => {})
  await target.route(/\/api\/workspaces\/[^/]+\/analytics\/dashboard/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(dashboardPayload(totals, model)),
    }),
  )
  const entry =
    model === DESKTOP_MODEL
      ? logEntry("qa-sho288-desktop", model, { modelCostUsd: 1, shogoFeeUsd: 0, unitemizedUsd: 0 }, 1)
      : logEntry("qa-sho288-cloud", model, { modelCostUsd: 1, shogoFeeUsd: 0.2, unitemizedUsd: 0 }, 1.2)
  await target.route(/\/api\/workspaces\/[^/]+\/analytics\/usage-log/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { entries: [entry], total: 1, page: 1, limit: 50 } }),
    }),
  )
}

test.describe("Analytics usage spend split", () => {
  test.describe.configure({ mode: "serial" })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    await signIn(page)
    workspaceId = await teamWorkspaceId(page)
    await activateTeamWorkspace(page, workspaceId)
  })

  test.afterAll(async () => {
    await page.context().close()
  })

  test("a cloud workspace shows Model cost + Shogo fee under the Total, and they add up", async () => {
    await stubUsageTab(page, CLOUD, CLOUD_MODEL)
    await openUsageTab(page)

    const spend = page.getByTestId("usage-section-spend")
    // The Total is the same number as before this card — only the breakdown is new.
    await expect(spend).toContainText("$3.20", { timeout: 30_000 })
    // 2.00 model + 0.20 fee + 1.00 from before itemised billing = 3.20.
    await expect(spend).toContainText("Model $2.00 · Shogo fee $0.20 (20%)")
    // A billed row with no provider cost is not guessed at; it says so.
    await expect(spend).toContainText("$1.00 before itemized billing (Apr 24 2026)")

    // The same two lines on the per-user × model row and on the request row.
    const usage = page.getByTestId("usage-section-usage")
    await expect(usage).toContainText("Model $2.00 · Shogo fee $0.20", { timeout: 30_000 })
    // The request log is its own view of the same section.
    await usage.getByText("Event Log", { exact: true }).click()
    await expect(usage).toContainText("Model $1.00 · Shogo fee $0.20", { timeout: 30_000 })
  })

  test("a desktop workspace shows the same two lines with a $0.00 fee", async () => {
    await stubUsageTab(page, DESKTOP, DESKTOP_MODEL)
    await openUsageTab(page)

    const spend = page.getByTestId("usage-section-spend")
    await expect(spend).toContainText("$2.00", { timeout: 30_000 })
    // Nothing is billed on desktop, so the whole spend is the provider's price.
    await expect(spend).toContainText("Model $2.00 · Shogo fee $0.00 (20%)")
    // And no pre-itemised note, because nothing is unitemised.
    await expect(spend).not.toContainText("before itemized billing")

    const usage = page.getByTestId("usage-section-usage")
    await usage.getByText("Event Log", { exact: true }).click({ timeout: 30_000 })
    await expect(usage).toContainText("Model $1.00 · Shogo fee $0.00", { timeout: 30_000 })
  })

  test("the live endpoint's split adds up to the Total it reports", async () => {
    const res = await api(page, "GET", `/api/workspaces/${workspaceId}/analytics/dashboard?period=30d`)
    expect(res.status).toBe(200)

    const totals = res.json?.data?.timeseries?.totals
    expect(typeof totals?.modelCostUsd).toBe("number")
    expect(typeof totals?.shogoFeeUsd).toBe("number")
    expect(typeof totals?.unitemizedUsd).toBe("number")
    expect(typeof totals?.shogoFeePercent).toBe("number")
    // model + fee + unitemised is the Total the user already saw — never a new number.
    expect(
      totals.modelCostUsd + totals.shogoFeeUsd + totals.unitemizedUsd,
    ).toBeCloseTo(totals.totalSpendUsd, 6)
    // The fee is derived from MARKUP_MULTIPLIER, so the UI never hard-codes 20.
    expect(totals.shogoFeePercent).toBe(20)
  })
})
