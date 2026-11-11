// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Launch a PACKAGED Shogo (SHOGO_E2E_EXECUTABLE = Shogo.exe or
 * Shogo.app/Contents/MacOS/Shogo) with a fresh profile, sign in locally and
 * open folder projects. Falls back to the dev Electron app in apps/desktop
 * when SHOGO_E2E_EXECUTABLE is unset. Used by desktop-e2e.yml and the release
 * boot-smoke jobs (#1989).
 */
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { mainAppWindow } from './electron-helpers'

const DESKTOP_DIR = path.resolve(__dirname, '..')

export interface PackagedApp {
  app: ElectronApplication
  page: Page
  apiUrl: string
  close(): Promise<void>
}

/** fetch() from inside the app window, so it carries the session cookie. */
export async function apiFetch<T = any>(page: Page, route: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ route, init }) => {
      const base = (window as any).shogoDesktop?.apiUrl as string
      const res = await fetch(`${base}${route}`, {
        method: init?.method ?? 'GET',
        credentials: 'include',
        headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      })
      const text = await res.text()
      let body: unknown = text
      try { body = JSON.parse(text) } catch { /* keep text */ }
      return { status: res.status, body }
    },
    { route, init },
  ) as Promise<{ status: number; body: T }>
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) })
      if (res.status < 500) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error(`${url} did not answer within ${timeoutMs}ms`)
}

export async function launchPackagedApp(opts: { env?: Record<string, string> } = {}): Promise<PackagedApp> {
  const packaged = process.env.SHOGO_E2E_EXECUTABLE
  const executablePath = packaged || (require(require.resolve('electron', { paths: [DESKTOP_DIR] })) as unknown as string)
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-packaged-e2e-'))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  delete env.SHOGO_SKIP_LOCAL_SERVER

  const app = await electron.launch({
    executablePath,
    args: [...(packaged ? [] : ['.']), `--user-data-dir=${userData}`],
    cwd: packaged ? path.dirname(packaged) : DESKTOP_DIR,
    env: { ...env, SHOGO_E2E: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', ...opts.env },
    timeout: 180_000,
  })
  const close = async () => {
    try { await app.close() } catch { /* already closed */ }
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* files still locked */ }
  }
  try {
    const page = await mainAppWindow(app, 180_000)
    await page.waitForLoadState('domcontentloaded')
    await expect.poll(() => page.evaluate(() => (window as any).shogoDesktop?.apiUrl ?? ''), { timeout: 60_000 }).not.toBe('')
    const apiUrl = await page.evaluate(() => (window as any).shogoDesktop.apiUrl as string)
    await waitForHttp(`${apiUrl}/api/config`, 240_000)
    const signIn = await apiFetch(page, '/api/local/auto-sign-in', { method: 'POST' })
    if (signIn.status >= 400) throw new Error(`auto-sign-in failed: ${JSON.stringify(signIn.body)}`)
    await apiFetch(page, '/api/onboarding/complete', { method: 'POST' })
    return { app, page, apiUrl, close }
  } catch (err) {
    await close()
    throw err
  }
}

/**
 * A folder shaped like the one in #1989: dot-entries that sort first, a
 * `.git` worktree pointer file, `src/nested`, and 200 plain files. Linked
 * folders must live under the home directory.
 */
export function writeFixtureFolder(prefix: string): { folder: string; names: string[] } {
  const folder = fs.mkdtempSync(path.join(os.homedir(), prefix))
  fs.writeFileSync(path.join(folder, 'README.md'), '# Shogo e2e\n')
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(folder, `.dot-file-${i}`), 'x')
  for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(folder, `.dot-dir-${i}`))
  fs.writeFileSync(path.join(folder, '.git'), 'gitdir: ../.git/modules/e2e\n')
  fs.mkdirSync(path.join(folder, 'src', 'nested'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'src', 'nested', 'file.ts'), 'export const x = 1\n')
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(folder, `file-${String(i).padStart(3, '0')}.py`), 'x = 1\n')
  return { folder, names: fs.readdirSync(folder) }
}

/** Opens `folder` as a trusted project and shows its IDE tab. */
export async function openFolderProjectIde(page: Page, folder: string): Promise<string> {
  const created = await apiFetch<any>(page, '/api/local/projects/from-folders', {
    method: 'POST',
    body: { paths: [folder], acceptedGitRoot: false },
  })
  const project = created.body?.project ?? created.body
  if (!project?.id) throw new Error(`opening ${folder} failed (${created.status}): ${JSON.stringify(created.body).slice(0, 300)}`)
  await apiFetch(page, `/api/local/projects/${project.id}/trust`, { method: 'POST', body: { trusted: true } })
  await page.goto(new URL(`/projects/${encodeURIComponent(project.id)}?tab=ide`, page.url()).toString(), { waitUntil: 'domcontentloaded' })
  const explorer = page.getByLabel('Explorer', { exact: true }).first()
  try {
    await expect(explorer).toBeVisible({ timeout: 120_000 })
  } catch {
    await page.getByTestId('project-tab-ide').first().click()
    await expect(explorer).toBeVisible({ timeout: 120_000 })
  }
  return project.id as string
}

export function explorerRow(page: Page, name: string) {
  return page.getByLabel('Explorer', { exact: true }).first().getByText(name, { exact: true }).first()
}
