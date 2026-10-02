// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop navigation: the icon rail (Home, Channels, DMs, Agents, Projects,
 * Activity, More) and the list panel beside it, the profile and "+" menus, and
 * the personal workspace's own tab set. The phone layout is covered by
 * team-nav-tabs-phone.test.ts.
 *
 * Needs the local stack with scripted agents (SHOGO_CHANNEL_AGENT_SCRIPT); see
 * team-chat-agents.test.ts. `E2E_LOCAL_START_STACK=1` sets both up.
 */
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { activateTeamWorkspace, api, cleanupTeamNav, seedTeamNav, signIn, type TeamNavSeed } from "./team-nav-seed"

const rail = (page: Page) => page.getByRole("navigation", { name: "Workspace tabs" })
const tab = (page: Page, name: string) => rail(page).getByRole("tab", { name: new RegExp(`^${name}`) })
const panel = (page: Page, testId: string) => page.getByTestId(testId)

test.describe("Team workspace: desktop rail and panels", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 1440, height: 900 } })

  let page: Page
  let seed: TeamNavSeed

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    await signIn(page)
    seed = await seedTeamNav(page)
    await activateTeamWorkspace(page, seed.workspaceId)
    await page.goto("/")
    await expect(rail(page)).toBeVisible({ timeout: 60_000 })
  })

  test.afterAll(async () => {
    await api(page, "PUT", `/api/workspaces/${seed.workspaceId}/chat-settings`, { dndUntil: null }).catch(() => {})
    await cleanupTeamNav(page, seed)
    await page.context().close()
  })

  test("the rail offers every team tab, starts on Home, and badges the unread DM", async () => {
    for (const name of ["Home", "Channels", "DMs", "Agents", "Projects", "Activity", "More"]) {
      await expect(tab(page, name)).toBeVisible()
    }
    await expect(tab(page, "Home")).toHaveAttribute("aria-selected", "true")
    // The scripted agent answered the seeded DM while nobody was looking.
    await expect(rail(page).getByRole("tab", { name: /^DMs, \d+ unread$/ })).toBeVisible({ timeout: 30_000 })
    await expect(panel(page, "home-panel").getByText("Workspace agent")).toBeVisible()
  })

  test("each tab swaps the panel to its own list", async () => {
    await tab(page, "Channels").click()
    await expect(page.getByRole("link", { name: seed.channelName })).toBeVisible()

    await tab(page, "DMs").click()
    await expect(panel(page, "dms-panel")).toBeVisible()
    await expect(page.getByRole("link", { name: new RegExp(`^${seed.dmAgent}`) })).toBeVisible()
    await expect(page.getByRole("button", { name: "Unreads", exact: true })).toBeVisible()

    await tab(page, "Agents").click()
    await expect(page.getByRole("button", { name: `Message ${seed.dmAgent}` })).toBeVisible()
    await expect(page.getByRole("button", { name: `Message ${seed.idleAgent}` })).toBeVisible()

    await tab(page, "Projects").click()
    await expect(page.getByText(seed.idleAgent).first()).toBeVisible()

    await tab(page, "Activity").click()
    for (const chip of ["All", "Agents", "DMs", "Mentions", "Threads"]) {
      await expect(page.getByRole("button", { name: chip, exact: true })).toBeVisible()
    }

    await tab(page, "More").click()
    await expect(panel(page, "more-panel").getByRole("link", { name: "Tasks" })).toBeVisible()
  })

  test("DM filters separate people from agents", async () => {
    await tab(page, "DMs").click()
    const agentRow = page.getByRole("link", { name: new RegExp(`^${seed.dmAgent}`) })
    await page.getByRole("button", { name: "Agents", exact: true }).click()
    await expect(agentRow).toBeVisible()
    await page.getByRole("button", { name: "People", exact: true }).click()
    await expect(agentRow).toHaveCount(0)
    await page.getByRole("button", { name: "All", exact: true }).click()
    await expect(agentRow).toBeVisible()
  })

  test("selecting the active tab again hides the panel and shows it again", async () => {
    await tab(page, "Agents").click()
    await expect(page.getByRole("button", { name: `Message ${seed.idleAgent}` })).toBeVisible()
    await tab(page, "Agents").click()
    await expect(page.getByRole("button", { name: `Message ${seed.idleAgent}` })).toHaveCount(0)
    await expect(rail(page)).toBeVisible()
    await tab(page, "Agents").click()
    await expect(page.getByRole("button", { name: `Message ${seed.idleAgent}` })).toBeVisible()
  })

  test("opening a conversation selects its tab, and the tab follows the route on reload", async () => {
    await tab(page, "Channels").click()
    await page.getByRole("link", { name: seed.channelName }).click()
    await expect(page).toHaveURL(new RegExp(`/c/${seed.channelId}`))
    await expect(tab(page, "Channels")).toHaveAttribute("aria-selected", "true")

    await page.goto(`/c/${seed.dmId}`)
    await expect(tab(page, "DMs")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 })
    await expect(page.getByText(seed.dmReply, { exact: false }).first()).toBeVisible({ timeout: 30_000 })

    await page.goto(`/c/${seed.channelId}`)
    await expect(tab(page, "Channels")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 })
  })

  test("reading the DM clears its unread mark", async () => {
    await page.goto(`/c/${seed.dmId}`)
    await expect(page.getByText(seed.dmReply, { exact: false }).first()).toBeVisible({ timeout: 30_000 })
    // The DMs tab is already active (route sync), so its panel is open; clicking would collapse it.
    await expect(tab(page, "DMs")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 })
    await expect(page.getByRole("link", { name: new RegExp(`^${seed.dmAgent}$`) })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("link", { name: `${seed.dmAgent}, unread` })).toHaveCount(0)
  })

  test("the Agents tab messages an agent and opens its profile", async () => {
    await tab(page, "Agents").click()
    await page.getByRole("button", { name: `Message ${seed.idleAgent}` }).click()
    await expect(page).toHaveURL(/\/c\/[^/?]+/, { timeout: 30_000 })
    await expect(tab(page, "DMs")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 })

    await tab(page, "Agents").click()
    await page.getByRole("button", { name: `${seed.dmAgent} profile` }).click()
    await expect(page.getByText(seed.dmAgent).last()).toBeVisible()
  })

  test("the profile menu holds status, pausing notifications and settings", async () => {
    await page.goto("/")
    await expect(rail(page)).toBeVisible({ timeout: 30_000 })
    await page.getByTestId("profile-avatar").click()
    const menu = page.getByTestId("profile-menu")
    await expect(menu).toBeVisible()
    await expect(menu.getByText("Local User")).toBeVisible()
    await expect(menu.getByRole("menuitem", { name: "What's your status?" })).toBeVisible()

    await menu.getByRole("menuitem", { name: "Pause notifications" }).click()
    await menu.getByRole("menuitem", { name: "Pause for 1 hour" }).click()
    if (!(await menu.isVisible())) await page.getByTestId("profile-avatar").click()
    await expect(page.getByRole("menuitem", { name: "Notifications paused" })).toBeVisible({ timeout: 15_000 })
    await page.getByRole("menuitem", { name: "Notifications paused" }).click()
    await page.getByRole("menuitem", { name: "Resume notifications" }).click()
    await expect(page.getByRole("menuitem", { name: "Pause notifications" })).toBeVisible({ timeout: 15_000 })

    await page.getByRole("menuitem", { name: "Preferences" }).click()
    await expect(page).toHaveURL(/\/settings/)
  })

  test("the + menu leads with agents and can start a channel", async () => {
    await page.goto("/")
    await expect(rail(page)).toBeVisible({ timeout: 30_000 })
    await rail(page).getByRole("button", { name: "Create", exact: true }).click()
    const items = page.getByTestId("create-menu").getByRole("menuitem")
    await expect(items.first()).toHaveAccessibleName("Ask an agent")
    await expect(items).toHaveText([/Ask an agent/, /Start a task/, /New project/, /New message/, /Create channel/])

    await page.getByRole("menuitem", { name: "Create channel" }).click()
    await expect(page.getByText("Create a channel")).toBeVisible()
    await page.getByLabel("Close", { exact: true }).click()

    await rail(page).getByRole("button", { name: "Create", exact: true }).click()
    await page.getByRole("menuitem", { name: "Ask an agent" }).click()
    await expect(page).toHaveURL(/\/agent/)
  })

  test("the API lists the DM's newest message for previews", async () => {
    const list = await api(page, "GET", `/api/workspaces/${seed.workspaceId}/conversations`)
    const dm = (list.json?.conversations ?? list.json?.items ?? []).find((c: any) => c.id === seed.dmId)
    expect(dm?.lastMessage?.preview).toContain("flaky checkout tests")
  })
})

test.describe("Personal workspace: its own tab set", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("shows Home, Meetings, Goals, Activity and More, and no chat tabs", async ({ page }) => {
    await signIn(page)
    await page.goto("/")
    await expect(rail(page)).toBeVisible({ timeout: 60_000 })
    for (const name of ["Home", "Meetings", "Goals", "Activity", "More"]) {
      await expect(tab(page, name)).toBeVisible()
    }
    for (const name of ["Channels", "DMs", "Agents", "Projects"]) {
      await expect(tab(page, name)).toHaveCount(0)
    }
    await tab(page, "Meetings").click()
    await expect(page).toHaveURL(/\/meetings/)
    await tab(page, "Activity").click()
    await expect(page).toHaveURL(/\/activity/)
  })
})
