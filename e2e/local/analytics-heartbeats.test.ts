// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace Analytics → Heartbeats: the per-agent heartbeat report and the new
 * tab. Enables a heartbeat on a fresh project, checks the endpoint lists it with
 * its schedule and edit permission, then renders the tab on desktop and on a
 * ~390px phone.
 *
 * The money path is seeded straight into the stack's SQLite file — the same
 * trick `heartbeat-local-tick.test.ts` uses to force a due tick, because a
 * billed tick needs the fake-LLM stack. One heartbeat charge and one ordinary
 * chat charge go in, so the tab has to show the agent's spend *and* its share of
 * the workspace's spend (25% of $5.00), which is the number the card is about.
 *
 * Needs the local stack (`E2E_LOCAL_START_STACK=1` starts it). Set
 * `E2E_LOCAL_DB` when running against a stack you started yourself.
 */
import { expect, test, type Page } from "@playwright/test"
import { existsSync } from "fs"
import { randomUUID } from "crypto"
import { resolve } from "path"
import { DatabaseSync } from "node:sqlite"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

const REPO_ROOT = resolve(__dirname, "../..")

/** The stack's SQLite file: `E2E_LOCAL_START_STACK` boots the API against it. */
function localDbPath(): string | null {
  if (process.env.E2E_LOCAL_DB) return process.env.E2E_LOCAL_DB
  const bundled = resolve(REPO_ROOT, "test-results/e2e-local.db")
  if (process.env.E2E_LOCAL_START_STACK === "1") return bundled
  const fromEnv = process.env.DATABASE_URL
  if (fromEnv?.startsWith("file:")) return fromEnv.slice("file:".length)
  return existsSync(bundled) ? bundled : null
}

const DB_PATH = localDbPath()

/** Prisma writes SQLite DateTime as ISO text with a `+00:00` offset. */
const prismaDate = (date: Date) => date.toISOString().replace("Z", "+00:00")

const HEARTBEAT_SPEND = 1.25
const OTHER_SPEND = 3.75

const suffix = Date.now().toString(36)
const agentName = `hb-report-${suffix}`

let page: Page
let workspaceId: string
let projectId: string
let memberId: string
let db: DatabaseSync | null = null
const seededEventIds: string[] = []

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
    memberId = session?.user?.id
    const created = await api(page, "POST", "/api/projects", {
      name: agentName,
      workspaceId,
      createdBy: memberId,
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

    if (DB_PATH) db = new DatabaseSync(DB_PATH, { readOnly: false })
    // A usage event must name the member it charged. The session is the normal
    // source; the local DB knows the workspace's own member either way.
    if (!memberId && db) {
      const row = db
        .prepare("SELECT userId FROM members WHERE workspaceId = ? AND projectId IS NULL LIMIT 1")
        .get(workspaceId) as { userId?: string } | undefined
      memberId = row?.userId ?? ""
    }
  })

  test.afterAll(async () => {
    // Do not leave a 15-minute schedule running behind the rest of the suite.
    await api(page, "PATCH", `/api/projects/${projectId}/heartbeat`, { heartbeatEnabled: false }).catch(() => {})
    // Nor the charges this spec invented.
    if (db) {
      for (const id of seededEventIds) db.prepare("DELETE FROM usage_events WHERE id = ?").run(id)
      db.close()
      db = null
    }
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

  test("a seeded heartbeat charge shows its spend and its share of workspace spend", async () => {
    test.skip(!db || !memberId, "no local SQLite database to seed a heartbeat charge in (set E2E_LOCAL_DB)")

    // One heartbeat tick and one ordinary chat, both charged by the same
    // project, so the share is a number a person can check by hand:
    // 1.25 / 5.00 = 25%.
    const charge = (sessionId: string, billedUsd: number) => {
      const id = randomUUID()
      db!.prepare(
        `INSERT INTO usage_events
           (id, workspaceId, projectId, memberId, actionType, actionMetadata, rawUsd, billedUsd, source, balanceBefore, balanceAfter, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, workspaceId, projectId, memberId, "chat_message",
        JSON.stringify({ chatSessionId: sessionId, model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 200 }),
        null, billedUsd, "daily", 0, 0, prismaDate(new Date()),
      )
      seededEventIds.push(id)
    }
    charge("heartbeat", HEARTBEAT_SPEND)
    charge("cs_not_a_heartbeat", OTHER_SPEND)

    const res = await api(page, "GET", `/api/workspaces/${workspaceId}/analytics/heartbeats?period=24h`)
    expect(res.status).toBe(200)

    const row = ((res.json?.data?.agents ?? []) as any[]).find((r) => r.projectId === projectId)
    expect(row.billedUsd).toBeCloseTo(HEARTBEAT_SPEND, 6)
    expect(row.ticks).toBe(1)
    expect(row.avgUsdPerTick).toBeCloseTo(HEARTBEAT_SPEND, 6)
    // The ordinary chat is in the denominator, not in the heartbeat column. The
    // rest of the suite shares this database, so the totals are a floor and the
    // share the UI must show is computed from what the API actually returned.
    const totals = res.json.data.totals
    expect(totals.billedUsd).toBeGreaterThanOrEqual(HEARTBEAT_SPEND)
    expect(totals.workspaceBilledUsd).toBeGreaterThanOrEqual(HEARTBEAT_SPEND + OTHER_SPEND)
    const share = `${Math.round((totals.billedUsd / totals.workspaceBilledUsd) * 100)}%`

    await openAnalytics(page)
    const tab = page.getByTestId("analytics-view-heartbeats")
    await expect(tab).toBeVisible({ timeout: 60_000 })
    await tab.click()

    const table = page.getByTestId("heartbeats-table")
    await expect(table.getByText("$1.25").first()).toBeVisible({ timeout: 30_000 })
    // The card's whole point: the team can see what fraction of the bill it is.
    await expect(page.getByText(share).first()).toBeVisible()
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
