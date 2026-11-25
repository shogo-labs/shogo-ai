// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Playwright-Electron e2e for the menu-bar dropdown (SHO-555).
 *
 * Drives the real path: the renderer publishes a model over the
 * `shogoDesktop.trayUpdate` bridge, main validates it and builds the actual
 * menu template, and the tray's own flattening is read back through the
 * `shogoTesting` hook. Clicking a row goes through the same handler a person's
 * click does, so the assertion is the app navigating to that chat.
 *
 * The API is mocked (`installMinimalMockLocalApi`) for the same reason the
 * update-channel spec mocks it: this spec is about the tray, not the backend.
 *
 * GUARDED: set PLAYWRIGHT_E2E=1 to run (matches the other apps/desktop specs).
 *
 * Run:
 *   cd apps/desktop
 *   npm run build
 *   PLAYWRIGHT_E2E=1 npx playwright test e2e/tray-menu.spec.ts
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mainAppWindow } from './electron-helpers'

const E2E_ENABLED = process.env.PLAYWRIGHT_E2E === '1'
test.skip(!E2E_ENABLED, 'set PLAYWRIGHT_E2E=1 to run')

const DESKTOP_DIR = path.resolve(__dirname, '..')

function ensureDesktopBuild(): void {
  const mainJs = path.join(DESKTOP_DIR, 'dist', 'main.js')
  if (fs.existsSync(mainJs)) return
  const { spawnSync } = require('child_process') as typeof import('child_process')
  const result = spawnSync('npm', ['run', 'build'], { cwd: DESKTOP_DIR, stdio: 'inherit' })
  if (result.status !== 0) throw new Error('apps/desktop build failed')
}

async function installMinimalMockLocalApi(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

    if (url.pathname === '/api/config') {
      return json({
        localMode: true,
        needsSetup: true,
        shogoKeyConnected: false,
        features: {
          billing: false, admin: false, oauth: false, analytics: true,
          publishing: false, marketplace: false, ezMode: true, phoneChannel: false,
        },
      })
    }
    if (url.pathname.startsWith('/api/auth/')) return json({ data: null, ok: true })
    if (url.pathname === '/api/local/auto-sign-in') return json({ ok: true })
    if (url.pathname === '/api/local/cloud-login/status') return json({ signedIn: false })
    if (url.pathname === '/api/local/api-keys') return json({ keys: {} })
    if (url.pathname === '/api/me') return json({ data: { onboardingCompleted: false } })
    return json({ ok: true })
  })
}

function resolveElectronExecutable(): string {
  const electronEntry = require.resolve('electron', { paths: [DESKTOP_DIR] })
  const electronModule = require(electronEntry) as unknown as string
  if (typeof electronModule !== 'string') throw new Error('could not resolve electron executable')
  return electronModule
}

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: resolveElectronExecutable(),
    args: ['.', `--user-data-dir=${userDataDir}`, '--api-port=39178', '--no-sandbox', '--disable-gpu'],
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      SHOGO_SKIP_LOCAL_SERVER: 'true',
      // Preload gates the `shogoTesting` bridge (and main its tray debug IPC) on
      // the literal '1', not any truthy string.
      SHOGO_E2E: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    timeout: 60_000,
  })
  // Not `firstWindow()`: the island window opens at the same moment and can
  // win the race, and this spec needs the window that publishes the model and
  // receives the navigation.
  const page = await mainAppWindow(app)
  await installMinimalMockLocalApi(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => typeof (window as any).shogoDesktop?.trayUpdate === 'function',
    undefined,
    { timeout: 30_000 },
  )
  return { app, page }
}

/** One row, in the shape apps/mobile/lib/desktop-tray.ts publishes. */
function row(overrides: Record<string, unknown>) {
  return {
    sessionId: 'ws-1',
    projectId: null,
    title: 'Workspace chat',
    status: null,
    path: '/(app)/agent?chatSessionId=ws-1',
    ...overrides,
  }
}

async function publishModel(page: Page, model: Record<string, unknown>): Promise<void> {
  await page.evaluate((payload) => (window as any).shogoDesktop.trayUpdate(payload), model)
}

async function trayMenu(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).shogoTesting.getTrayMenu())
}

test.describe('menu-bar dropdown', () => {
  let tmpUserData: string

  test.beforeAll(() => {
    ensureDesktopBuild()
  })

  test.beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-tray-e2e-'))
  })

  test.afterEach(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test('lists pinned chats, agent sections with dots, and the actions', async () => {
    const { app, page } = await launchApp(tmpUserData)
    try {
      await publishModel(page, {
        pinned: [row({ sessionId: 'pin-1', title: 'Pinned chat', status: 'new' })],
        groups: [
          {
            title: 'Shogo Dev 5',
            rows: [
              row({
                sessionId: 'p-1',
                projectId: 'proj-1',
                title: 'Card work',
                status: 'needs_you',
                path: '/(app)/projects/proj-1?chatSessionId=p-1',
              }),
              row({ sessionId: 'run-1', title: 'Running chat', status: 'running' }),
            ],
          },
        ],
        recent: [],
        attentionCount: 0,
        canClear: false,
      })

      // The menu is rebuilt from the validated model, so poll until main has
      // handled the publish rather than racing it.
      await expect
        .poll(async () => (await trayMenu(page)).slice(0, 5), { timeout: 15_000 })
        .toEqual(['- Pinned (disabled)', '- Pinned chat', '- ---', '- Shogo Dev 5 (disabled)', '- Card work'])

      const menu = await trayMenu(page)
      expect(menu).toContain('- Running chat')
      expect(menu).toContain('- New Chat')
      expect(menu).toContain('- Open Shogo')
      expect(menu).toContain('- Show Count [x]')
      expect(menu).toContain('- Settings')
      expect(menu).toContain('- Quit Shogo')
      // Local mode: the meeting controls live under Meetings.
      expect(menu).toContain('- Meetings')
      expect(menu).toContain('-- Start Recording')
    } finally {
      await app.close()
    }
  })

  test('a model with nothing to report falls back to the recent chats', async () => {
    const { app, page } = await launchApp(tmpUserData)
    try {
      await publishModel(page, {
        pinned: [],
        groups: [],
        recent: [row({ sessionId: 'r-1', title: 'Just a chat' })],
        attentionCount: 0,
        canClear: false,
      })
      await expect
        .poll(async () => (await trayMenu(page)).slice(0, 2), { timeout: 15_000 })
        .toEqual(['- Recent (disabled)', '- Just a chat'])
    } finally {
      await app.close()
    }
  })

  test('clicking a row opens that chat', async () => {
    const { app, page } = await launchApp(tmpUserData)
    try {
      await publishModel(page, {
        pinned: [row({ sessionId: 'ws-9', title: 'Open me' })],
        groups: [],
        recent: [],
        attentionCount: 0,
        canClear: false,
      })
      await expect.poll(async () => (await trayMenu(page)).length, { timeout: 15_000 }).toBeGreaterThan(4)

      const clicked = await page.evaluate(() => (window as any).shogoTesting.clickTrayItem('Open me'))
      expect(clicked).toBe(true)

      // No window has that session, so the tray navigates the primary window to
      // the row's own route instead.
      await expect
        .poll(async () => page.evaluate(() => window.location.search), { timeout: 15_000 })
        .toContain('chatSessionId=ws-9')
    } finally {
      await app.close()
    }
  })
})
