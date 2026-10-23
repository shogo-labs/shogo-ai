// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phone Settings is the Account sheet (SHO-86).
 *
 * On a handset or narrow web (≤767px) `/(app)/settings` must not render the
 * legacy page (its own back header + horizontal `TabBar`, with the legacy
 * `AppHeader` hamburger and `AppSidebar` drawer above it). It redirects into
 * `/(app)/account`, which hosts the same `SettingsContent` inside
 * `NativeAccountSettingsSheet`, and every `/settings?tab=…` deep link opens its
 * tab there. Wide web and desktop keep today's page.
 *
 * Entry points, not URLs: on web `/settings` also resolves to the admin console
 * route (it bounces to `/projects`), so the app page is only reachable through
 * an in-app `router.replace("/(app)/settings?tab=…")` — the same way a user
 * gets there (`automations.tsx:18`, `members.tsx:17`, `remote-control.tsx`).
 *
 * Both breakpoints live in one spec (explicit `page.setViewportSize`, the shape
 * `automations-settings.test.ts` uses) so the chromium project covers the phone
 * surface and the 1440 page side by side.
 */
import { expect, test, type Page } from "@playwright/test"
import { teamWorkspaceId } from "./team-nav-seed"

const PHONE = { width: 390, height: 844 }
const WIDE = { width: 1440, height: 900 }

const sheet = (page: Page) => page.getByTestId("native-account-settings-sheet")
const legacyPage = (page: Page) => page.getByTestId("settings-legacy-page")
const legacyTabBar = (page: Page) => page.getByTestId("settings-legacy-tab-bar")

async function openOn(
  page: Page,
  viewport: { width: number; height: number },
  path: string,
) {
  await page.setViewportSize(viewport)
  await page.goto(path)
}

/** The Account screen, its sheet open on `title`, and none of the legacy chrome. */
async function expectAccountSheet(page: Page, title: string) {
  await expect(page).toHaveURL(/\/account(\?|$)/, { timeout: 60_000 })
  await expect(sheet(page)).toBeVisible({ timeout: 30_000 })
  await expect(sheet(page).getByText(title, { exact: true }).first()).toBeVisible()
  await expect(legacyPage(page)).toHaveCount(0)
  await expect(legacyTabBar(page)).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0)
}

test.describe("Phone Settings is the Account sheet", () => {
  test("the Automations entry lands on Account with its tab sheet and no legacy chrome", async ({ page }) => {
    test.setTimeout(120_000)
    await openOn(page, PHONE, "/automations")

    await expectAccountSheet(page, "Automations")
    await expect(sheet(page).getByTestId("automations-tab")).toBeVisible({ timeout: 30_000 })
    // No legacy AppHeader hamburger → no tap target for the AppSidebar drawer.
    await expect(page.getByRole("button", { name: "Close menu" })).toHaveCount(0)
  })

  test("other settings entries land on their own tab in the sheet", async ({ page }) => {
    test.setTimeout(180_000)
    await openOn(page, PHONE, "/remote-control")
    await expectAccountSheet(page, "Remote Control")

    // `people` is cloud-only; locally it has to degrade, never open a blank sheet.
    await openOn(page, PHONE, "/members")
    await expectAccountSheet(page, "Workspace")
  })

  test("the Account home has no sheet until a tab is asked for", async ({ page }) => {
    test.setTimeout(120_000)
    await openOn(page, PHONE, "/account")

    await expect(page.getByText("Workspaces", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(sheet(page)).toHaveCount(0)
    await expect(legacyPage(page)).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0)
  })

  test("?workspace= is forwarded and switches the active workspace", async ({ page }) => {
    test.setTimeout(120_000)
    await openOn(page, PHONE, "/account")
    // The app establishes the local session while it boots; /api/workspaces is
    // 401 until it has, so wait for the Account screen before asking.
    await expect(page.getByText("Workspaces", { exact: true })).toBeVisible({ timeout: 60_000 })
    const teamId = await teamWorkspaceId(page)

    await openOn(page, PHONE, `/automations?workspace=${teamId}`)
    await expectAccountSheet(page, "Automations")
    await expect
      .poll(
        () => page.evaluate(() => localStorage.getItem("shogo:active-workspace-id")),
        { timeout: 30_000 },
      )
      .toBe(teamId)
    await expect(sheet(page).getByTestId("automations-tab")).toBeVisible({ timeout: 30_000 })
  })

  test("closing the deep-linked sheet consumes the tab, and a reload stays on Account", async ({ page }) => {
    test.setTimeout(120_000)
    await openOn(page, PHONE, "/automations")
    await expectAccountSheet(page, "Automations")

    await sheet(page).getByRole("button", { name: "Close" }).click()
    await expect(sheet(page)).toHaveCount(0)
    await expect(page).toHaveURL(/\/account(\?|$)/)
    await expect(page).not.toHaveURL(/[?&]tab=/)

    // The consumed param is what keeps Back/reload from re-opening the sheet.
    await page.reload()
    await expect(page.getByText("Workspaces", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(sheet(page)).toHaveCount(0)
    await expect(page).not.toHaveURL(/[?&]tab=/)
  })

  test("the phone breakpoint is 767px, and 768px keeps the desktop page", async ({ page }) => {
    test.setTimeout(180_000)
    await openOn(page, { width: 767, height: 900 }, "/automations")
    await expectAccountSheet(page, "Automations")

    await openOn(page, { width: 768, height: 900 }, "/automations")
    await expect(page).toHaveURL(/\/settings/, { timeout: 60_000 })
    await expect(sheet(page)).toHaveCount(0)
    await expect(page.getByTestId("automations-tab")).toBeVisible({ timeout: 30_000 })
  })

  test("wide web keeps today's Settings page for settings deep links", async ({ page }) => {
    test.setTimeout(120_000)
    await openOn(page, WIDE, "/automations")

    await expect(page).toHaveURL(/\/settings/, { timeout: 60_000 })
    await expect(sheet(page)).toHaveCount(0)
    await expect(page.getByTestId("automations-tab")).toBeVisible({ timeout: 30_000 })
    await expect(legacyPage(page)).toHaveCount(0)
    await expect(legacyTabBar(page)).toHaveCount(0)
  })
})
