// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type BrowserContext, type Page, type Locator } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"

/**
 * SHO-390 — one workspace per browser tab.
 *
 * Russell: "right now I can only have 1 workspace open at a time across
 * multiple tabs. I should be able to have a workspace open per tab in the
 * browser without them effecting each other."
 *
 * The active workspace used to live in `localStorage` (shared by every tab) and
 * `subscribeActiveWorkspaceId` wired a cross-tab `storage` listener, so a switch
 * in tab A wrote the new id and tab B re-read it: B's whole shell remounted into
 * A's workspace. It now lives in `sessionStorage`; `localStorage` holds only the
 * default a *new* tab starts from, written by a person's own switch and never by
 * an automatic fallback.
 *
 * Two pages of ONE browser context is the exact shape of the bug: they share
 * `localStorage` and have separate `sessionStorage`, just like two real tabs.
 * A separate context would have separate storage and could never reproduce it.
 *
 * Covered here (the parts a unit test cannot prove):
 *   1. switching in tab A leaves tab B on its own workspace, with no reload, no
 *      remount and its workspace-scoped requests still pointed at B's workspace;
 *   2. reloading tab B keeps tab B's workspace even though the shared default
 *      moved;
 *   3. a brand-new tab opens on the workspace a person last chose;
 *   4. a `?workspace=` link (SHO-284) moves only the tab it was opened in.
 *
 * The desktop island (a follower window that still tracks the shared default)
 * and "Duplicate tab" are covered by `apps/mobile/lib/__tests__/workspace-store.test.ts`:
 * neither is reachable from Playwright.
 *
 * Start the local stack first:
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 * or let Playwright boot it with `E2E_LOCAL_START_STACK=1`.
 *
 * Then:
 *   npx playwright test --config e2e/local/playwright.config.ts workspace-per-tab \
 *     --project chromium --retries 0
 */

const ID_KEY = "shogo:active-workspace-id"
/** Other-tab writes must not reach this tab; give any stray remount time to happen. */
const SETTLE_MS = Number(process.env.E2E_SHO390_SETTLE_MS || 4_000)

interface Workspace {
  id: string
  name: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Matches the trigger for *whichever* workspace happens to be active. */
function anyAccountTrigger(page: Page): Locator {
  return page.getByRole("button", { name: /— open account/ })
}

/**
 * The account menu trigger's accessible name is
 * `"${workspaceName}, ${userName} — open account"` — see
 * apps/mobile/components/layout/sidebar/AccountMenu.tsx.
 */
function accountTrigger(page: Page, workspaceName: string): Locator {
  return page.getByRole("button", {
    name: new RegExp(`^${escapeRegExp(workspaceName)}, .+ — open account`),
  })
}

/**
 * A cold `/` load can land with a secondary nav tab active and the account
 * trigger hidden (see `workspace-switch.test.ts`), so retry the navigation
 * until the trigger stays put instead of assuming a single load lands there.
 */
async function goHome(page: Page, attempts = 8): Promise<Locator> {
  const trigger = anyAccountTrigger(page)
  for (let i = 0; i < attempts; i++) {
    await page.goto("/")

    const menuButton = page.getByLabel("Open menu")
    if (await menuButton.isVisible().catch(() => false)) await menuButton.click()

    const appeared = await trigger.waitFor({ state: "visible", timeout: 3_000 }).then(
      () => true,
      () => false,
    )
    if (!appeared) continue

    await page.waitForTimeout(600)
    if (await trigger.isVisible().catch(() => false)) return trigger
  }
  throw new Error(`Account trigger never stayed visible after ${attempts} navigation attempts`)
}

/** gluestack's Popover trigger does not always answer a synthetic click. */
async function openAccountPopover(page: Page, trigger: Locator) {
  const popoverOpen = () => page.getByLabel("Sign in to Shogo Cloud").isVisible().catch(() => false)

  await trigger.click()
  await page.waitForTimeout(400)
  if (await popoverOpen()) return

  await trigger.dispatchEvent("pointerdown")
  await page.waitForTimeout(100)
  await trigger.dispatchEvent("pointerup")
  await page.waitForTimeout(400)
}

async function clickAndWaitForReload(page: Page, locator: Locator) {
  await Promise.all([page.waitForEvent("load", { timeout: 30_000 }), locator.click()])
}

/** Wide desktop (>=768px): switch via the sidebar's account popover. */
async function switchWorkspaceWide(page: Page, toName: string) {
  const trigger = await goHome(page)
  if (await accountTrigger(page, toName).isVisible().catch(() => false)) return

  await openAccountPopover(page, trigger)
  await expect(page.getByLabel("Sign in to Shogo Cloud")).toBeVisible({ timeout: 10_000 })
  await clickAndWaitForReload(page, page.getByLabel(toName, { exact: true }))
  await expect(accountTrigger(page, toName)).toBeVisible({ timeout: 30_000 })
}

/** The workspace id *this tab* owns — the value SHO-390 moved to sessionStorage. */
async function tabWorkspaceId(page: Page): Promise<string | null> {
  return page.evaluate((key) => sessionStorage.getItem(key), ID_KEY)
}

/** The shared default a new tab starts from. */
async function sharedWorkspaceId(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), ID_KEY)
}

