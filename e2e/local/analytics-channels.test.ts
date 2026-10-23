// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace Analytics → Channels: the per-channel breakdown endpoint and the
 * new tab. Seeds two channels (one busy, one quiet), checks the endpoint
 * counts for a 7-day window, then renders the tab on desktop and on a
 * ~390px phone.
 *
 * Needs the local stack (`E2E_LOCAL_START_STACK=1` starts it).
 */
import { expect, test, type Page } from "@playwright/test"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

const suffix = Date.now().toString(36)
const busyName = `analytics-busy-${suffix}`
const quietName = `analytics-quiet-${suffix}`

let page: Page
let workspaceId: string
let busyChannelId: string
let quietChannelId: string

async function createChannel(name: string) {
  const res = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, { name, kind: "public" })
  const id = res.json?.conversation?.id ?? res.json?.data?.id
  if (!id) throw new Error(`channel create failed: ${JSON.stringify(res.json)}`)
  return id as string
}

/**
 * Opens the workspace Analytics screen the way a person does — the More tab,
 * then its Analytics entry. A direct `/analytics` load is not the app screen:
 * the admin console owns that URL for a super_admin, and the workspace screen
 * is only reached through the `(app)` route group.
 */
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

test.describe("Analytics channels", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 1440, height: 900 } })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    await signIn(page)
    workspaceId = await teamWorkspaceId(page)
    await activateTeamWorkspace(page, workspaceId)

    busyChannelId = await createChannel(busyName)
    quietChannelId = await createChannel(quietName)
    for (const text of ["first post", "second post"]) {
      const sent = await api(page, "POST", `/api/conversations/${busyChannelId}/messages`, {
        text,
        clientMsgId: crypto.randomUUID(),
      })
      expect(sent.status).toBeLessThan(400)
    }
  })

  test.afterAll(async () => {
    await api(page, "PATCH", `/api/conversations/${busyChannelId}`, { archived: true }).catch(() => {})
    await api(page, "PATCH", `/api/conversations/${quietChannelId}`, { archived: true }).catch(() => {})
    await page.context().close()
  })

  test("the endpoint reports per-channel counts and workspace totals", async () => {
    const res = await api(page, "GET", `/api/workspaces/${workspaceId}/analytics/channels?period=7d`)
    expect(res.status).toBe(200)
    expect(res.json?.data?.period).toBe("7d")

    const rows = (res.json?.data?.channels ?? []) as any[]
    const busy = rows.find((r) => r.conversationId === busyChannelId)
    const quiet = rows.find((r) => r.conversationId === quietChannelId)

    expect(busy).toBeTruthy()
    expect(quiet).toBeTruthy()
    expect(busy.name).toBe(busyName)
    // Native channel, two human posts this week, one active member.
    expect(busy.provider).toBe("shogo")
    expect(busy.bridged).toBe(false)
    expect(busy.humanMessages).toBe(2)
    expect(busy.agentMessages).toBe(0)
    expect(busy.messages).toBeGreaterThanOrEqual(2)
    expect(busy.activeMembers).toBe(1)
    // The quiet channel is listed but empty for the period.
    expect(quiet.messages).toBe(0)
    expect(quiet.activeMembers).toBe(0)
    // DMs are never part of the breakdown, and totals count the channels we listed.
    expect(rows.some((r) => r.kind === "dm")).toBe(false)
    expect(res.json.data.totals.channels).toBe(rows.length)
  })

  test("the Channels tab renders the table on desktop", async () => {
    await openAnalytics(page)
    const tab = page.getByTestId("analytics-view-channels")
    await expect(tab).toBeVisible({ timeout: 60_000 })
    await tab.click()
    await expect(tab).toHaveAttribute("aria-selected", "true")

    await expect(page.getByText(busyName).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(quietName).first()).toBeVisible()
    await expect(page.getByText("Workspace total", { exact: false })).toBeVisible()
    await expect(page.getByText("Active members")).toBeVisible()
  })

  test("the table still works on a ~390px phone", async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openAnalytics(page)

    const tab = page.getByTestId("analytics-view-channels")
    await expect(tab).toBeVisible({ timeout: 60_000 })
    await tab.click()
    // Labels stay readable rather than truncated, and the table scrolls sideways.
    await expect(page.getByText(busyName).first()).toBeVisible({ timeout: 30_000 })
    const scroller = page.locator('[data-testid="channels-table"]').first()
    const scrollable = await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(scrollable).toBe(true)
  })
})
