// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * #1989: the IDE explorer of a folder project listed a dozen dot-entries of a
 * 200-entry folder. Runs against the packaged app in desktop-e2e.yml and the
 * release boot-smoke jobs.
 *
 *   PLAYWRIGHT_E2E=1 SHOGO_E2E_EXECUTABLE=<Shogo.exe> npx playwright test \
 *     --config e2e/playwright.config.ts explorer-folder-project.spec.ts
 */
import { expect, test } from '@playwright/test'
import fs from 'fs'
import { explorerRow, launchPackagedApp, openFolderProjectIde, writeFixtureFolder, type PackagedApp } from './packaged-app'

test.skip(process.env.PLAYWRIGHT_E2E !== '1', 'set PLAYWRIGHT_E2E=1 to run')
test.describe.configure({ mode: 'serial' })
test.setTimeout(420_000)

let shogo: PackagedApp
let folder: string

test.beforeAll(async () => {
  // Hooks don't inherit test.setTimeout; a cold packaged launch needs more than the config default.
  test.setTimeout(420_000)
  folder = writeFixtureFolder('shogo-e2e-explorer-').folder
  shogo = await launchPackagedApp()
  await openFolderProjectIde(shogo.page, folder)
})

test.afterAll(async () => {
  await shogo?.close()
  fs.rmSync(folder, { recursive: true, force: true })
})

test('folders, dot-entries and the .git pointer file are all listed', async () => {
  const page = shogo.page
  for (const name of ['src', '.dot-dir-4', '.dot-file-29', '.git', 'README.md', 'file-000.py']) {
    await expect(explorerRow(page, name)).toBeVisible({ timeout: 60_000 })
  }
  await expect(page.getByText('Some folders are still loading')).toHaveCount(0)
})

test('src expands to its folders', async () => {
  await explorerRow(shogo.page, 'src').click()
  await expect(explorerRow(shogo.page, 'nested')).toBeVisible({ timeout: 30_000 })
  await expect(explorerRow(shogo.page, 'main.py')).toBeVisible()
})

test('the 200th plain file is reachable by scrolling', async () => {
  const page = shogo.page
  const explorer = page.getByLabel('Explorer', { exact: true }).first()
  await explorer.hover()
  await expect(async () => {
    await page.mouse.wheel(0, 4_000)
    await expect(explorerRow(page, 'file-199.py')).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 30_000 })
})
