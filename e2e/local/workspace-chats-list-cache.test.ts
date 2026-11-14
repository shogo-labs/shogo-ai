// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-391 — Home's workspace-chats list paints from the device.
 *
 * Every visit to Home used to mount a fresh `WorkspaceChatsPanel`, which started
 * with `sessions = []` and `loading = true`: a "Loading…" flash and a full
 * `GET /api/workspaces/:id/sessions` on every click, plus a blank list whenever
 * that one request failed. These specs hold the card's acceptance criteria on
 * the real sidebar:
 *
 *   1. Leaving Home and coming back paints the same rows on the first frame
 *      (the panel never renders "Loading…").
 *   2. One Home click with a warm cache spends at most ONE `/sessions` request.
 *   3. A reload paints from the device before `/sessions` answers.
 *   4. With `/sessions` failing, the rows already on screen stay.
 *
 * Needs the local stack; `E2E_LOCAL_START_STACK=1` boots it.
 *
 *   npx playwright test --config e2e/local/playwright.config.ts \
 *     workspace-chats-list-cache --project chromium
 */
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { signInByApi } from "./team-nav-seed"

test.setTimeout(180_000)

/** A chat this spec seeded, so the list has rows that cannot come from anywhere else. */
const SEEDED = ["Cache E2E one", "Cache E2E two"]

/** `GET /api/workspaces/:id/sessions` — the list request, not `/sessions/primary`. */
const SESSIONS_PATH = /^\/api\/workspaces\/[^/]+\/sessions$/

async function personalWorkspaceId(page: Page): Promise<string> {
  const res = await page.request.get(`${LOCAL_API_BASE}/api/workspaces`)
  const json = await res.json()
  const items = (json?.items ?? json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
  const id = items.find((w) => w.kind === "personal")?.id
  if (!id) throw new Error(`local stack has no personal workspace: ${JSON.stringify(json)}`)
  return id
}

/** Count the list requests this page makes from now on. */
function countListRequests(page: Page): { reads: number } {
  const state = { reads: 0 }
  page.on("request", (request) => {
    if (request.method() !== "GET") return
    if (SESSIONS_PATH.test(new URL(request.url()).pathname)) state.reads += 1
  })
  return state
}

/**
 * Record every frame in which the chats panel shows "Loading…", from navigation
 * start. Installed with `addInitScript` so it also runs on a reload — a one-frame
 * flash counts, which is exactly what the card is about.
 */
async function watchChatsPanelLoaders(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as unknown as { __chatsLoaderFrames?: number }
    scope.__chatsLoaderFrames = 0
    const startedAt = Date.now()
    // A frame sweep rather than a mutation observer: React re-renders the label
    // into an existing node, which a `childList` observer never sees.
    const sweep = () => {
      const panel = document.querySelector('[data-testid="workspace-chats-panel"]')
      if (panel?.textContent?.includes("Loading…")) scope.__chatsLoaderFrames! += 1
      if (Date.now() - startedAt < 120_000) requestAnimationFrame(sweep)
    }
    requestAnimationFrame(sweep)
  })
}

async function loaderFrames(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __chatsLoaderFrames?: number }).__chatsLoaderFrames ?? -1,
  )
}

async function resetLoaderFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as unknown as { __chatsLoaderFrames?: number }).__chatsLoaderFrames = 0
  })
}

function chatsPanel(page: Page) {
  return page.getByTestId("workspace-chats-panel")
}

function rail(page: Page, name: RegExp) {
  return page.getByRole("navigation", { name: "Workspace tabs" }).getByRole("tab", { name })
}

function seededRow(page: Page) {
  return chatsPanel(page).getByRole("link", { name: `Chat: ${SEEDED[0]}` })
}

