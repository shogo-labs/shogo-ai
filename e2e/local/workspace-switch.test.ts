// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page, type Locator, type Request as PlaywrightRequest } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"

/**
 * Workspace switching — local/desktop E2E test.
 *
 * Local counterpart to `e2e/staging/workspace-switch.test.ts`. Both suites
 * exercise the same thing (switch between two workspaces and check the shell
 * follows), but local mode gets there differently:
 *
 *   - `bootstrapLocalDatabase` (apps/api/src/lib/local-bootstrap.ts) seeds the
 *     single local user with one free workspace of *each* kind up front — a
 *     `personal` one via the normal signup hook, and a `team` one via an
 *     explicit backfill — so any local DB, however old, has at least two
 *     workspaces to switch between without the test creating one.
 *   - Since SHO-43 a local user can also create workspaces themselves
 *     (`workspace-create.test.ts` covers that path); this spec deliberately
 *     still only switches between the seeded ones, so a failure here never
 *     leaves a workspace behind in the developer's DB.
 *
 * Workspace *names* aren't asserted — a pre-existing local DB may already
 * have owned a team (or extra personal) workspace under some other name
 * before the backfill shipped, in which case it correctly skips seeding a
 * redundant one rather than assuming `"${name} Team"`. This test instead
 * discovers whichever two workspaces are actually present and switches
 * between them, which both proves switching works and smoke-tests that the
 * account has at least two workspaces to switch between in the first place.
 *
 * Uses the sidebar's `AccountMenu` popover ("All workspaces" list), same as
 * the staging suite. Unlike staging, a cold `/` load here can land with a
 * secondary nav tab active (e.g. "Side chats") instead of "Home" — which
 * replaces the Home/Search/Meetings/... nav list with that tab's own
 * content in the same column and hides the account trigger. This looks
 * like a pre-existing timing race in the shell's default-tab selection
 * rather than anything about workspace switching itself, so `goHome`
 * retries the navigation (a handful of times, generously bounded) until
 * the trigger shows up instead of asserting on any single load.
 *
 * Local-mode auto-signs in — no login step needed (same assumption as
 * `chat-offline-resilience.test.ts`).
 *
 * Start the local stack first:
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *
 * Then:
 *   npx playwright test --config e2e/local/playwright.config.ts workspace-switch
 */

