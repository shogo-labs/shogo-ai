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
    // `/` is the workspace agent chat since SHO-4; the feed lives at `/home`.
    await page.goto("/home")
    const feed = page.getByTestId("mobile-home-feed")
    await expect(feed).toBeVisible()
    await expect(feed.getByRole("button", { name: "Ask the workspace agent" })).toBeVisible()
    // The workspace avatar is the sidebar's only button (SHO-220): Home has no
    // hamburger, and the title is a title rather than a workspace switcher.
    await expect(feed.getByRole("button", { name: /open workspace sidebar$/ })).toBeVisible()
    await expect(feed.getByRole("button", { name: /switch workspace$/ })).toHaveCount(0)
  })

  test("the workspace avatar opens the sidebar, and the drawer closes again", async ({ page }) => {
    await page.goto("/home")
    const feed = page.getByTestId("mobile-home-feed")
    const avatar = feed.getByRole("button", { name: /open workspace sidebar$/ })
    await expect(avatar).toBeVisible({ timeout: 30_000 })
    await avatar.click()
    const sidebar = page.getByLabel("App sidebar")
    await expect(sidebar).toBeVisible({ timeout: 15_000 })
    await expect(sidebar.getByText("Channels", { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  })

  test("a project is a screen you go into: Back, not a hamburger", async ({ page }) => {
    await page.goto(`/projects/${seed.projectIds[1]}`)
    // SHO-220: a project header never opens the workspace sidebar; its leading
    // control pops back to Home, where the avatar is.
    const back = page.getByTestId("project-native-back")
    await expect(back).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId("project-native-sidebar")).toHaveCount(0)
    await back.click()
    await expect(page).not.toHaveURL(new RegExp(`/projects/${seed.projectIds[1]}`), { timeout: 30_000 })
  })

  test("tapping a project on Home opens the project", async ({ page }) => {
    await page.goto("/home")
    const feed = page.getByTestId("mobile-home-feed")
    const row = feed.getByRole("link", { name: seed.idleAgent, exact: true })
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.click()
    await expect(page).toHaveURL(new RegExp(`/projects/${seed.projectIds[1]}`), { timeout: 30_000 })
    await expect(page.getByTestId("mobile-home-feed")).toHaveCount(0)
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

  test("More holds the places without a tab, then Settings as its last row", async ({ page }) => {
    await tab(page, "More").click()
    await expect(page).toHaveURL(/\/more/)
    const more = page.getByTestId("more-screen")
    await expect(more).toBeVisible()
    await expect(more.getByText("Tasks", { exact: true })).toBeVisible()
    // SHO-7: the overflow screen names Settings, and it is always the last row.
    const rows = more.getByRole("link")
    await expect(rows.last()).toHaveAccessibleName("Settings")
    await expect(rows.last()).toContainText("Account, workspace, integrations and billing")
    await more.getByText("Tasks", { exact: true }).click()
    await expect(page).toHaveURL(/\/tasks/)
  })

  test("the Settings row in More opens the settings screen", async ({ page }) => {
    await tab(page, "More").click()
    const more = page.getByTestId("more-screen")
    await more.getByRole("link", { name: "Settings" }).click()
    await expect(page).toHaveURL(/\/settings/, { timeout: 30_000 })
    await expect(page.getByText("Settings", { exact: true }).last()).toBeVisible({ timeout: 30_000 })
  })

  test("settings also sit behind the profile avatar, under the name Settings", async ({ page }) => {
    await tab(page, "DMs").click()
    await page.getByTestId("profile-avatar").click()
    const menu = page.getByTestId("profile-menu")
    await expect(menu).toBeVisible()
    await expect(menu.getByRole("menuitem", { name: "Pause notifications" })).toBeVisible()
    await menu.getByRole("menuitem", { name: "Settings" }).click()
    await expect(page).toHaveURL(/\/settings/)
  })

  test("New message is a full screen with people and agents, not a dialog", async ({ page }) => {
    await tab(page, "DMs").click()
    await page.getByRole("button", { name: "Create", exact: true }).click()
    await page.getByRole("menuitem", { name: "New message" }).click()

    await expect(page).toHaveURL(/\/c\/new/)
    await expect(page.getByTestId("new-conversation-screen")).toBeVisible()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    // The dock steps aside so the picker (and keyboard) own the screen.
    await expect(dock(page)).toHaveCount(0)

    const picker = page.getByTestId("new-message-picker")
    await expect(picker.getByRole("button", { name: `${seed.idleAgent}, agent` })).toBeVisible({ timeout: 30_000 })
    // The local workspace has one member, so only the agents section is populated;
    // people rows are covered by new-message-picker.rtl.test.tsx.
    await expect(picker.getByRole("tab", { name: "People" })).toBeVisible()

    // An agent opens its DM straight away.
    await picker.getByRole("button", { name: `${seed.idleAgent}, agent` }).click()
    await expect(page).toHaveURL(/\/c\/(?!new)[^/]+/, { timeout: 30_000 })
    await expect(page.getByTestId("new-conversation-screen")).toHaveCount(0)
  })

  test("Message an agent from DMs opens the same screen on the agents list", async ({ page }) => {
    await tab(page, "DMs").click()
    await page.getByTestId("dms-screen").getByText("Message an agent", { exact: true }).click()
    await expect(page).toHaveURL(/\/c\/new\?mode=agent/)
    await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true")
    await expect(page.getByTestId("new-message-picker").getByRole("button", { name: `${seed.idleAgent}, agent` })).toBeVisible({ timeout: 30_000 })
  })

  test("a project has a Message agent button that opens the agent's DM", async ({ page }) => {
    await page.goto(`/projects/${seed.dmAgentProjectId}`)
    const message = page.getByTestId("project-message-agent").or(page.getByRole("button", { name: "Message agent" })).first()
    await expect(message).toBeVisible({ timeout: 60_000 })
    await message.click()
    await expect(page).toHaveURL(new RegExp(`/c/${seed.dmId}`), { timeout: 30_000 })
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

test.describe("Personal workspace: phone bottom bar and page titles", () => {
  const bar = (page: Page) => page.getByRole("tab")
  const selected = (page: Page) => page.locator('[role="tab"][aria-selected="true"]')

  test.beforeEach(async ({ page }) => {
    await signIn(page)
    await page.goto("/")
    await expect(bar(page).first()).toBeVisible({ timeout: 60_000 })
  })

  for (const [path, tab, title] of [
    ["/meetings", "Meetings", "Meetings"],
    ["/goals", "Goals", "Goals"],
    ["/activity", "Activity", "Activity"],
  ] as const) {
    test(`${tab}: the bar follows the page and the title appears once`, async ({ page }) => {
      await page.goto(path)
      await expect(selected(page)).toHaveCount(1, { timeout: 30_000 })
      await expect(selected(page)).toHaveAccessibleName(tab)
      await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "false")
      // The app header would add a second copy of the page's own title. The
      // closed drawer keeps its links mounted, so leave it out of the count.
      await expect
        .poll(() =>
          page.evaluate((text) => {
            return Array.from(document.querySelectorAll("*")).filter((el) => {
              if (el.children.length || el.textContent?.trim() !== text) return false
              if (el.closest('[aria-label="App sidebar"]')) return false
              const r = el.getBoundingClientRect()
              return r.width > 0 && r.right > 0 && r.left < window.innerWidth
            }).length
          }, title),
        )
        .toBe(1)
    })
  }

  test("tapping Meetings in the bar opens it with Meetings selected", async ({ page }) => {
    await page.getByRole("tab", { name: "Meetings" }).click()
    await expect(page).toHaveURL(/\/meetings/)
    await expect(page.getByRole("tab", { name: "Meetings" })).toHaveAttribute("aria-selected", "true")
    await page.getByRole("tab", { name: "Chat" }).click()
    await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true")
  })
})

