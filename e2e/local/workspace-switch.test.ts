// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page, type Locator } from "@playwright/test"

/**
 * Workspace switching — local/desktop E2E test.
 *
 * Local counterpart to `e2e/staging/workspace-switch.test.ts`. A *second*
 * workspace can't be reached the same way in local mode, so this test both
 * exercises and depends on a different pair of things than the staging one:
 *
 *   - `create-local-app.ts` deliberately doesn't mount the generic
 *     workspace CRUD routes (`workspace.routes.ts` / `workspaceHooks`) —
 *     desktop only needs a narrow route surface (`local-workspaces.ts`) —
 *     so there's no `POST /api/workspaces` for a second workspace to go
 *     through, and no "Create new workspace" entry in the sidebar/account
 *     menu (`!localMode` gate in `AppSidebar.tsx` / `account.tsx`).
 *   - Instead, `bootstrapLocalDatabase` (apps/api/src/lib/local-bootstrap.ts)
 *     seeds the single local user with one free workspace of *each* kind up
 *     front — a `personal` one via the normal signup hook, and a `team`
 *     one via an explicit backfill — mirroring the cloud "every account
 *     gets one free `personal` + one free `team`" rule
 *     (`workspaceHooks.beforeCreate`) without needing a creation UI. That
 *     backfill runs on every boot (not just fresh installs), so this test
 *     works against any local dev DB, however old.
 *
 * Workspace *names* aren't asserted — a pre-existing local DB may already
 * have owned a team (or extra personal) workspace under some other name
 * before the backfill shipped, in which case it correctly skips seeding a
 * redundant one rather than assuming `"${name} Team"`. This test instead
 * discovers whichever two workspaces are actually present and switches
 * between them, which both proves switching works and smoke-tests that the
 * account has at least two workspaces to switch between in the first place.
 *
 * Uses the sidebar's `AccountMenu` popover ("All workspaces" list), same as
 * the staging suite. Unlike staging, a cold `/` load here can land with a
 * secondary nav tab active (e.g. "Side chats") instead of "Home" — which
 * replaces the Home/Search/Meetings/... nav list with that tab's own
 * content in the same column and hides the account trigger. This looks
 * like a pre-existing timing race in the shell's default-tab selection
 * rather than anything about workspace switching itself, so `goHome`
 * retries the navigation (a handful of times, generously bounded) until
 * the trigger shows up instead of asserting on any single load.
 *
 * Local-mode auto-signs in — no login step needed (same assumption as
 * `chat-offline-resilience.test.ts`).
 *
 * Start the local stack first:
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *
 * Then:
 *   npx playwright test --config e2e/local/playwright.config.ts workspace-switch
 */

/** Matches the trigger for *whichever* workspace happens to be active. */
function anyAccountTrigger(page: Page): Locator {
  return page.getByRole("button", { name: /— open account/ })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The account menu trigger's accessible name is
 * `"${workspaceName}, ${userName} — open account"` — see
 * apps/mobile/components/layout/sidebar/AccountMenu.tsx.
 */
function accountTrigger(page: Page, workspaceName: string): Locator {
  return page.getByRole("button", {
    name: new RegExp(`^${escapeRegExp(workspaceName)}, .+ — open account`),
  })
}

/** See file header: retries a cold `/` load until the Home tab (and thus
 * the account trigger) is showing, rather than assuming any single load
 * lands there. */
async function goHome(page: Page, attempts = 8): Promise<Locator> {
  const trigger = anyAccountTrigger(page)
  for (let i = 0; i < attempts; i++) {
    await page.goto("/")

    // Narrow web (<768px) tucks the trigger behind the hamburger drawer,
    // same as the staging suite's `switchWorkspaceNarrow`.
    const menuButton = page.getByLabel("Open menu")
    if (await menuButton.isVisible().catch(() => false)) {
      await menuButton.click()
    }

    const appeared = await trigger.waitFor({ state: "visible", timeout: 3_000 }).then(
      () => true,
      () => false,
    )
    if (!appeared) continue

    // A post-mount redirect can swap the active nav tab (and hide the
    // trigger) shortly after first paint — reconfirm it's still there
    // before trusting it, instead of racing straight into a click.
    await page.waitForTimeout(600)
    const stillThere = await trigger.isVisible().catch(() => false)
    if (stillThere) return trigger
  }
  throw new Error(`Account trigger never stayed visible after ${attempts} navigation attempts`)
}

/**
 * gluestack's Popover trigger is a React Native Web Pressable that doesn't
 * always answer Playwright's synthetic click. Retry with raw pointer
 * events, then a direct DOM click, before giving up.
 */
async function openAccountPopover(page: Page, trigger: Locator) {
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

/**
 * All workspace names currently offered by the switcher. `WorkspaceMenuSection`
 * (apps/mobile/components/layout/sidebar/WorkspaceMenuSection.tsx) renders
 * each row as a plain `Pressable` with no `accessibilityRole`/`aria-label` —
 * react-native-web emits it as an unadorned `<div>` (matched by
 * `getByText`, not any role query) whose `textContent` concatenates, with
 * no separator, the avatar-letter initial + workspace name + kind badge
 * ("Personal"/"Team"), e.g. `"LLocal User PersonalPersonal"`. The avatar
 * letter is always the name's own first character, so stripping the badge
 * suffix then the leading character recovers the name exactly.
 */
async function listWorkspaceNames(page: Page): Promise<string[]> {
  const trigger = await goHome(page)
  await openAccountPopover(page, trigger)
  await expect(page.getByText("All workspaces")).toBeVisible({ timeout: 10_000 })

  const names = await page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll("*")).find(
      (el) => el.textContent?.trim() === "All workspaces" && el.children.length === 0,
    )
    if (!heading?.parentElement) return []
    return Array.from(heading.parentElement.children)
      .filter((el) => el !== heading)
      .map((el) => (el.textContent ?? "").replace(/(Personal|Team)$/, "").slice(1))
      .filter((name) => name.length > 0)
  })

  await page.keyboard.press("Escape")
  return names
}