async function apiJson<T>(page: Page, method: string, route: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`${LOCAL_API_BASE}${route}`, { method, data })
  const text = await res.text()
  if (!res.ok()) throw new Error(`${method} ${route} → HTTP ${res.status()}: ${text}`)
  return (text ? JSON.parse(text) : {}) as T
}

test.describe("SHO-390 — one workspace per browser tab", () => {
  test.describe.configure({ mode: "serial" })

  let context: BrowserContext
  let tabA: Page
  let tabB: Page
  let X: Workspace
  let Y: Workspace
  /** Created by this spec for the `?workspace=` case, deleted afterwards. */
  let Z: Workspace | null = null

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    context = await browser.newContext()
    tabA = await context.newPage()
    tabA.setDefaultTimeout(30_000)
    await tabA.setViewportSize({ width: 1280, height: 800 })

    const body = await apiJson<any>(tabA, "GET", "/api/workspaces")
    const items = (body?.items ?? body?.data?.items ?? body) as Array<{ id?: string; name?: string }>
    const workspaces = items.filter((w): w is Workspace => !!w?.id && !!w?.name)
    if (workspaces.length < 2) {
      throw new Error(
        `need two workspaces to prove per-tab isolation; /api/workspaces returned ${JSON.stringify(body).slice(0, 300)}`,
      )
    }
    ;[X, Y] = workspaces

    // Both tabs start in X, and X is the shared default a new tab would seed.
    await switchWorkspaceWide(tabA, X.name)
    await tabA.evaluate(
      ([id]) => localStorage.setItem("shogo:active-workspace-id", id),
      [X.id],
    )

    tabB = await context.newPage()
    tabB.setDefaultTimeout(30_000)
    await tabB.setViewportSize({ width: 1280, height: 800 })
    const triggerB = await goHome(tabB)
    await expect(triggerB).toBeVisible({ timeout: 30_000 })
    expect(await tabWorkspaceId(tabB)).toBe(X.id)
  })

  test.afterAll(async () => {
    if (Z) {
      // Test hygiene: the workspace this spec created must not outlive it. A
      // local instance is not billed, but the developer's DB is not ours.
      await apiJson(tabA, "DELETE", `/api/workspaces/${Z.id}`).catch((error) => {
        console.warn(`SHO-390: could not delete the created workspace ${Z!.name}: ${error}`)
      })
    }
    await context?.close()
  })

  test("switching in one tab leaves every other tab where it was", async () => {
    test.setTimeout(180_000)

    // Tab B must not reload when tab A switches. `__sho390Alive` survives a
    // re-render and dies with the document, so it answers "did this tab get
    // reloaded?" without depending on which navigation events the router emits.
    await tabB.evaluate(() => {
      ;(window as any).__sho390Alive = true
    })

    await switchWorkspaceWide(tabA, Y.name)

    // Tab A moved, and mirroring the person's choice is what makes it the
    // default for the next new tab.
    await expect.poll(() => tabWorkspaceId(tabA), { timeout: 30_000 }).toBe(Y.id)
    await expect(accountTrigger(tabA, Y.name)).toBeVisible({ timeout: 30_000 })
    expect(await sharedWorkspaceId(tabA)).toBe(Y.id)

    // Give a cross-tab write (the old bug) every chance to land before asserting.
    await tabB.waitForTimeout(SETTLE_MS)

    expect(await tabB.evaluate(() => (window as any).__sho390Alive)).toBe(true)
    expect(await tabWorkspaceId(tabB)).toBe(X.id)
    await expect(accountTrigger(tabB, X.name)).toBeVisible({ timeout: 30_000 })
  })

  test("reloading that tab keeps its own workspace, and its requests stay scoped to it", async () => {
    test.setTimeout(180_000)

    // Every workspace-scoped call the tab makes after the reload. The shell
    // reads `/api/workspaces/<id>/…` and collections read
    // `/api/projects?workspaceId=<id>`, so the id is in the URL either way.
    const scoped: string[] = []
    tabB.on("request", (request) => {
      const url = request.url()
      if (/\/api\/workspaces\/|[?&]workspaceId=/.test(url)) scoped.push(url)
    })

    const trigger = await goHome(tabB)
    await expect(trigger).toBeVisible({ timeout: 30_000 })

    expect(await tabWorkspaceId(tabB)).toBe(X.id)
    await expect(accountTrigger(tabB, X.name)).toBeVisible({ timeout: 30_000 })

    // A second load, at a route whose whole purpose is a workspace-scoped list,
    // so at least one scoped call is certain to have been made.
    await tabB.goto("/projects")
    await tabB.waitForLoadState("load")

    await expect
      .poll(() => scoped.filter((url) => url.includes(X.id)).length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0)
    expect(scoped.filter((url) => url.includes(Y.id))).toEqual([])
  })

  test("a brand-new tab opens on the workspace a person last chose", async () => {
    test.setTimeout(180_000)

    const tabC = await context.newPage()
    tabC.setDefaultTimeout(30_000)
    await tabC.setViewportSize({ width: 1280, height: 800 })
    try {
      const trigger = await goHome(tabC)
      await expect(trigger).toBeVisible({ timeout: 30_000 })

      // Y, chosen by a person in tab A — not X, which the other tab still holds.
      await expect.poll(() => tabWorkspaceId(tabC), { timeout: 30_000 }).toBe(Y.id)
      await expect(accountTrigger(tabC, Y.name)).toBeVisible({ timeout: 30_000 })
    } finally {
      await tabC.close()
    }
  })

  test("a ?workspace= link moves only the tab it was opened in (SHO-284)", async () => {
    test.setTimeout(240_000)

    // A third workspace, so "moved" and "did not move" cannot look the same.
    const created = await apiJson<any>(tabA, "POST", "/api/workspaces", {
      name: `QA per-tab ${Date.now()}`,
    })
    const workspace = created?.data ?? created?.workspace ?? created
    if (!workspace?.id) throw new Error(`workspace create returned no id: ${JSON.stringify(created)}`)
    Z = { id: workspace.id as string, name: String(workspace.name) }

    // Tab B is on X; the link names Z and must carry only tab B.
    await tabB.goto(`/projects?workspace=${Z.id}`)
    await expect.poll(() => tabWorkspaceId(tabB), { timeout: 30_000 }).toBe(Z.id)

    // Tab A was on Y and stays there: the link changed nothing in it.
    await tabA.waitForTimeout(SETTLE_MS)
    expect(await tabWorkspaceId(tabA)).toBe(Y.id)
    await expect(accountTrigger(tabA, Y.name)).toBeVisible({ timeout: 30_000 })
  })
})
