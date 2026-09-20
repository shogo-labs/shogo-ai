// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Playwright-Electron e2e coverage for the desktop beta update channel.
 *
 * Spins up a local mock feed server that speaks the exact wire protocol
 * `apps/desktop/src/update-channel.ts` + `updater.ts` already consume
 * (204 = up to date, JSON `{name,url,notes}` = update available) and points
 * BOTH channels at it via `SHOGO_UPDATE_FEED_BASE_URL` (see
 * `resolveFeedUrl()`'s override branch). This exercises the full real path:
 * `config.ts` persistence -> `update-channel.ts` feed resolution ->
 * `updater.ts` probe/IPC -> renderer status broadcast -> the
 * `UpdateBanner` component in `apps/mobile`.
 *
 * We drive channel switches through `window.shogoDesktop` directly (the
 * same pattern `notetaker.spec.ts` and `provider-discovery-loop.spec.ts`
 * use for their own IPC surfaces) rather than clicking Settings -> Updates
 * -> Beta: `UpdatesTab.tsx` is a thin wrapper over these exact IPC calls,
 * and getting there requires navigating past onboarding in a fully mocked
 * renderer, which would make this spec brittle for no extra coverage. The
 * IPC surface + banner render/persistence are what's worth covering
 * end-to-end; `UpdatesTab.tsx`'s own click-through UX is a plain React
 * component and out of scope here.
 *
 * Does NOT exercise an actual Squirrel download/install — that needs a
 * signed build (see the plan's Layer 4 manual dry run).
 *
 * GUARDED: set PLAYWRIGHT_E2E=1 to run (matches the other apps/desktop specs).
 *
 * Run:
 *   cd apps/desktop
 *   npx tsc   # if dist/main.js is stale
 *   PLAYWRIGHT_E2E=1 npx playwright test e2e/update-channel.spec.ts
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const E2E_ENABLED = process.env.PLAYWRIGHT_E2E === '1'
test.skip(!E2E_ENABLED, 'set PLAYWRIGHT_E2E=1 to run')

const DESKTOP_DIR = path.resolve(__dirname, '..')
const BETA_VERSION = '1.99.0-beta.20260101010101'

function ensureDesktopBuild(): void {
  const mainJs = path.join(DESKTOP_DIR, 'dist', 'main.js')
  if (fs.existsSync(mainJs)) return
  const { spawnSync } = require('child_process') as typeof import('child_process')
  // Plain `tsc` (as some older specs use) is not enough: fs-ipc.ts imports
  // `@shogo/agent-runtime/src/fs-tree-walker` by workspace source path, which
  // only resolves at runtime once `bundle:main` inlines it via `bun build`
  // (see the "//comment" in package.json). Run the same `build` script CI
  // and `npm run dev` use.
  const result = spawnSync('npm', ['run', 'build'], { cwd: DESKTOP_DIR, stdio: 'inherit' })
  if (result.status !== 0) throw new Error('apps/desktop build failed')
}

// ---------------------------------------------------------------------------
// Mock feed server — speaks the same protocol as update.electronjs.org /
// releases.shogo.ai's /desktop route: GET /<channel>/<platform>-<arch>/<v>
// -> 204 (up to date) or 200 JSON {name,url,notes} (update available).
// ---------------------------------------------------------------------------

interface MockFeed {
  port: number
  requests: string[]
  betaOffersUpdate: boolean
  reset(): void
  close(): Promise<void>
}

function startMockFeed(): Promise<MockFeed> {
  return new Promise((resolve, reject) => {
    const state = {
      requests: [] as string[],
      betaOffersUpdate: true,
    }

    const server = http.createServer((req, res) => {
      const url = req.url || ''
      state.requests.push(url)

      if (url.startsWith('/beta/') && state.betaOffersUpdate) {
        const body = JSON.stringify({
          name: BETA_VERSION,
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dl/fake-beta.zip`,
          notes: 'Test beta build for e2e',
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(body)
        return
      }

      // Stable is always "up to date" in this mock; beta is too once
      // `betaOffersUpdate` is flipped off (simulates a yanked release).
      res.writeHead(204)
      res.end()
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        port: address.port,
        get requests() { return state.requests },
        get betaOffersUpdate() { return state.betaOffersUpdate },
        set betaOffersUpdate(v: boolean) { state.betaOffersUpdate = v },
        reset() { state.requests = [] },
        close: () => new Promise((res2) => server.close(() => res2())),
      } as MockFeed)
    })
  })
}

async function waitForRequestMatching(feed: MockFeed, pattern: RegExp, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const match = feed.requests.find((r) => pattern.test(r))
    if (match) return match
    if (Date.now() >= deadline) {
      throw new Error(`no feed request matching ${pattern} within ${timeoutMs}ms; saw: ${JSON.stringify(feed.requests)}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

// ---------------------------------------------------------------------------
// Minimal renderer API mock — just enough that AuthProvider / ActiveInstance
// don't throw. UpdateBanner is mounted above the onboarding/auth Stack in
// apps/mobile/app/_layout.tsx, so we don't need to get past onboarding.
// ---------------------------------------------------------------------------

async function installMinimalMockLocalApi(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const pathname = url.pathname
    const json = (body: unknown, status = 200) => route.fulfill({
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
          billing: false, admin: false, oauth: false, analytics: true,
          publishing: false, marketplace: false, ezMode: true, phoneChannel: false,
        },
      })
    }
    if (pathname.startsWith('/api/auth/')) return json({ data: null, ok: true })
    if (pathname === '/api/local/auto-sign-in') return json({ ok: true })
    if (pathname === '/api/local/cloud-login/status') return json({ signedIn: false })
    if (pathname === '/api/local/api-keys') return json({ keys: {} })
    if (pathname === '/api/me') return json({ data: { onboardingCompleted: false } })
    if (pathname === '/api/onboarding/complete') return json({ ok: true })
    return json({ ok: true })
  })
}

function resolveElectronExecutable(): string {
  const electronEntry = require.resolve('electron', { paths: [DESKTOP_DIR] })
  const electronModule = require(electronEntry) as unknown as string
  if (typeof electronModule !== 'string') throw new Error('could not resolve electron executable')
  return electronModule
}

async function launchApp(userDataDir: string, feedPort: number): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: resolveElectronExecutable(),
    args: ['.', `--user-data-dir=${userDataDir}`, '--api-port=39177', '--no-sandbox', '--disable-gpu'],
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      SHOGO_SKIP_LOCAL_SERVER: 'true',
      SHOGO_E2E: 'true',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      // See main.ts near initAutoUpdater(): lets this spec exercise the real
      // updater IPC surface against an unpackaged dist/main.js build.
      SHOGO_UPDATER_E2E: '1',
      SHOGO_UPDATE_FEED_BASE_URL: `http://127.0.0.1:${feedPort}`,
    },
    timeout: 60_000,
  })

  const page = await app.firstWindow({ timeout: 60_000 })
  await installMinimalMockLocalApi(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => typeof (window as any).shogoDesktop?.getUpdateChannel === 'function',
    undefined,
    { timeout: 30_000 },
  )
  return { app, page }
}

async function getUpdateChannel(page: Page): Promise<string> {
  return page.evaluate(async () => (await (window as any).shogoDesktop.getUpdateChannel()).channel)
}

async function setUpdateChannel(
  page: Page,
  channel: 'stable' | 'beta',
): Promise<{ ok: boolean; channel?: string; error?: string }> {
  return page.evaluate((ch) => (window as any).shogoDesktop.setUpdateChannel(ch), channel)
}

async function getUpdateStatus(page: Page): Promise<{ status: string; availableVersion: string | null; releaseName: string | null; channel?: string }> {
  return page.evaluate(async () => (window as any).shogoDesktop.getUpdateStatus())
}

function readConfigJson(userDataDir: string): Record<string, unknown> | null {
  const configPath = path.join(userDataDir, 'config.json')
  if (!fs.existsSync(configPath)) return null
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('desktop update channel', () => {
  // The auto-updater only initializes on darwin/win32 (see
  // SUPPORTED_PLATFORMS in updater.ts) — nothing to test elsewhere.
  test.skip(process.platform !== 'darwin' && process.platform !== 'win32', 'auto-updater only initializes on darwin/win32')

  let feed: MockFeed
  let tmpUserData: string

  test.beforeAll(async () => {
    ensureDesktopBuild()
    feed = await startMockFeed()
  })

  test.afterAll(async () => {
    await feed.close()
  })

  test.beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-update-channel-e2e-'))
    feed.reset()
    feed.betaOffersUpdate = true
  })

  test.afterEach(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test('boots on the stable channel, probes /stable, and shows no banner', async () => {
    const { app, page } = await launchApp(tmpUserData, feed.port)
    try {
      await waitForRequestMatching(feed, /^\/stable\//)
      expect(await getUpdateChannel(page)).toBe('stable')
      await expect(page.getByTestId('shogo-update-banner')).toHaveCount(0)

      const config = readConfigJson(tmpUserData)
      if (config) expect(config.updateChannel).not.toBe('beta')
    } finally {
      await app.close()
    }
  })

  test('switching to beta probes /beta, shows the banner, and persists across relaunch', async () => {
    let app: ElectronApplication
    let page: Page
    ;({ app, page } = await launchApp(tmpUserData, feed.port))
    try {
      await waitForRequestMatching(feed, /^\/stable\//)

      const result = await setUpdateChannel(page, 'beta')
      expect(result.ok).toBe(true)
      expect(result.channel).toBe('beta')

      await waitForRequestMatching(feed, /^\/beta\//)

      const banner = page.getByTestId('shogo-update-banner')
      await expect(banner).toBeVisible({ timeout: 15_000 })
      await expect(banner).toContainText(BETA_VERSION)
      await expect(banner).toContainText('Beta')

      const config = readConfigJson(tmpUserData)
      expect(config?.updateChannel).toBe('beta')
    } finally {
      await app.close()
    }

    // Relaunch with the same userData dir — the channel should persist and
    // the very first probe on boot should hit /beta, not /stable.
    feed.reset()
    ;({ app, page } = await launchApp(tmpUserData, feed.port))
    try {
      expect(await getUpdateChannel(page)).toBe('beta')
      await waitForRequestMatching(feed, /^\/beta\//)
      await expect(page.getByTestId('shogo-update-banner')).toBeVisible({ timeout: 15_000 })
    } finally {
      await app.close()
    }
  })

  test('switching back to stable clears the banner and probes /stable', async () => {
    const { app, page } = await launchApp(tmpUserData, feed.port)
    try {
      await waitForRequestMatching(feed, /^\/stable\//)

      await setUpdateChannel(page, 'beta')
      await waitForRequestMatching(feed, /^\/beta\//)
      await expect(page.getByTestId('shogo-update-banner')).toBeVisible({ timeout: 15_000 })

      feed.reset()
      const result = await setUpdateChannel(page, 'stable')
      expect(result.ok).toBe(true)
      expect(result.channel).toBe('stable')

      await waitForRequestMatching(feed, /^\/stable\//)
      await expect(page.getByTestId('shogo-update-banner')).toHaveCount(0, { timeout: 15_000 })

      const config = readConfigJson(tmpUserData)
      expect(config?.updateChannel).toBe('stable')
    } finally {
      await app.close()
    }
  })

  test('a stale beta offer clears itself once the feed reports up to date', async () => {
    const { app, page } = await launchApp(tmpUserData, feed.port)
    try {
      await waitForRequestMatching(feed, /^\/stable\//)
      await setUpdateChannel(page, 'beta')
      await waitForRequestMatching(feed, /^\/beta\//)
      await expect(page.getByTestId('shogo-update-banner')).toBeVisible({ timeout: 15_000 })

      // Simulate the offered prerelease being yanked/pruned server-side.
      feed.betaOffersUpdate = false
      const check = await page.evaluate(() => (window as any).shogoDesktop.checkForUpdates())
      expect(check.ok).toBe(true)

      await expect(page.getByTestId('shogo-update-banner')).toHaveCount(0, { timeout: 15_000 })
    } finally {
      await app.close()
    }
  })

  test('set-update-channel is refused while a download is in progress (best-effort)', async () => {
    // Getting Squirrel into a real 'downloading' state deterministically
    // requires a signed build (see updater.ts's error handler — unsigned
    // dev/CI builds typically fail the code-signature check almost
    // immediately instead of downloading). We still exercise the real
    // download-update -> checkForUpdates() path and assert the guard
    // whenever the timing actually lands on 'downloading'; otherwise we
    // skip the assertion rather than flake. The channel-switch guard logic
    // itself has no other automated coverage, so this is worth attempting
    // rather than dropping entirely.
    const { app, page } = await launchApp(tmpUserData, feed.port)
    try {
      await waitForRequestMatching(feed, /^\/stable\//)
      await setUpdateChannel(page, 'beta')
      await waitForRequestMatching(feed, /^\/beta\//)
      await expect(page.getByTestId('shogo-update-banner')).toBeVisible({ timeout: 15_000 })

      await page.evaluate(() => (window as any).shogoDesktop.downloadUpdate())

      const deadline = Date.now() + 3_000
      let sawDownloading = false
      while (Date.now() < deadline) {
        const status = await getUpdateStatus(page)
        if (status.status === 'downloading') { sawDownloading = true; break }
        if (status.status !== 'available') break // already moved past downloading (error/ready)
        await new Promise((r) => setTimeout(r, 50))
      }

      if (!sawDownloading) {
        test.info().annotations.push({
          type: 'note',
          description: 'never observed status=downloading (expected on unsigned dev builds) — guard not exercised this run',
        })
        return
      }

      const result = await setUpdateChannel(page, 'stable')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('downloading')
    } finally {
      await app.close()
    }
  })
})
