// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page, type BrowserContext } from "./fixtures"
import { makeTestUser, signUpAndOnboard, type TestUser } from "./helpers"

/**
 * Workspace Switching E2E Tests
 *
 * Exercises the workspace switcher end-to-end across the two chrome
 * layouts that key off `WEB_WIDE_MIN_WIDTH` (768px, see
 * apps/mobile/lib/native-phone-layout.ts):
 *   - Wide desktop (>=768px): the sidebar's `AccountMenu` popover
 *     (`WorkspaceMenuSection` with `isNative={false}`, "All workspaces"
 *     heading).
 *   - Narrow web (<768px): `MobileWorkspaceShell`'s chat drawer ->
 *     `MobileWorkspaceSwitcherRow` -> "Workspaces" sheet
 *     (`WorkspaceMenuSection` with `isNative={true}`).
 *
 * Both paths funnel into `scheduleWorkspaceSwitch` /
 * `reloadAfterWorkspaceSwitch` (apps/mobile/lib/switch-workspace.ts), which
 * persists the newly chosen workspace id and then does a full
 * `window.location.reload()` — switching workspaces can change which shell
 * chrome renders (`useWorkspaceExperience`), so the app deliberately
 * reboots instead of reconciling in place. That reload is the main source
 * of timing flakiness this suite guards against: every assertion after a
 * switch waits for the `load` event AND re-resolves the account menu
 * trigger's accessible name (which embeds the *current* workspace's name)
 * with a generous timeout, rather than racing a fixed sleep.
 *
 * One real account is enough to get two workspaces without touching Stripe:
 * signup seeds one free workspace of EACH kind (see `createPersonalWorkspace`
 * and `defaultTeamWorkspaceName` in apps/api/src/services/workspace.service.ts):
 *   1. A `kind: 'personal'` workspace named `${user.name} Personal`.
 *   2. A `kind: 'team'` workspace named `${firstName}'s Workspace`, which the
 *      destination-first onboarding (`signUpAndOnboard`) keeps and lands in.
 *
 * Run:
 *   npx playwright test --config e2e/playwright.config.ts workspace-switch
 */

const USER: TestUser = makeTestUser("WsSwitch")

// Both names are deterministic (apps/api/src/services/workspace.service.ts),
// so we don't need to scrape them out of the UI at runtime.
const PERSONAL_WORKSPACE = `${USER.name} Personal`
const TEAM_WORKSPACE = `${USER.name.split(" ")[0]}'s Workspace`

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The account menu trigger's accessible name is
 * `"${workspaceName}, ${userName} — open account"` (narrow web / native,
 * `AccountMenu`'s full-screen branch) or `"...— open account menu"` (wide
 * web popover branch) — see apps/mobile/components/layout/sidebar/AccountMenu.tsx.
 * Anchoring on the workspace-name prefix works for both shapes and lets a
 * single helper double as "is this workspace current?" across viewports.
 */
function accountTrigger(page: Page, workspaceName: string) {
  return page.getByRole("button", {
    name: new RegExp(`^${escapeRegExp(workspaceName)}, .+ — open account`),
  })
}

async function waitForAccountTriggerNamed(page: Page, workspaceName: string, timeout = 30_000) {
  await expect(accountTrigger(page, workspaceName)).toBeVisible({ timeout })
}

/**
 * gluestack's Popover trigger is a React Native Web Pressable that doesn't
 * always answer Playwright's synthetic click — the same issue documented on
 * `selectInteractionMode` in ./helpers.ts. Retry with raw pointer events,
 * then a direct DOM click, before giving up.
 */
async function openAccountPopover(page: Page, currentWorkspaceName: string) {
  const trigger = accountTrigger(page, currentWorkspaceName)
  await trigger.waitFor({ state: "visible", timeout: 20_000 })

  const popoverOpen = () => page.getByText("All workspaces").isVisible().catch(() => false)

  await trigger.click()
  await page.waitForTimeout(400)
  if (await popoverOpen()) return

  await trigger.dispatchEvent("pointerdown")
  await page.waitForTimeout(100)
  await trigger.dispatchEvent("pointerup")
  await page.waitForTimeout(400)
  if (await popoverOpen()) return

  await trigger.evaluate((el: HTMLElement) => el.click())
  await page.waitForTimeout(400)
}

