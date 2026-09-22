// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page, type BrowserContext } from "@playwright/test"
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
 *   - Narrow web (<768px): hamburger drawer -> full-page `/account` screen
 *     (`WorkspaceMenuSection` with `isNative={true}`, "Workspaces" group).
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
 * every account gets one free workspace of EACH kind — `personal` and
 * `team` (see `workspaceHooks.beforeCreate` in
 * apps/api/src/generated/workspace.hooks.ts). So a single sign-up gets:
 *   1. An implicit `kind: 'personal'` workspace from `createPersonalWorkspace`
 *      at signup time (`${user.name} Personal`).
 *   2. A second, free `kind: 'team'` workspace created via the sidebar's
 *      "Create new workspace" flow (`CreateWorkspaceModal` — free because
 *      the account doesn't own a team workspace yet; see `hasTeamWorkspace`
 *      in apps/mobile/components/layout/sidebar/AppSidebar.tsx). This is
 *      faster and far less flaky than a *second paid* workspace, which
 *      requires hosted Stripe Checkout (apps/mobile/app/(app)/new-workspace.tsx).
 *
 * Run:
 *   npx playwright test --config e2e/playwright.config.ts workspace-switch
 */

const USER: TestUser = makeTestUser("WsSwitch")

// `createPersonalWorkspace` (apps/api/src/services/workspace.service.ts)
// names every signup's implicit workspace `${userName} Personal` — this is
// deterministic, so we don't need to scrape it out of the UI at runtime.
const PERSONAL_WORKSPACE = `${USER.name} Personal`
const TEAM_WORKSPACE = `${USER.name} Team`

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

  await page.getByText(toName, { exact: true }).first().click()
  await page.waitForLoadState("load")
  await waitForAccountTriggerNamed(page, toName)
}

/** Narrow web (<768px): switch via the hamburger drawer -> /account screen. */
async function switchWorkspaceNarrow(page: Page, fromName: string, toName: string) {
  await page.goto("/")
  await page.getByLabel("Open menu").click()
  await waitForAccountTriggerNamed(page, fromName)
  await accountTrigger(page, fromName).click()
  await page.waitForURL(/\/account/, { timeout: 15_000 })

  await page.getByText("Workspaces", { exact: true }).waitFor({ state: "visible", timeout: 10_000 })
  await page.getByText(toName, { exact: true }).first().click()
  // `/account` triggers the same full reload as the popover path; the URL
  // itself doesn't change, so re-derive state from a clean "/" + reopen the
  // drawer rather than trusting whatever `/account` renders mid-reload.
  await page.waitForLoadState("load")

  await page.goto("/")
  await page.getByLabel("Open menu").click()
  await waitForAccountTriggerNamed(page, toName)
}

/**
 * Creates the account's free `kind: 'team'` workspace via the sidebar's
 * "Create new workspace" flow. Assumes a wide (>=768px) viewport is active
 * and the account currently only owns `currentWorkspaceName` — the button
 * only opens the free `CreateWorkspaceModal` (rather than routing to paid
 * Stripe checkout) while `hasTeamWorkspace` is false, i.e. before this
 * runs. See `handleCreateWorkspace` in
 * apps/mobile/components/layout/sidebar/AppSidebar.tsx.
 */
async function createFreeTeamWorkspace(
  page: Page,
  currentWorkspaceName: string,
  newWorkspaceName: string,
) {
  await page.goto("/")
  await waitForAccountTriggerNamed(page, currentWorkspaceName)
  await openAccountPopover(page, currentWorkspaceName)
  await expect(page.getByText("All workspaces")).toBeVisible({ timeout: 10_000 })

  await page.getByText("Create new workspace", { exact: true }).first().click()

  const nameField = page.getByPlaceholder(/My Team, Acme Corp/)
  await nameField.waitFor({ state: "visible", timeout: 10_000 })
  await nameField.fill(newWorkspaceName)
  await page.getByText("Create workspace", { exact: true }).click()

  // The modal closes itself on a successful create; no page reload happens
  // for workspace *creation* (only for switching), so the account trigger
  // should flip to the new workspace once the client-side state updates.
  await nameField.waitFor({ state: "hidden", timeout: 15_000 })
  await waitForAccountTriggerNamed(page, newWorkspaceName)
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
    await createFreeTeamWorkspace(page, PERSONAL_WORKSPACE, TEAM_WORKSPACE)
  })

  test.afterAll(async () => {
    await page?.close()
    await context?.close()
  })

  test("wide desktop (1280×800): switches both directions via the account popover", async () => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto("/")

    await switchWorkspaceWide(page, PERSONAL_WORKSPACE, TEAM_WORKSPACE)
    await switchWorkspaceWide(page, TEAM_WORKSPACE, PERSONAL_WORKSPACE)
  })

  test("narrow web (390×844): switches both directions via the /account screen", async () => {
    await page.setViewportSize({ width: 390, height: 844 })

    await switchWorkspaceNarrow(page, PERSONAL_WORKSPACE, TEAM_WORKSPACE)
    await switchWorkspaceNarrow(page, TEAM_WORKSPACE, PERSONAL_WORKSPACE)
  })
})
