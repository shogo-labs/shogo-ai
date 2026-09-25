// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test, type Page, type Route } from '@playwright/test'

/**
 * Proves the workspace shell does not paint the team layout and then swap.
 *
 * The workspaces list is held in flight. With no cached kind, the shell must
 * show the skeleton and must never show the team home subtitle. With a cached
 * personal kind, personal nav must be visible before that response returns.
 *
 *   SHOGO_LOCAL_MODE=true bun run api:dev
 *   EXPO_PUBLIC_API_PORT=8002 bun run web:dev
 *   npx playwright test --config e2e/local/playwright.config.ts workspace-chrome-stability
 */

const API_BASE = process.env.E2E_API_URL || process.env.STAGING_API_URL || 'http://localhost:8002'
const TEAM_SUBTITLE = 'This is a Team workspace'

type WorkspaceRow = { id: string; kind?: string; name?: string }

async function signInAndPersonalWorkspace(page: Page): Promise<WorkspaceRow> {
  await page.goto('/')
  await page.waitForTimeout(1500)
  await page.evaluate(async (apiBase) => {
    await fetch(`${apiBase}/api/onboarding/complete`, {
      method: 'POST',
      credentials: 'include',
    }).catch(() => undefined)
  }, API_BASE)

  const personal = await page.evaluate(async (apiBase) => {
    const res = await fetch(`${apiBase}/api/workspaces`, { credentials: 'include' })
    const body = await res.json()
    const items = (body?.items ?? body?.data?.items ?? []) as WorkspaceRow[]
    return items.find((workspace) => workspace.kind === 'personal') ?? null
  }, API_BASE)
  expect(personal?.id, 'local auto-sign-in did not yield a personal workspace').toBeTruthy()
  return personal!
}

function installFlashRecorder(page: Page) {
  return page.addInitScript((teamSubtitle: string) => {
    const hits: string[] = []
    const scan = () => {
      const text = document.body?.innerText ?? ''
      if (text.includes(teamSubtitle) && !hits.includes('team-subtitle')) hits.push('team-subtitle')
      const tasks = document.querySelector('[aria-label="Tasks"], [accessibilitylabel="Tasks"]')
      if (tasks && !hits.includes('tasks-nav')) hits.push('tasks-nav')
    }
    const start = () => {
      scan()
      new MutationObserver(scan).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    }
    if (document.documentElement) start()
    else document.addEventListener('DOMContentLoaded', start)
    ;(window as unknown as { __chromeFlashes: string[] }).__chromeFlashes = hits
  }, TEAM_SUBTITLE)
}

async function holdWorkspaceList(page: Page, personal: WorkspaceRow): Promise<() => void> {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/workspaces**', async (route: Route) => {
    const url = new URL(route.request().url())
    const isList = route.request().method() === 'GET' && /\/api\/workspaces\/?$/.test(url.pathname)
    if (!isList) {
      await route.continue()
      return
    }
    await gate
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, items: [personal] }),
    })
  })
  return release
}

function skeleton(page: Page) {
  return page.locator(
    '[data-testid="sidebar-chrome-skeleton"], [data-testid="home-chrome-skeleton"], [testid="sidebar-chrome-skeleton"], [testid="home-chrome-skeleton"]',
  )
}

test.describe('workspace chrome does not pop between team and personal', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    page.setDefaultNavigationTimeout(90_000)
    page.setDefaultTimeout(30_000)
  })

  test('cold load shows a skeleton and never the team shell', async ({ page }) => {
    test.setTimeout(180_000)
    const personal = await signInAndPersonalWorkspace(page)
    await installFlashRecorder(page)
    await page.addInitScript((id: string) => {
      localStorage.setItem('shogo:active-workspace-id', id)
      localStorage.removeItem('shogo:active-workspace-kind')
    }, personal.id)
    const release = await holdWorkspaceList(page, personal)

    await page.goto('/(app)')
    await expect(skeleton(page).first()).toBeVisible()
    await expect(page.getByText(TEAM_SUBTITLE)).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __chromeFlashes: string[] }).__chromeFlashes)).toEqual([])

    release()
    await expect(page.getByRole('link', { name: 'Goals' })).toBeVisible()
    await expect(page.getByText(TEAM_SUBTITLE)).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __chromeFlashes: string[] }).__chromeFlashes)).toEqual([])
  })

  test('cached personal kind paints personal nav before workspaces return', async ({ page }) => {
    test.setTimeout(180_000)
    const personal = await signInAndPersonalWorkspace(page)
    await installFlashRecorder(page)
    await page.addInitScript((id: string) => {
      localStorage.setItem('shogo:active-workspace-id', id)
      localStorage.setItem('shogo:active-workspace-kind', JSON.stringify({ id, kind: 'personal' }))
    }, personal.id)
    const release = await holdWorkspaceList(page, personal)

    await page.goto('/(app)')
    await expect(page.getByRole('link', { name: 'Goals' })).toBeVisible()
    await expect(page.getByText(TEAM_SUBTITLE)).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __chromeFlashes: string[] }).__chromeFlashes)).toEqual([])

    release()
    await expect(page.getByRole('link', { name: 'Goals' })).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { __chromeFlashes: string[] }).__chromeFlashes)).toEqual([])
  })
})
