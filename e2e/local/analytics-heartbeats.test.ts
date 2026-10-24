// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace Analytics → Heartbeats: the per-agent heartbeat report and the new
 * tab. Enables a heartbeat on a fresh project, checks the endpoint lists it with
 * its schedule and edit permission, then renders the tab on desktop and on a
 * ~390px phone.
 *
 * Spend is not seeded here — a billed tick needs the fake-LLM stack
 * (`heartbeat-local-tick.test.ts` covers that path). What this asserts is the
 * report's contract: which agents are on, on what schedule, at what interval,
 * and that they can be switched off from the tab.
 *
 * Needs the local stack (`E2E_LOCAL_START_STACK=1` starts it).
 */
import { expect, test, type Page } from "@playwright/test"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

const suffix = Date.now().toString(36)
const agentName = `hb-report-${suffix}`

let page: Page
let workspaceId: string
let projectId: string

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
}

test.describe("Analytics heartbeats", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 1440, height: 900 } })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    await signIn(page)
    workspaceId = await teamWorkspaceId(page)
    await activateTeamWorkspace(page, workspaceId)

    const session = await (await page.request.get("/api/auth/get-session")).json().catch(() => null)
    const created = await api(page, "POST", "/api/projects", {
      name: agentName,
      workspaceId,
      createdBy: session?.user?.id,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
      schemas: [],
    })
    projectId = created.json?.data?.id ?? created.json?.id
    if (!projectId) throw new Error(`project create failed: ${JSON.stringify(created.json)}`)

    const enabled = await api(page, "PATCH", `/api/projects/${projectId}/heartbeat`, {
      heartbeatEnabled: true,
      heartbeatInterval: 900,
    })
    expect(enabled.status).toBeLessThan(400)
    expect(enabled.json?.heartbeatEnabled).toBe(true)
  })

  test.afterAll(async () => {
    // Do not leave a 15-minute schedule running behind the rest of the suite.
    await api(page, "PATCH", `/api/projects/${projectId}/heartbeat`, { heartbeatEnabled: false }).catch(() => {})
    await page.context().close()
  })

  test("the endpoint reports the agent's schedule and that it may be turned off", async () => {
    const res = await api(page, "GET", `/api/workspaces/${workspaceId}/analytics/heartbeats?period=24h`)
    expect(res.status).toBe(200)
    expect(res.json?.data?.period).toBe("24h")

    const rows = (res.json?.data?.agents ?? []) as any[]
    const row = rows.find((r) => r.projectId === projectId)
    expect(row).toBeTruthy()
    expect(row.projectName).toBe(agentName)
    expect(row.enabled).toBe(true)
    expect(row.intervalSeconds).toBe(900)
    // The owner is the person who created it, and they may switch it off.
    expect(row.canEdit).toBe(true)
    expect(row.nextHeartbeatAt).toBeTruthy()
    // Nothing has ticked yet in this window: zeros, not nulls.
    expect(row.ticks).toBe(0)
    expect(row.billedUsd).toBe(0)
    expect(row.avgUsdPerTick).toBeNull()

    const totals = res.json.data.totals
    expect(totals.agentsEnabled).toBeGreaterThanOrEqual(1)
    expect(typeof totals.workspaceBilledUsd).toBe("number")
    expect(Array.isArray(res.json.data.daily)).toBe(true)
  })

  test("a window with no heartbeat ticks still zero-fills every day", async () => {
    const res = await api(page, "GET", `/api/workspaces/${workspaceId}/analytics/heartbeats?period=7d`)
    expect(res.status).toBe(200)
    // A 7-day window spans 8 calendar days; every one is present and zero.
    expect(res.json.data.daily.length).toBeGreaterThanOrEqual(7)
    expect(res.json.data.daily.every((d: any) => d.heartbeatUsd === 0 && d.otherUsd === 0)).toBe(true)
  })

  test("turning the heartbeat off takes it out of the report", async () => {
    const off = await api(page, "PATCH", `/api/projects/${projectId}/heartbeat`, { heartbeatEnabled: false })
    expect(off.status).toBeLessThan(400)

    const res = await api(page, "GET", `/api/workspaces/${workspaceId}/analytics/heartbeats?period=24h`)
    const rows = (res.json?.data?.agents ?? []) as any[]
    // Off and never billed: nothing to show.
    expect(rows.some((r) => r.projectId === projectId)).toBe(false)

    const back = await api(page, "PATCH", `/api/projects/${projectId}/heartbeat`, { heartbeatEnabled: true })
    expect(back.status).toBeLessThan(400)
  })

  test("the Heartbeats tab renders the agent on desktop", async () => {
    await openAnalytics(page)
    const tab = page.getByTestId("analytics-view-heartbeats")
    await expect(tab).toBeVisible({ timeout: 60_000 })
    await tab.click()
    await expect(tab).toHaveAttribute("aria-selected", "true")

    await expect(page.getByText(agentName).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("every 15 min").first()).toBeVisible()
    await expect(page.getByText("Last tick")).toBeVisible()
    await expect(page.getByText(/Workspace total/).first()).toBeVisible()
    await expect(page.getByText("Turn off").first()).toBeVisible()
  })

  test("the tab still works on a ~390px phone", async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openAnalytics(page)

    const tab = page.getByTestId("analytics-view-heartbeats")
    await expect(tab).toBeVisible({ timeout: 60_000 })
    await tab.click()
    // The row stays readable and the table scrolls sideways instead of clipping.
    await expect(page.getByText(agentName).first()).toBeVisible({ timeout: 30_000 })
    const scroller = page.locator('[data-testid="heartbeats-table"]').first()
    const scrollable = await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(scrollable).toBe(true)
  })
})
