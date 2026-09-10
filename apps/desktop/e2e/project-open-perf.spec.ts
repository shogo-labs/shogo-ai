/**
 * Packaged/desktop renderer timing capture for project opens.
 *
 * This is opt-in because it needs a real local desktop database and a project
 * id. It does not assert the strict budgets yet; it records the full UI mark
 * stream so the headless benchmark and renderer timings can be compared.
 *
 *   PLAYWRIGHT_E2E=1 SHOGO_PERF_E2E_PROJECT_ID=<id> \
 *     npx playwright test --config apps/desktop/e2e/playwright.config.ts \
 *     e2e/project-open-perf.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import path from 'path'
import os from 'os'

const enabled =
  process.env.PLAYWRIGHT_E2E === '1' &&
  Boolean(process.env.SHOGO_PERF_E2E_PROJECT_ID)
const desktopDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(desktopDir, '..', '..')

test.describe('desktop project open performance', () => {
  test.skip(!enabled, 'set PLAYWRIGHT_E2E=1 and SHOGO_PERF_E2E_PROJECT_ID')
  test.setTimeout(180_000)

  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const electronEntry = require.resolve('electron', { paths: [desktopDir] })
    const electronModule = require(electronEntry) as unknown as string
    const executablePath = typeof electronModule === 'string' ? electronModule : undefined
    expect(executablePath).toBeTruthy()

    app = await electron.launch({
      executablePath,
      args: [
        '.',
        `--user-data-dir=${os.tmpdir()}/shogo-perf-${Date.now()}`,
        '--no-sandbox',
      ],
      cwd: desktopDir,
      env: {
        ...process.env,
        SHOGO_E2E: 'true',
        SHOGO_PERF_LOG: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      timeout: 60_000,
    })
    page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await app?.close().catch(() => {})
  })

  test('records existing project cold/warm marks', async () => {
    const projectId = process.env.SHOGO_PERF_E2E_PROJECT_ID!
    const pathWithQuery = `/(app)/projects/${encodeURIComponent(projectId)}`

    await app.evaluate(({ BrowserWindow }, route) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('desktop window was not created')
      void window.loadURL(`shogo://app${route}`)
    }, pathWithQuery)

    await page.waitForFunction(() => {
      const marks = (globalThis as any).__shogoColdStart__?.getMarks?.() || []
      return marks.some((mark: any) => mark.id === 'project:runtime-ready')
    }, undefined, { timeout: 90_000 })

    const marks = await page.evaluate(() =>
      (globalThis as any).__shogoColdStart__?.getMarks?.() || [],
    )
    expect(marks.some((mark: any) => mark.id === 'project:runtime-ready')).toBeTruthy()

    const outputDir = path.join(repoRoot, 'bench-results')
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })
    const output = path.join(outputDir, `desktop-ui-${process.platform}-${Date.now()}.json`)
    writeFileSync(output, JSON.stringify({
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      projectId,
      marks,
    }, null, 2))
    console.log(`Wrote ${output}`)
  })
})