/**
 * `scheduleWorkspaceSwitch` (apps/mobile/lib/switch-workspace.ts) defers the
 * actual `window.location.reload()` behind a `setTimeout(0)` (to paint the
 * tap before reloading — see that file's header comment), so waiting for
 * `load` *after* `.click()` resolves can race a reload that hasn't started
 * yet. Attach the `load` listener first so it can't be missed.
 */
async function clickAndWaitForReload(page: Page, locator: Locator) {
  await Promise.all([page.waitForEvent("load", { timeout: 30_000 }), locator.click()])
}

/**
 * Wide desktop (>=768px): switch via the sidebar's account popover. A
 * no-op (no reload fires) if `toName` is already active — check via the
 * trigger's own name first rather than risking a hang on
 * `clickAndWaitForReload`.
 */
async function switchWorkspaceWide(page: Page, toName: string) {
  const trigger = await goHome(page)
  if (await accountTrigger(page, toName).isVisible().catch(() => false)) return

  await openAccountPopover(page, trigger)
  await expect(page.getByText("All workspaces")).toBeVisible({ timeout: 10_000 })

  await clickAndWaitForReload(page, page.getByText(toName, { exact: true }).first())
  await expect(accountTrigger(page, toName)).toBeVisible({ timeout: 30_000 })
}

/**
 * Narrow web (<768px): the same trigger instead navigates to a full-page
 * `/account` screen ("Workspaces" section, same underlying
 * `WorkspaceMenuSection` rows) rather than opening the popover — mirrors
 * `switchWorkspaceNarrow` in the staging suite.
 */
async function switchWorkspaceNarrow(page: Page, toName: string) {
  const trigger = await goHome(page)
  if (await accountTrigger(page, toName).isVisible().catch(() => false)) return

  await trigger.click()
  await page.waitForURL(/\/account/, { timeout: 15_000 })
  await page.getByText("Workspaces", { exact: true }).waitFor({ state: "visible", timeout: 10_000 })

  await clickAndWaitForReload(page, page.getByText(toName, { exact: true }).first())
  await goHome(page)
  await expect(accountTrigger(page, toName)).toBeVisible({ timeout: 30_000 })
}

test.describe("Workspace switching (local mode)", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let WORKSPACE_A: string
  let WORKSPACE_B: string

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)
    page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 800 })

    // Sanity-check at least two workspaces exist — fails fast with a clear
    // assertion if `bootstrapLocalDatabase` hasn't backfilled the team
    // workspace (e.g. a local DB from before that change whose API server
    // hasn't rebooted yet). See file header for why names aren't asserted.
    const names = await listWorkspaceNames(page)
    expect(names.length).toBeGreaterThanOrEqual(2)
    ;[WORKSPACE_A, WORKSPACE_B] = names
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test("wide desktop (1280×800): switches both directions via the account popover", async () => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1280, height: 800 })

    await switchWorkspaceWide(page, WORKSPACE_A)
    await switchWorkspaceWide(page, WORKSPACE_B)
    await switchWorkspaceWide(page, WORKSPACE_A)
  })

  test("narrow web (390×844): switches both directions via the /account screen", async () => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 390, height: 844 })

    await switchWorkspaceNarrow(page, WORKSPACE_B)
    await switchWorkspaceNarrow(page, WORKSPACE_A)
    await switchWorkspaceNarrow(page, WORKSPACE_B)
  })
})
