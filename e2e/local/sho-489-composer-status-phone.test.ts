// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-489 — the composer's status lines belong above the input, not under it.
 *
 * A channel composer uploading an attachment on a phone painted "Uploading…"
 * below the input, against the home indicator, where it read as detached from
 * the message. The same `Composer` renders on phone, web and desktop, and the
 * status block moved as one, so the phone test pins the three things the card
 * asks for and the desktop test pins that the pickers did not move:
 *
 *   phone   — "Uploading…" ends above the input, the input itself does not
 *             move when the line appears (the floating footer grows upward
 *             into the transcript instead of squashing the composer), and the
 *             upload still sends the message with its attachment.
 *   desktop — the "/remind" hint draws above the input while the Send-later
 *             menu stays below it.
 *
 * The phone upload is held on the wire so the line can be measured while it
 * shows. The phone composer has no Send-later control (the prominent variant
 * replaces the trailing slot with Send), so that surface is asserted at a
 * desktop width.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts sho-489-composer-status
 */
import { expect, test, type Page } from '@playwright/test'
import { ignoreDevErrorToast } from './helpers'
import {
  activateTeamWorkspace,
  api,
  cleanupTeamNav,
  seedTeamNav,
  signInByApi,
  type TeamNavSeed,
} from './team-nav-seed'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

let seed: TeamNavSeed
let seeder: Page

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000)
  const context = await browser.newContext()
  seeder = await context.newPage()
  await signInByApi(seeder)
  seed = await seedTeamNav(seeder)
})

test.afterAll(async () => {
  if (seed) await cleanupTeamNav(seeder, seed)
  await seeder?.context().close()
})

test.describe('SHO-489 on a phone', () => {
  // The phone layout is chosen from the window size, so a 390×844 viewport is
  // the composer an iPhone gets.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('"Uploading…" sits above the input, and the input does not move', async ({ page }) => {
    test.setTimeout(180_000)
    await ignoreDevErrorToast(page)
    await signInByApi(page)
    await activateTeamWorkspace(page, seed.workspaceId)

    // Hold the attachment POST so "Uploading…" stays on screen to be measured.
    let releaseUpload: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      releaseUpload = resolve
    })
    await page.route('**/api/conversations/*/attachments', async (route) => {
      await held
      await route.continue().catch(() => {})
    })

    await page.goto(`/c/${seed.channelId}`)
    const input = page.getByRole('textbox', { name: 'Message' })
    await expect(input).toBeVisible({ timeout: 120_000 })

    // Stage a photo through the phone "+" sheet, the way a person attaches one.
    await page.getByTestId('project-composer-plus').first().click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByText('Photo library', { exact: true }).first().click()
    await (await chooser).setFiles({ name: 'qa-status.png', mimeType: 'image/png', buffer: PNG })
    await expect(page.getByRole('button', { name: 'Preview image qa-status.png' })).toBeVisible({
      timeout: 30_000,
    })

    await input.fill('see attached')
    const before = await input.boundingBox()
    expect(before, 'composer input box before sending').toBeTruthy()

    await page.getByLabel('Send message').click()
    const status = page.getByText('Uploading…')
    await expect(status).toBeVisible({ timeout: 15_000 })

    const statusBox = await status.boundingBox()
    const during = await input.boundingBox()
    expect(statusBox, '"Uploading…" box').toBeTruthy()
    expect(during, 'composer input box while uploading').toBeTruthy()
    // Above the input, never between it and the pager indicator.
    expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(during!.y + 1)
    // …and the footer grew upward: the input itself did not move.
    expect(Math.abs(during!.y - before!.y)).toBeLessThanOrEqual(2)

    releaseUpload()
    await expect(status).toHaveCount(0, { timeout: 30_000 })

    // The line leaves no gap behind: the composer is back where it started, so
    // a build that quietly reserved a status row would show up here.
    const settled = await input.boundingBox()
    expect(settled, 'composer input box after the line clears').toBeTruthy()
    expect(Math.abs(settled!.y - before!.y)).toBeLessThanOrEqual(1)
    await expect
      .poll(
        async () => {
          const list = await api(seeder, 'GET', `/api/conversations/${seed.channelId}/messages`)
          return (
            (list.json?.messages ?? []).find((m: any) => m.text === 'see attached')?.attachments
              ?.length ?? 0
          )
        },
        { timeout: 30_000 },
      )
      .toBe(1)
  })
})

test.describe('SHO-489 on a desktop width', () => {
  test.use({ viewport: { width: 1180, height: 900 } })

  test('the "/remind" hint draws above the input while Send later stays below it', async ({
    page,
  }) => {
    test.setTimeout(180_000)
    await ignoreDevErrorToast(page)
    await signInByApi(page)
    await activateTeamWorkspace(page, seed.workspaceId)

    await page.goto(`/c/${seed.channelId}`)
    const input = page.getByRole('textbox', { name: 'Message' })
    await expect(input).toBeVisible({ timeout: 120_000 })

    await input.fill('/remind me to review the PR in 2 hours')
    const hint = page.getByText(/Only you will see this/)
    await expect(hint).toBeVisible({ timeout: 15_000 })
    const hintBox = await hint.boundingBox()
    const inputBox = await input.boundingBox()
    expect(hintBox, '"/remind" hint box').toBeTruthy()
    expect(inputBox, 'composer input box').toBeTruthy()
    expect(hintBox!.y + hintBox!.height).toBeLessThanOrEqual(inputBox!.y + 1)

    // The pickers were out of scope: Send later still hangs below the input.
    await input.fill('later')
    await page.getByLabel('Send later').first().click()
    const menu = page.getByText('Send later', { exact: true })
    await expect(menu).toBeVisible({ timeout: 15_000 })
    const menuBox = await menu.boundingBox()
    const after = await input.boundingBox()
    expect(menuBox, 'send-later menu box').toBeTruthy()
    expect(after, 'composer input box with the menu open').toBeTruthy()
    expect(menuBox!.y).toBeGreaterThanOrEqual(after!.y + after!.height - 1)
  })
})