/** Wait until the device holds this workspace's list — the write is debounced. */
async function waitForCachedList(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((name) => {
          for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i) ?? ""
            if (!key.startsWith("shogo:workspace-chats:v1:")) continue
            if ((localStorage.getItem(key) ?? "").includes(name)) return true
          }
          return false
        }, SEEDED[0]),
      { timeout: 20_000, message: "the list must reach the device before a remount can paint it" },
    )
    .toBe(true)
}

test.describe("Home's workspace-chats list is cached on the device", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("coming back to Home paints the same rows at once, with one list request", async ({ page }) => {
    await watchChatsPanelLoaders(page)
    await signInByApi(page)
    const workspaceId = await personalWorkspaceId(page)
    for (const name of SEEDED) {
      const res = await page.request.post(
        `${LOCAL_API_BASE}/api/workspaces/${workspaceId}/sessions`,
        { data: { inferredName: name } },
      )
      expect(res.ok(), `seeding "${name}" failed: ${res.status()}`).toBe(true)
    }

    const requests = countListRequests(page)
    await page.goto("/")
    await expect(seededRow(page)).toBeVisible({ timeout: 90_000 })
    await waitForCachedList(page)

    // AC1 + AC3: away and back. The rows must be there before the list can ask,
    // and the panel may not flash its loader for a list it already holds.
    await resetLoaderFrames(page)
    const before = requests.reads
    await rail(page, /^More/).click()
    await expect(chatsPanel(page)).toHaveCount(0)
    await rail(page, /^Home/).click()
    await expect(seededRow(page)).toBeVisible({ timeout: 2_000 })
    // One click, one revalidation — never the 3–5 the panel, drawer, island and
    // landing chat used to fire between them.
    await expect.poll(() => requests.reads - before, { timeout: 10_000 }).toBeLessThanOrEqual(1)
    expect(await loaderFrames(page), "a warm remount may not show \"Loading…\"").toBe(0)
  })

  test("a reload paints from the device before the list request answers", async ({ page }) => {
    await watchChatsPanelLoaders(page)
    await signInByApi(page)
    await page.goto("/")
    await expect(seededRow(page)).toBeVisible({ timeout: 90_000 })
    await waitForCachedList(page)

    // Hold the next list answer, so anything on screen came from the device.
    let pending = true
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    await page.route(`**/api/workspaces/*/sessions`, async (route) => {
      if (route.request().method() !== "GET") return route.continue()
      if (!SESSIONS_PATH.test(new URL(route.request().url()).pathname)) return route.continue()
      pending = true
      await gate
      pending = false
      return route.continue()
    })

    await resetLoaderFrames(page)
    await page.reload()
    await expect
      .poll(() => pending, { timeout: 30_000, message: "the reload asks for the list" })
      .toBe(true)
    await expect(
      seededRow(page),
      "the rows are painted from the device, before /sessions answers",
    ).toBeVisible({ timeout: 5_000 })
    expect(await loaderFrames(page), "a cached list may not flash \"Loading…\"").toBe(0)
    release()
    await expect.poll(() => pending, { timeout: 30_000 }).toBe(false)
  })

  test("a failing list request keeps the rows that were already on screen", async ({ page }) => {
    await signInByApi(page)
    await page.goto("/")
    await expect(seededRow(page)).toBeVisible({ timeout: 90_000 })
    await waitForCachedList(page)

    // AC4: offline / a 500. One failed request used to wipe the list.
    await page.route(`**/api/workspaces/*/sessions`, async (route) => {
      if (route.request().method() !== "GET") return route.continue()
      if (!SESSIONS_PATH.test(new URL(route.request().url()).pathname)) return route.continue()
      return route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
    })

    await rail(page, /^More/).click()
    await expect(chatsPanel(page)).toHaveCount(0)
    await rail(page, /^Home/).click()

    await expect(
      seededRow(page),
      "a failed refresh keeps the cached rows",
    ).toBeVisible({ timeout: 5_000 })
    await expect(chatsPanel(page).getByText("Loading…")).toHaveCount(0)
  })
})
