// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * #1989: "Open in Shogo IDE" downloads the prebuilt Code - OSS server named
 * in the shipped manifest, starts it and opens the workbench, with progress
 * on the button and failures shown as a dialog. Needs a packaged app whose
 * manifest points at published assets (desktop-e2e.yml, release boot-smoke).
 *
 *   PLAYWRIGHT_E2E=1 SHOGO_E2E_EXECUTABLE=<Shogo.exe> npx playwright test \
 *     --config e2e/playwright.config.ts shogo-ide-open.spec.ts
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchPackagedApp, openFolderProjectIde, writeFixtureFolder, type PackagedApp } from './packaged-app'

test.skip(process.env.PLAYWRIGHT_E2E !== '1', 'set PLAYWRIGHT_E2E=1 to run')
test.describe.configure({ mode: 'serial' })
test.setTimeout(600_000)

const openButton = (page: Page) => page.getByRole('button', { name: 'Open in Shogo IDE' }).first()

/** Records every code-workbench:status phase the window receives. */
async function recordStatus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any
    w.__shogoIdePhases = []
    w.__shogoIdeUnsubscribe?.()
    w.__shogoIdeUnsubscribe = w.shogoDesktop.codeWorkbench.onStatus((s: { phase: string }) => w.__shogoIdePhases.push(s.phase))
  })
}

const phases = (page: Page) => page.evaluate(() => (window as any).__shogoIdePhases as string[])

/** Console output of each Shogo-IDE window, attached to the report if a test fails. */
const ideConsole = new Map<Page, string[]>()

async function expectWorkbench(ide: Page, timeoutMs: number): Promise<void> {
  try {
    await expect(ide.locator('.monaco-workbench')).toBeVisible({ timeout: timeoutMs })
  } catch (error) {
    const info = test.info()
    await info.attach('shogo-ide-console', { body: (ideConsole.get(ide) ?? []).join('\n') || '(no console output)', contentType: 'text/plain' })
    await info.attach('shogo-ide-window', { body: await ide.screenshot().catch(() => Buffer.from('')), contentType: 'image/png' })
    await info.attach('shogo-ide-html', { body: (await ide.content().catch(() => '')).slice(0, 20_000), contentType: 'text/html' })
    console.log(`Shogo-IDE window ${ide.url()} console:\n${(ideConsole.get(ide) ?? []).join('\n')}`)
    throw error
  }
}

/** The Shogo-IDE window: its URL carries the workspace `folder` (the token is stripped by a redirect). */
async function waitForIdeWindow(shogo: PackagedApp, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ide = shogo.app.windows().find((w) => {
      try {
        return new URL(w.url()).searchParams.has('folder')
      } catch {
        return false
      }
    })
    if (ide) {
      if (!ideConsole.has(ide)) {
        const lines: string[] = []
        ideConsole.set(ide, lines)
        ide.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`))
        ide.on('pageerror', (e) => lines.push(`[pageerror] ${e.message}`))
      }
      return ide
    }
    const dialog = shogo.page.getByRole('alertdialog')
    if (await dialog.count()) throw new Error(`Open in Shogo IDE failed: ${await dialog.first().innerText()}`)
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`no Shogo-IDE window within ${timeoutMs}ms (windows: ${shogo.app.windows().map((w) => w.url()).join(', ')})`)
}

test.describe('with the published server', () => {
  let shogo: PackagedApp
  let folder: string
  let installRoot: string

  test.beforeAll(async () => {
    // Hooks don't inherit test.setTimeout; a cold packaged launch needs more than the config default.
    test.setTimeout(420_000)
    folder = writeFixtureFolder('shogo-e2e-ide-').folder
    installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-ide-install-'))
    shogo = await launchPackagedApp({ env: { SHOGO_IDE_SERVER_INSTALL_ROOT: installRoot } })
    await openFolderProjectIde(shogo.page, folder)
  })

  test.afterAll(async () => {
    await shogo?.close()
    fs.rmSync(folder, { recursive: true, force: true })
    fs.rmSync(installRoot, { recursive: true, force: true })
  })

  test('first open downloads the server and shows the workbench on the folder', async () => {
    const page = shogo.page
    await recordStatus(page)
    await openButton(page).click()
    const ide = await waitForIdeWindow(shogo, 540_000)
    await expectWorkbench(ide, 120_000)
    await expect(ide.locator('.explorer-folders-view .monaco-list-row', { hasText: 'README.md' }).first()).toBeVisible({ timeout: 120_000 })
    expect(await phases(page)).toEqual(expect.arrayContaining(['downloading', 'verifying', 'extracting', 'starting', 'ready']))
    // shogo-core is built in; Copilot is removed from the build.
    await expect(ide.getByRole('tab', { name: /Shogo Chat/ }).or(ide.getByLabel(/Shogo Chat/)).first()).toBeVisible({ timeout: 60_000 })
    await expect(ide.getByLabel(/Copilot/i)).toHaveCount(0)
    await expect(openButton(page)).toHaveText('Open in Shogo IDE')
    await ide.close()
  })

  test('reopening is fast and does not download again', async () => {
    const page = shogo.page
    await recordStatus(page)
    const started = Date.now()
    await openButton(page).click()
    const ide = await waitForIdeWindow(shogo, 60_000)
    await expectWorkbench(ide, 60_000)
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(await phases(page)).not.toContain('downloading')
    await ide.close()
  })
})

test.describe('when the server cannot be downloaded', () => {
  let shogo: PackagedApp
  let folder: string
  let installRoot: string

  test.beforeAll(async () => {
    test.setTimeout(420_000)
    folder = writeFixtureFolder('shogo-e2e-ide-fail-').folder
    installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-ide-install-empty-'))
    shogo = await launchPackagedApp({
      env: { SHOGO_IDE_SERVER_BASE_URL: 'http://127.0.0.1:9/', SHOGO_IDE_SERVER_INSTALL_ROOT: installRoot },
    })
    await openFolderProjectIde(shogo.page, folder)
  })

  test.afterAll(async () => {
    await shogo?.close()
    fs.rmSync(folder, { recursive: true, force: true })
    fs.rmSync(installRoot, { recursive: true, force: true })
  })

  test('the failure is shown as a dialog with Open log, Retry and Close', async () => {
    const page = shogo.page
    await openButton(page).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible({ timeout: 120_000 })
    await expect(dialog).toContainText('Could not open Shogo IDE')
    for (const name of ['Close', 'Open log', 'Retry']) await expect(dialog.getByRole('button', { name })).toBeVisible()
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(openButton(page)).toBeEnabled()
  })
})
