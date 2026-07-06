// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Electron E2E coverage for the desktop onboarding provider-discovery loop.
 *
 * The regression path is:
 * configured provider key → live model discovery fails → no models stored.
 * The UI must surface the failure once and stop auto-retrying; otherwise React
 * repeatedly updates state until it throws "Maximum update depth exceeded".
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const DESKTOP_DIR = path.resolve(__dirname, '..')

function ensureDesktopBuild(): void {
  const mainJs = path.join(DESKTOP_DIR, 'dist', 'main.js')
  if (fs.existsSync(mainJs)) return
  const { spawnSync } = require('child_process') as typeof import('child_process')
  const result = spawnSync('npx', ['tsc'], { cwd: DESKTOP_DIR, stdio: 'inherit' })
  if (result.status !== 0) throw new Error('apps/desktop tsc build failed')
}

async function installMockLocalApi(page: Page): Promise<{ getProviderCalls: () => number }> {
  let providerModelCalls = 0

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const pathname = url.pathname

    const json = async (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })

    if (pathname === '/api/config') {
      return json({
        localMode: true,
        needsSetup: true,
        shogoKeyConnected: false,
        features: {
          billing: false,
          admin: false,
          oauth: false,
          analytics: true,
          publishing: false,
          marketplace: false,
          ezMode: true,
          phoneChannel: false,
        },
      })
    }

    if (pathname.startsWith('/api/auth/')) {
      return json({ data: null, ok: true })
    }

    if (pathname === '/api/local/auto-sign-in') return json({ ok: true })
    if (pathname === '/api/local/cloud-login/status') return json({ signedIn: false })
    if (pathname === '/api/local/api-keys') return json({ keys: { openai: 'sk-***' } })

    if (pathname === '/api/admin/settings/providers/openai/models') {
      providerModelCalls += 1
      return json({ error: 'unauthorized' }, 401)
    }

    if (pathname === '/api/auth/update-user') return json({ ok: true })
    if (pathname === '/api/me') return json({ data: { onboardingCompleted: false } })
    if (pathname === '/api/onboarding/complete') return json({ ok: true })
    if (pathname === '/api/vm/image/status') return json({ imagesPresent: true })

    return json({ ok: true })
  })

  return { getProviderCalls: () => providerModelCalls }
}

test('desktop onboarding stops provider model auto-discovery after a failed request', async () => {
  ensureDesktopBuild()

  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-provider-discovery-e2e-'))
  let app: ElectronApplication | null = null

  const rendererErrors: string[] = []
  const consoleErrors: string[] = []

  try {
    const electronEntry = require.resolve('electron', { paths: [DESKTOP_DIR] })
    const electronModule = require(electronEntry) as unknown as string
    const executablePath = typeof electronModule === 'string' ? electronModule : undefined
    expect(executablePath, 'could not resolve electron executable').toBeTruthy()

    app = await electron.launch({
      executablePath,
      args: ['.', `--user-data-dir=${tmpUserData}`, '--api-port=39100', '--no-sandbox'],
      cwd: DESKTOP_DIR,
      env: {
        ...process.env,
        SHOGO_SKIP_LOCAL_SERVER: 'true',
        SHOGO_E2E: 'true',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      timeout: 60_000,
    })

    const page = await app.firstWindow({ timeout: 60_000 })
    page.on('pageerror', (err) => rendererErrors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    const api = await installMockLocalApi(page)
    await page.reload({ waitUntil: 'domcontentloaded' })

    await expect(page.getByPlaceholder('Your name')).toBeVisible({ timeout: 30_000 })
    await page.getByPlaceholder('Your name').fill('E2E User')
    await page.getByPlaceholder('Your name').press('Enter')

    await expect(page.getByText('Your Own API Keys')).toBeVisible({ timeout: 30_000 })
    await page.getByText('Your Own API Keys').click()

    await expect(page.getByText('unauthorized')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => api.getProviderCalls(), { timeout: 5_000 }).toBe(1)
    await page.waitForTimeout(1_500)

    expect(api.getProviderCalls()).toBe(1)
    expect(rendererErrors.join('\n')).not.toContain('Maximum update depth exceeded')
    expect(consoleErrors.join('\n')).not.toContain('Maximum update depth exceeded')
  } finally {
    try { await app?.close() } catch { /* ignore */ }
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})