/** Wide desktop (>=768px): switch via the sidebar's account popover. */
async function switchWorkspaceWide(page: Page, fromName: string, toName: string) {
  await waitForAccountTriggerNamed(page, fromName)
  await openAccountPopover(page, fromName)
  await expect(page.getByText("All workspaces")).toBeVisible({ timeout: 10_000 })

  // The switch reloads the page from a timeout after the click. Arm the wait
  // for that reload first: `waitForLoadState("load")` resolves immediately on
  // the still-loaded old page and races the reload.
  const reloaded = page.waitForEvent("load", { timeout: 30_000 })
  await page.getByText(toName, { exact: true }).first().click()
  await reloaded
  await waitForAccountTriggerNamed(page, toName)
}

/** The phone drawer's workspace row (`MobileWorkspaceSwitcherRow`). */
function mobileSwitcherRow(page: Page, currentName: string) {
  return page.getByRole("button", {
    name: new RegExp(`^Switch workspace\\. Current workspace ${escapeRegExp(currentName)},`),
  })
}

/** The team Home feed's title (`MobileHomeFeed`), which opens the account screen. */
function homeFeedSwitcher(page: Page, currentName: string) {
  return page.getByRole("button", { name: `${currentName}, switch workspace`, exact: true })
}

function chatDrawerOpener(page: Page) {
  return page.getByRole("button", { name: "Open chat sessions" })
}

async function openChatDrawerAndExpectWorkspace(page: Page, name: string) {
  const opener = chatDrawerOpener(page)
  await opener.waitFor({ state: "visible", timeout: 20_000 })
  // The first press can land before the shell hydrates; retry until the
  // drawer (and the workspace row inside it) is mounted.
  await expect(async () => {
    if (!(await mobileSwitcherRow(page, name).isVisible())) await opener.click()
    await expect(mobileSwitcherRow(page, name)).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 25_000 })
}

/**
 * Narrow web (<768px) Home differs by workspace kind: a team workspace shows
 * the Home feed, whose title opens the account screen; a personal workspace
 * shows the agent chat, whose drawer has the workspace row.
 */
async function expectNarrowWorkspace(page: Page, name: string): Promise<"feed" | "drawer"> {
  await page.goto("/")
  const feed = homeFeedSwitcher(page, name)
  await expect(feed.or(chatDrawerOpener(page)).first()).toBeVisible({ timeout: 20_000 })
  if (await feed.isVisible()) return "feed"
  await openChatDrawerAndExpectWorkspace(page, name)
  return "drawer"
}

async function switchWorkspaceNarrow(page: Page, fromName: string, toName: string) {
  if ((await expectNarrowWorkspace(page, fromName)) === "feed") {
    await homeFeedSwitcher(page, fromName).click()
  } else {
    await mobileSwitcherRow(page, fromName).click()
  }
  await page.getByText("Workspaces", { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 })
  // Switching triggers a full reload from a timeout after the click. Arm the
  // wait for it first (`waitForLoadState` would resolve on the old page and
  // the next goto("/") would collide with the reload), then re-derive state
  // from a clean "/".
  const reloaded = page.waitForEvent("load", { timeout: 30_000 })
  await page.getByText(toName, { exact: true }).last().click()
  await reloaded

  await expectNarrowWorkspace(page, toName)
}

test.describe("Workspace switching", () => {
  test.describe.configure({ mode: "serial" })

  let context: BrowserContext
  let page: Page

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)

    context = await browser.newContext()
    page = await context.newPage()
    await signUpAndOnboard(page, USER)

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto("/")
    await waitForAccountTriggerNamed(page, TEAM_WORKSPACE)
  })

  test.afterAll(async () => {
    await page?.close()
    await context?.close()
  })

  test("wide desktop (1280×800): switches both directions via the account popover", async () => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto("/")

    await switchWorkspaceWide(page, TEAM_WORKSPACE, PERSONAL_WORKSPACE)
    await switchWorkspaceWide(page, PERSONAL_WORKSPACE, TEAM_WORKSPACE)
  })

  test("narrow web (390×844): switches both directions from Home", async () => {
    await page.setViewportSize({ width: 390, height: 844 })

    await switchWorkspaceNarrow(page, TEAM_WORKSPACE, PERSONAL_WORKSPACE)
    await switchWorkspaceNarrow(page, PERSONAL_WORKSPACE, TEAM_WORKSPACE)
  })
})
