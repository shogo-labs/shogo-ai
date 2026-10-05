// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Playwright-Electron e2e for the desktop permission + dictation IPC surface
 * that the onboarding "computer use / files and apps / dictation" steps and the
 * "Computer and files" settings tab sit on top of:
 *
 *   window.shogoDesktop.permissions.{getStatus,listLocalApps,request,openSettings}
 *   window.shogoDesktop.dictation.{getConfig,setConfig,getHotkeyState}
 *
 * It drives the bridge directly (same approach as update-channel.spec.ts)
 * rather than clicking the OS permission prompts, which need a human and a
 * signed build. The platform-specific parts only assert shape + invariants so
 * the spec is meaningful on CI (Linux) and on a developer's Mac. Real TCC
 * prompts and the Fn key helper must be verified by hand on a signed build.
 *
 * GUARDED: set PLAYWRIGHT_E2E=1 to run.
 *
 *   cd apps/desktop
 *   PLAYWRIGHT_E2E=1 npx playwright test --config e2e/playwright.config.ts e2e/permissions-dictation.spec.ts
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { E2E_API_PORT, mainAppWindow } from './electron-helpers'

test.skip(process.env.PLAYWRIGHT_E2E !== '1', 'set PLAYWRIGHT_E2E=1 to run')

const DESKTOP_DIR = path.resolve(__dirname, '..')
const KINDS = ['accessibility', 'screen', 'fullDisk', 'mic'] as const
const STATES = ['granted', 'denied', 'not-determined', 'unsupported']

function ensureDesktopBuild(): void {
  if (fs.existsSync(path.join(DESKTOP_DIR, 'dist', 'main.js'))) return
  const { spawnSync } = require('child_process') as typeof import('child_process')
  const result = spawnSync('npm', ['run', 'build'], { cwd: DESKTOP_DIR, stdio: 'inherit' })
  if (result.status !== 0) throw new Error('apps/desktop build failed')
}

function resolveElectronExecutable(): string {
  const electronModule = require('electron') as unknown
  if (typeof electronModule !== 'string') throw new Error('could not resolve electron executable')
  return electronModule
}

let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  ensureDesktopBuild()
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-perms-e2e-'))
  app = await electron.launch({
    executablePath: resolveElectronExecutable(),
    args: ['.', `--user-data-dir=${userDataDir}`, `--api-port=${E2E_API_PORT}`, '--no-sandbox', '--disable-gpu'],
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      SHOGO_SKIP_LOCAL_SERVER: 'true',
      SHOGO_E2E: 'true',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    timeout: 60_000,
  })
  page = await mainAppWindow(app)
  await page.waitForFunction(() => !!(window as any).shogoDesktop?.permissions, undefined, { timeout: 30_000 })
})

test.afterAll(async () => {
  await app?.close().catch(() => {})
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('permissions.getStatus reports every kind with a known state', async () => {
  const status = await page.evaluate(() => (window as any).shogoDesktop.permissions.getStatus())
  for (const kind of KINDS) expect(STATES).toContain(status[kind])
  if (process.platform !== 'darwin') {
    expect(status.accessibility).toBe('unsupported')
    expect(status.screen).toBe('unsupported')
    expect(status.fullDisk).toBe('unsupported')
  }
})

test('permissions.listLocalApps lists the four supported apps', async () => {
  const apps = await page.evaluate(() => (window as any).shogoDesktop.permissions.listLocalApps())
  expect(apps.map((a: { id: string }) => a.id).sort()).toEqual(['mail', 'messages', 'notes', 'whatsapp'])
  for (const a of apps) expect(typeof a.installed).toBe('boolean')
  if (process.platform !== 'darwin') expect(apps.every((a: { installed: boolean }) => !a.installed)).toBe(true)
})

test('requesting an already-unsupported permission never opens Settings', async () => {
  test.skip(process.platform === 'darwin', 'would trigger real macOS prompts')
  const res = await page.evaluate(() => (window as any).shogoDesktop.permissions.request('screen'))
  expect(res.openedSettings).toBeFalsy()
})

test('dictation config defaults to Fn push-to-talk', async () => {
  const cfg = await page.evaluate(() => (window as any).shogoDesktop.dictation.getConfig())
  expect(cfg).toEqual({ pushToTalk: 'Fn', handsFree: null })
})

test('dictation.setConfig validates, normalizes and persists to config.json', async () => {
  const res = await page.evaluate(() =>
    (window as any).shogoDesktop.dictation.setConfig({ pushToTalk: 'Option+Space', handsFree: 'not a shortcut' }),
  )
  expect(res.ok).toBe(true)
  const saved = res.config
  expect(saved.pushToTalk).toBe('Option+Space')
  // Invalid hands-free value falls back to the previous (disabled) setting.
  expect(saved.handsFree).toBeNull()

  const reread = await page.evaluate(() => (window as any).shogoDesktop.dictation.getConfig())
  expect(reread.pushToTalk).toBe('Option+Space')

  const config = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))
  expect(config.dictation.pushToTalk).toBe('Option+Space')

  // Turning push-to-talk off keeps the rest of the config intact.
  const off = await page.evaluate(() => (window as any).shogoDesktop.dictation.setConfig({ pushToTalk: null }))
  expect(off.config.pushToTalk).toBeNull()
})

test('dictation.getHotkeyState exposes Fn availability', async () => {
  const state = await page.evaluate(() => (window as any).shogoDesktop.dictation.getHotkeyState())
  expect(typeof state.fnAvailable).toBe('boolean')
  if (process.platform !== 'darwin') expect(state.fnAvailable).toBe(false)
})
