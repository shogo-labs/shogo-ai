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

  test("the rail is icons only, and a label appears beside an icon on hover or focus", async () => {
    await page.mouse.move(700, 450)
    // No text labels sit under the icons; the names live in tooltips.
    await expect(page.getByTestId("rail-tooltip")).toHaveCount(0)
    await expect(rail(page).getByText("Channels", { exact: true })).toHaveCount(0)

    await tab(page, "Agents").hover()
    const bubble = page.getByTestId("rail-tooltip")
    await expect(bubble).toHaveText("Agents")
    const tabBox = (await tab(page, "Agents").boundingBox())!
    const bubbleBox = (await bubble.boundingBox())!
    expect(bubbleBox.x).toBeGreaterThanOrEqual(tabBox.x + tabBox.width) // to the right of the icon

    await page.mouse.move(700, 450)
    await expect(bubble).toHaveCount(0)

    await tab(page, "DMs").focus()
    await expect(page.getByTestId("rail-tooltip")).toHaveText("DMs")
    await tab(page, "DMs").blur()
    await expect(page.getByTestId("rail-tooltip")).toHaveCount(0)

    await page.getByTestId("profile-avatar").hover()
    await expect(page.getByTestId("rail-tooltip")).toHaveText("Profile and settings")
    await page.mouse.move(700, 450)

    // After a click the label must still show on hover, even once the icon loses focus.
    for (const name of ["DMs", "Home"]) {
      await tab(page, name).hover()
      await tab(page, name).click()
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await expect(page.getByTestId("rail-tooltip")).toHaveText(name)
      const box = (await tab(page, name).boundingBox())!
      await page.mouse.move(box.x + 6, box.y + 6, { steps: 3 })
      await expect(page.getByTestId("rail-tooltip")).toHaveText(name)
      await page.mouse.move(700, 450)
      await expect(page.getByTestId("rail-tooltip")).toHaveCount(0)
    }
  })

  test.describe("in the dark theme", () => {
    test.use({ colorScheme: "dark" })
    test("the label is a dark bubble with light text", async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })
      const dark = await context.newPage()
      try {
        await signIn(dark)
        await activateTeamWorkspace(dark, seed.workspaceId)
        await dark.goto("/")
        await expect(rail(dark)).toBeVisible({ timeout: 60_000 })
        await tab(dark, "Agents").hover()
        const bubble = dark.getByTestId("rail-tooltip")
        await expect(bubble).toHaveText("Agents")
        const colors = await bubble.evaluate((el) => {
          const box = el.firstElementChild as HTMLElement
          const text = box.querySelector("*") as HTMLElement
          return { bg: getComputedStyle(box).backgroundColor, fg: getComputedStyle(text).color }
        })
        const lum = (rgb: string) => {
          const [r, g, b] = rgb.match(/\d+/g)!.slice(0, 3).map(Number)
          return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
        }
        expect(lum(colors.fg), `text ${colors.fg}`).toBeGreaterThan(0.85)
        expect(lum(colors.bg), `bubble ${colors.bg}`).toBeLessThan(0.4)
      } finally {
        await context.close()
      }
    })
  })

  test("there is one profile button and one workspace switcher, both on the rail", async () => {
    await expect(page.getByTestId("profile-avatar")).toHaveCount(1)
    await expect(page.getByRole("button", { name: "Profile and settings" })).toHaveCount(1)
    const switcher = page.getByRole("button", { name: /— open account menu/ })
    await expect(switcher).toHaveCount(1)
    await expect(rail(page).getByRole("button", { name: /— open account menu/ })).toBeVisible()
    // The panel no longer repeats the account row, whichever tab is open.
    for (const name of ["Home", "Channels", "DMs"]) {
      await tab(page, name).click()
      await expect(switcher).toHaveCount(1)
    }
    await tab(page, "Home").click()

    await switcher.click()
    await expect(page.getByText("All workspaces")).toBeVisible()
    await page.keyboard.press("Escape")
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
    await expect(panel(page, "more-panel").getByRole("link", { name: "Tasks" })).toHaveCount(0)
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
    await expect(items).toHaveText([/Ask an agent/, /New project/, /New message/, /Create channel/])

    await page.getByRole("menuitem", { name: "Create channel" }).click()
    await expect(page.getByText("Create a channel")).toBeVisible()
    await page.getByLabel("Close", { exact: true }).click()

    // On desktop "New message" is a dialog that lists people and agents together.
    await rail(page).getByRole("button", { name: "Create", exact: true }).click()
    await page.getByRole("menuitem", { name: "New message" }).click()
    const picker = page.getByTestId("new-message-picker")
    await expect(picker).toBeVisible()
    await expect(picker.getByText("People", { exact: true }).first()).toBeVisible()
    await expect(picker.getByRole("button", { name: `${seed.idleAgent}, agent` })).toBeVisible({ timeout: 30_000 })
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
    // Home's list is the chats. The rail already names every page, so the panel
    // does not repeat Meetings, Goals or Activity as links.
    const chats = page.getByTestId("personal-chats-panel")
    await expect(chats.getByRole("link", { name: "Chat", exact: true })).toBeVisible({ timeout: 30_000 })
    for (const name of ["Meetings", "Goals", "Activity"]) {
      await expect(chats.getByRole("link", { name })).toHaveCount(0)
    }
    await expect(page.getByTestId("profile-avatar")).toHaveCount(1)
    await expect(page.getByRole("button", { name: /— open account menu/ })).toHaveCount(1)
    await expect(rail(page).getByRole("button", { name: "Search" })).toBeVisible()

    await tab(page, "Meetings").click()
    await expect(page).toHaveURL(/\/meetings/)
    await expect(page.getByRole("navigation", { name: "App sidebar" })).toHaveCount(0)
    await expect(tab(page, "Meetings")).toHaveAttribute("aria-selected", "true")
    await tab(page, "Activity").click()
    await expect(page).toHaveURL(/\/activity/)

    // More is the one tab with a list: what has no tab of its own.
    await tab(page, "More").click()
    await expect(page.getByTestId("more-panel")).toBeVisible()
    await tab(page, "Goals").click()
    await expect(page.getByTestId("more-panel")).toHaveCount(0)
  })

  test("Home returns to the main chat, with the other chats on the side", async ({ page }) => {
    await signIn(page)
    await page.goto("/")
    await expect(rail(page)).toBeVisible({ timeout: 60_000 })

    // Start a side chat from the panel: it opens, and is listed under "Other chats".
    await page.getByRole("button", { name: "New side chat" }).click()
    await expect(page).toHaveURL(/\/side-chats\/[^/?]+/, { timeout: 30_000 })
    await expect(tab(page, "Home")).toHaveAttribute("aria-selected", "true")
    const sideChatUrl = page.url()
    const chats = page.getByTestId("personal-chats-panel")
    await expect(chats.getByRole("link", { name: /Workspace chat|^Chat · / }).first()).toBeVisible({ timeout: 30_000 })

    // Home from a side chat goes back to the main chat.
    await tab(page, "Home").click()
    await expect(page).not.toHaveURL(sideChatUrl)
    await expect(page).toHaveURL(/\/(\(app\))?\/?(\?.*)?$/)
    await expect(chats.getByRole("link", { name: "Chat", exact: true })).toHaveAttribute("aria-current", "page")
    await expect(chats.getByRole("link", { name: /Workspace chat|^Chat · / }).first()).toBeVisible()

    // Home from another page does too, and keeps the chats beside it.
    await tab(page, "Meetings").click()
    await expect(page).toHaveURL(/\/meetings/)
    await expect(chats).toHaveCount(0)
    await tab(page, "Home").click()
    await expect(page).not.toHaveURL(/\/meetings/)
    await expect(tab(page, "Home")).toHaveAttribute("aria-selected", "true")
    await expect(chats.getByRole("link", { name: "Chat", exact: true })).toBeVisible()
    await expect(chats.getByRole("link", { name: /Workspace chat|^Chat · / }).first()).toBeVisible()

    // A listed side chat opens from the panel.
    await chats.getByRole("link", { name: /Workspace chat|^Chat · / }).first().click()
    await expect(page).toHaveURL(/\/side-chats\//)
  })
})