/** Matches the trigger for *whichever* workspace happens to be active. */
function anyAccountTrigger(page: Page): Locator {
  return page.getByRole("button", { name: /— open account/ })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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

/** See file header: retries a cold `/` load until the Home tab (and thus
 * the account trigger) is showing, rather than assuming any single load
 * lands there. */
async function goHome(page: Page, attempts = 8): Promise<Locator> {
  const trigger = anyAccountTrigger(page)
  for (let i = 0; i < attempts; i++) {
    await page.goto("/")

    // Narrow web (<768px) tucks the trigger behind the hamburger drawer,
    // same as the staging suite's `switchWorkspaceNarrow`.
    const menuButton = page.getByLabel("Open menu")
    if (await menuButton.isVisible().catch(() => false)) {
      await menuButton.click()
    }

    const appeared = await trigger.waitFor({ state: "visible", timeout: 3_000 }).then(
      () => true,
      () => false,
    )
    if (!appeared) continue

    // A post-mount redirect can swap the active nav tab (and hide the
    // trigger) shortly after first paint — reconfirm it's still there
    // before trusting it, instead of racing straight into a click.
    await page.waitForTimeout(600)
    const stillThere = await trigger.isVisible().catch(() => false)
    if (stillThere) return trigger
  }
  throw new Error(`Account trigger never stayed visible after ${attempts} navigation attempts`)
}

/**
 * gluestack's Popover trigger is a React Native Web Pressable that doesn't
 * always answer Playwright's synthetic click. Retry with raw pointer
 * events, then a direct DOM click, before giving up.
 */
async function openAccountPopover(page: Page, trigger: Locator) {
  const popoverOpen = () => page.getByLabel("Sign in to Shogo Cloud").isVisible().catch(() => false)

  await trigger.click()
  await page.waitForTimeout(400)
  if (await popoverOpen()) return

  await trigger.dispatchEvent("pointerdown")
  await page.waitForTimeout(100)
  await trigger.dispatchEvent("pointerup")
  await page.waitForTimeout(400)
  if (await popoverOpen()) return

  await trigger.evaluate((el: HTMLElement) => el.click())
  await page.waitForTimeout(400)
}

/**
 * All workspace names currently offered by the switcher. Workspace rows expose
 * their workspace name as an accessibility label; the cloud sign-in row is
 * skipped.
 */
async function listWorkspaceNames(page: Page): Promise<string[]> {
  const trigger = await goHome(page)
  await openAccountPopover(page, trigger)
  await expect(page.getByLabel("Sign in to Shogo Cloud")).toBeVisible({ timeout: 10_000 })

  const response = await page.request.get(`${LOCAL_API_BASE}/api/workspaces`)
  const body = await response.json()
  const items = (body?.items ?? body?.data?.items ?? []) as Array<{ name?: string }>
  const names = items.map((item) => item.name).filter((name): name is string => Boolean(name))

  await page.keyboard.press("Escape")
  return names
}

/**
 * `scheduleWorkspaceSwitch` (apps/mobile/lib/switch-workspace.ts) defers the
 * actual `window.location.reload()` behind a `setTimeout(0)` (to paint the
 * tap before reloading — see that file's header comment), so waiting for
 * `load` *after* `.click()` resolves can race a reload that hasn't started
 * yet. Attach the `load` listener first so it can't be missed.
 */
async function clickAndWaitForReload(page: Page, locator: Locator) {
  await Promise.all([page.waitForEvent("load", { timeout: 30_000 }), locator.click()])
}

/**
 * Wide desktop (>=768px): switch via the sidebar's account popover. A
 * no-op (no reload fires) if `toName` is already active — check via the
 * trigger's own name first rather than risking a hang on
 * `clickAndWaitForReload`.
 */
async function switchWorkspaceWide(page: Page, toName: string) {
  const trigger = await goHome(page)
  if (await accountTrigger(page, toName).isVisible().catch(() => false)) return

  await openAccountPopover(page, trigger)
  await expect(page.getByLabel("Sign in to Shogo Cloud")).toBeVisible({ timeout: 10_000 })

  await clickAndWaitForReload(page, page.getByLabel(toName, { exact: true }))
  await expect(accountTrigger(page, toName)).toBeVisible({ timeout: 30_000 })
}

/** Name of the workspace the client currently treats as active. */
async function activeWorkspaceName(page: Page): Promise<string | undefined> {
  return page.evaluate(async (apiBase) => {
    const id = localStorage.getItem("shogo:active-workspace-id")
    const res = await fetch(`${apiBase}/api/workspaces`, { credentials: "include" }).catch(() => null)
    const body = res ? await res.json().catch(() => null) : null
    const items = (body?.items ?? body?.data?.items ?? []) as Array<{ id: string; name: string }>
    return items.find((w) => w.id === id)?.name
  }, LOCAL_API_BASE)
}

/**
 * Narrow web (<768px): account and workspace switching live on the full-page
 * `/account` screen ("Workspaces" section, same `WorkspaceMenuSection` rows).
 * The personal shell's phone chrome has no account trigger (its menu button
 * opens chat sessions), so go to the screen directly.
 */
async function switchWorkspaceNarrow(page: Page, toName: string) {
  await page.goto("/account")
  await page.getByText("Workspaces", { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  if ((await activeWorkspaceName(page)) === toName) return

  await clickAndWaitForReload(page, page.getByText(toName, { exact: true }).first())
  await expect.poll(() => activeWorkspaceName(page), { timeout: 30_000 }).toBe(toName)
}

test.describe("Workspace switching (local mode)", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let WORKSPACE_A: string
  let WORKSPACE_B: string

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)
    page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 800 })

    // Sanity-check at least two workspaces exist — fails fast with a clear
    // assertion if `bootstrapLocalDatabase` hasn't backfilled the team
    // workspace (e.g. a local DB from before that change whose API server
    // hasn't rebooted yet). See file header for why names aren't asserted.
    const names = await listWorkspaceNames(page)
    expect(names.length).toBeGreaterThanOrEqual(2)
    ;[WORKSPACE_A, WORKSPACE_B] = names
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test("signed out of Shogo Cloud: rows are tagged Local, with a Sign in row", async () => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    const trigger = await goHome(page)
    await openAccountPopover(page, trigger)
    const localRows = page.getByText("Local", { exact: true })
    await expect(localRows.first()).toBeVisible({ timeout: 10_000 })
    expect(await localRows.count()).toBeGreaterThanOrEqual(2)
    await expect(page.getByText("Cloud", { exact: true })).toHaveCount(0)
    await expect(page.getByLabel("Sign in to Shogo Cloud")).toBeVisible()
    await page.keyboard.press("Escape")
  })

  test("wide desktop (1280×800): switches both directions via the account popover", async () => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1280, height: 800 })

    await switchWorkspaceWide(page, WORKSPACE_A)
    await switchWorkspaceWide(page, WORKSPACE_B)
    await switchWorkspaceWide(page, WORKSPACE_A)
  })

  test("wide desktop (1280×800): the switcher asks for workspace activity", async () => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1280, height: 800 })

    // "Working in N other workspaces" (Decision 3) is fed by
    // /api/workspaces/activity. The popover renders through a portal outside
    // SDKDomainProvider, so a context-only client silently skipped the request
    // and the badge never appeared on the surface this card is about (QA round
    // 2). Count the request rather than staging a live agent turn.
    const activityRequests: string[] = []
    const onRequest = (request: PlaywrightRequest) => {
      if (new URL(request.url()).pathname === "/api/workspaces/activity") {
        activityRequests.push(request.url())
      }
    }
    page.on("request", onRequest)
    try {
      const trigger = await goHome(page)
      await openAccountPopover(page, trigger)
      await expect(page.getByLabel("Sign in to Shogo Cloud")).toBeVisible({ timeout: 10_000 })
      await expect.poll(() => activityRequests.length, { timeout: 10_000 }).toBeGreaterThan(0)
    } finally {
      page.off("request", onRequest)
      await page.keyboard.press("Escape")
    }

    // …and the badge itself renders there. Staging a real agent turn in another
    // workspace is out of scope for a local spec, so answer the activity call
    // with one busy workspace and assert the label the user actually sees.
    await page.route("**/api/workspaces/activity", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          items: [{ workspaceId: "qa-other-workspace", inFlight: true }],
        }),
      }),
    )
    try {
      await page.goto("/")
      const trigger = await goHome(page)
      await openAccountPopover(page, trigger)
      await expect(page.getByLabel("Working in 1 other workspace")).toBeVisible({
        timeout: 15_000,
      })
    } finally {
      await page.unroute("**/api/workspaces/activity")
      await page.keyboard.press("Escape")
    }
  })

  test("narrow web (390×844): switches both directions via the /account screen", async () => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 390, height: 844 })

    await switchWorkspaceNarrow(page, WORKSPACE_B)
    await switchWorkspaceNarrow(page, WORKSPACE_A)
    await switchWorkspaceNarrow(page, WORKSPACE_B)
  })
})
