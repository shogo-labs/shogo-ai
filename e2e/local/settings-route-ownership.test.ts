// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A direct `/settings` link is the user's Settings page, never the admin console
 * (SHO-110, QA acceptance).
 *
 * `(admin)` and `(app)` are route groups, so two files used to answer
 * `/settings`: the admin AI/provider console and the end-user Settings page. The
 * admin console won, so every external link — the join mail's
 * `/settings?tab=people`, a bookmark, a pasted URL — landed on the admin page,
 * which then bounced the visitor. In-app navigation hid it, because a push
 * carries the group segment (`/(app)/settings`, `/(admin)/settings`).
 *
 * The first two tests are the request a person actually makes from an email:
 * a **cold** top-level GET of the mailed URL, in a browser context with no
 * session. Before the fix that load resolved to the admin console; now it is the
 * end-user Settings page (wide web) and the Account settings sheet (phone).
 *
 * `/settings?tab=people` is what join mail sends (pinned api-side by
 * `join-mail-settings-link.acceptance.test.ts` and route-side by
 * `apps/mobile/test/__tests__/settings-route-ownership.acceptance.test.ts`). In
 * local mode `people` is a cloud-only tab, so the page renders its fallback tab —
 * the assertion here is *which page* answered, not which tab body.
 *
 * The admin console is asserted through the in-app entry point rather than a
 * cold GET of `/admin/settings`: in local mode the client signs the local user in
 * on boot, so *every* `(admin)` URL cold-loaded without that session is forwarded
 * by the auth gate to `/` and the local-mode landing (`/projects`) — `/projects`
 * does it too, so it says nothing about this card. The nav click below is the
 * path a super admin really takes.
 *
 * Runs on the local stack (`E2E_LOCAL_START_STACK=1`).
 */
import { expect, test, type Page } from '@playwright/test'

const WIDE = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

/** The admin AI/provider console's own copy — it renders nowhere else. */
const ADMIN_MARKERS = ['Admin / Intelligence', 'Choose your AI provider and configure models.']

const appSidebar = (page: Page) => page.getByRole('navigation', { name: 'App sidebar' })
const accountSheet = (page: Page) => page.getByTestId('native-account-settings-sheet')

async function expectAdminConsole(page: Page) {
  for (const marker of ADMIN_MARKERS) {
    await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({ timeout: 120_000 })
  }
  await expect(appSidebar(page)).toHaveCount(0)
}

async function expectUserSettings(page: Page) {
  for (const marker of ADMIN_MARKERS) {
    await expect(page.getByText(marker, { exact: false })).toHaveCount(0)
  }
}

test.describe('Settings paths (SHO-110)', () => {
  test('a cold GET of the join-mail link renders the user Settings page', async ({ page }) => {
    test.setTimeout(240_000)
    await page.setViewportSize(WIDE)
    await page.goto('/settings?tab=people')

    // Never the admin console (which forwards away from /settings), never /projects.
    await expect(page).toHaveURL(/\/settings(\?|$)/, { timeout: 120_000 })
    await expect(appSidebar(page)).toBeVisible({ timeout: 120_000 })
    await expectUserSettings(page)
    // A late bounce would otherwise slip past: the page has to *stay* here.
    await page.waitForTimeout(2_000)
    await expect(page).toHaveURL(/\/settings(\?|$)/)
    await expect(appSidebar(page)).toBeVisible()
  })

  test('a cold phone GET of the same link opens the Settings sheet', async ({ page }) => {
    test.setTimeout(240_000)
    await page.setViewportSize(PHONE)
    await page.goto('/settings?tab=people')

    await expect(page).toHaveURL(/\/account(\?|$)/, { timeout: 120_000 })
    await expect(accountSheet(page)).toBeVisible({ timeout: 60_000 })
    await expectUserSettings(page)
    await page.waitForTimeout(2_000)
    await expect(page).toHaveURL(/\/account(\?|$)/)
    await expect(accountSheet(page)).toBeVisible()
  })

  test('the admin nav still opens the AI console at /admin/settings', async ({ page }) => {
    test.setTimeout(240_000)
    await page.setViewportSize(WIDE)
    await page.goto('/')

    // Into the admin portal the way a person does it: the app sidebar's Admin link.
    await page.getByRole('link', { name: 'Admin', exact: true }).first().click({ timeout: 180_000 })
    await expect(page.getByRole('button', { name: 'AI', exact: true }).first()).toBeVisible({
      timeout: 120_000,
    })

    await page.getByRole('button', { name: 'AI', exact: true }).first().click()

    await expect(page).toHaveURL(/\/admin\/settings/, { timeout: 60_000 })
    await expectAdminConsole(page)
  })
})
