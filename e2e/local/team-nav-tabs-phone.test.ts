// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phone navigation in a team workspace: the floating dock (Home, DMs, Activity,
 * More) with its search button, the tab screens with the profile avatar and the
 * floating "+", and agent activity in the Activity tab. The desktop rail is
 * covered by team-nav-tabs.test.ts.
 *
 * Runs in the `iphone-15-pro` and `pixel-7` projects (see playwright.config.ts).
 */
import { expect, test, type Page } from "@playwright/test"
import { activateTeamWorkspace, cleanupTeamNav, seedTeamNav, signIn, type TeamNavSeed } from "./team-nav-seed"

const dock = (page: Page) => page.getByTestId("team-dock")
const tab = (page: Page, name: string) => dock(page).getByRole("tab", { name: new RegExp(`^${name}`) })

test.describe("Team workspace: phone dock and tab screens", () => {
  test.describe.configure({ mode: "serial" })

  let seed: TeamNavSeed
  let seeder: Page

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    // Seeding only needs an authenticated API client; the tests use the project's phone page.
    const context = await browser.newContext()
    seeder = await context.newPage()
    await signIn(seeder)
    seed = await seedTeamNav(seeder)
  })

  test.afterAll(async () => {
    await cleanupTeamNav(seeder, seed)
    await seeder.context().close()
  })

  test.beforeEach(async ({ page }) => {
    await signIn(page)
    await activateTeamWorkspace(page, seed.workspaceId)
    await page.goto("/")
    await expect(dock(page)).toBeVisible({ timeout: 60_000 })
  })

  test("the dock has Home, DMs, Activity and More beside a search button, and no desktop rail", async ({ page }) => {
    for (const name of ["Home", "DMs", "Activity", "More"]) {
      await expect(tab(page, name)).toBeVisible()
    }
    await expect(dock(page).getByRole("button", { name: "Search" })).toBeVisible()
    await expect(page.getByRole("navigation", { name: "Workspace tabs" })).toHaveCount(0)
    await expect(tab(page, "Home")).toHaveAttribute("aria-selected", "true")
    // The scripted agent replied to the seeded DM while nobody was looking.
    await expect(dock(page).getByRole("tab", { name: /^DMs, \d+ unread$/ })).toBeVisible({ timeout: 30_000 })
  })

  test("Home is a feed with the workspace agent, not a settings list", async ({ page }) => {
    const feed = page.getByTestId("mobile-home-feed")
    await expect(feed).toBeVisible()
    await expect(feed.getByRole("button", { name: "Ask the workspace agent" })).toBeVisible()
    await expect(feed.getByRole("button", { name: /switch workspace$/ })).toBeVisible()
  })

  test("DMs lists conversations with the latest message and opens one", async ({ page }) => {
    await tab(page, "DMs").click()
    await expect(page).toHaveURL(/\/c\/dms/)
    await expect(page.getByTestId("dms-screen")).toBeVisible()
    await expect(tab(page, "DMs")).toHaveAttribute("aria-selected", "true")

    const row = page.getByTestId("dms-screen").getByRole("link", { name: new RegExp(`^${seed.dmAgent}`) })
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toContainText("flaky checkout tests")

    await row.click()
    await expect(page).toHaveURL(new RegExp(`/c/${seed.dmId}`))
    await expect(page.getByText(seed.dmReply, { exact: false }).first()).toBeVisible({ timeout: 30_000 })
    // The dock stays put while reading, with DMs still the selected tab.
    await expect(tab(page, "DMs")).toHaveAttribute("aria-selected", "true")
  })

  test("Activity gathers messages and agent work under one set of filters", async ({ page }) => {
    await tab(page, "Activity").click()
    await expect(page).toHaveURL(/\/activity/)
    await expect(tab(page, "Activity")).toHaveAttribute("aria-selected", "true")

    const feed = page.getByTestId("activity-tab")
    const filters = ["All", "Agents", "DMs", "Mentions", "Threads"]
    for (const name of filters) {
      await expect(feed.getByRole("button", { name, exact: true })).toBeVisible()
    }
    await expect(feed.getByRole("button", { name: "Unreads only" })).toBeVisible()

    // Routine agent replies stay out of the inbox (they show as DM unreads instead),
    // so the filters are checked by their state rather than by a specific entry.
    for (const name of ["Agents", "DMs"]) {
      await feed.getByRole("button", { name, exact: true }).click()
      await expect(feed.getByRole("button", { name, exact: true })).toHaveAttribute("aria-selected", "true")
      await expect(feed.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-selected", "false")
    }
    await feed.getByRole("button", { name: "Unreads only" }).click()
    await expect(feed.getByRole("button", { name: "Unreads only" })).toHaveAttribute("aria-selected", "true")
  })

  test("More holds only the places without a tab", async ({ page }) => {
    await tab(page, "More").click()
    await expect(page).toHaveURL(/\/more/)
    const more = page.getByTestId("more-screen")
    await expect(more).toBeVisible()
    await expect(more.getByText("Tasks", { exact: true })).toBeVisible()
    // Settings live behind the profile avatar, not in More.
    await expect(more.getByText("Settings", { exact: true })).toHaveCount(0)
    await more.getByText("Tasks", { exact: true }).click()
    await expect(page).toHaveURL(/\/tasks/)
  })

  test("settings sit behind the profile avatar", async ({ page }) => {
    await tab(page, "DMs").click()
    await page.getByTestId("profile-avatar").click()
    const menu = page.getByTestId("profile-menu")
    await expect(menu).toBeVisible()
    await expect(menu.getByRole("menuitem", { name: "Pause notifications" })).toBeVisible()
    await menu.getByRole("menuitem", { name: "Preferences" }).click()
    await expect(page).toHaveURL(/\/settings/)
  })

  test("the floating + leads with agents", async ({ page }) => {
    await tab(page, "DMs").click()
    await page.getByRole("button", { name: "Create", exact: true }).click()
    const items = page.getByTestId("create-menu").getByRole("menuitem")
    await expect(items.first()).toHaveAccessibleName("Ask an agent")
    await items.first().click()
    await expect(page).toHaveURL(/\/agent/)
  })
})
