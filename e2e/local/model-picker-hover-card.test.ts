// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-480 — the composer's web model picker must keep its hover info card
 * beside the row it describes, including after the list is scrolled.
 *
 * The card used to be placed at `rowIndex * 32`: a guessed row height that also
 * ignored the ScrollView offset, so scrolling put the card below the hovered
 * row and, further down the list, below the menu entirely. The fix measures the
 * rows, the list viewport and the scroll offset; these checks are the ones that
 * fail on that geometry.
 *
 * The picker's model list is stubbed with a long catalog — the real local
 * catalog is short enough that the list never scrolls, which is why the drift
 * was invisible here. Everything else (composer, popover, hover, wheel) is the
 * real app.
 *
 * Needs the local stack; `E2E_LOCAL_START_STACK=1` boots it:
 *   npx playwright test --config e2e/local/playwright.config.ts model-picker-hover-card
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { writeActiveWorkspaceSelection } from "./helpers"

const API = process.env.E2E_API_URL || "http://localhost:8002"

/** Enough rows that the 340px list viewport really scrolls. */
const CATALOG_SIZE = 14

let workspaceId = ""
let projectId = ""

async function apiJson(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(`${API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    data: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status(), json }
}

/**
 * A long, deterministic catalog. The picker consumes `catalogModels` in order,
 * so `sortOrder` is what puts these rows on screen.
 */
function stubModelCatalog(page: Page) {
  const catalogModels = Array.from({ length: CATALOG_SIZE }, (_, index) => ({
    id: `sho480-model-${index}`,
    provider: "anthropic",
    displayName: `QA Model ${index}`,
    shortDisplayName: `QA${index}`,
    tier: "standard",
    family: "other",
    sortOrder: index,
    description: `Stub model ${index} used by the hover-card geometry check.`,
    contextWindow: 200_000,
  }))
  const body = JSON.stringify({ catalogIds: null, catalogModels, openrouterModels: [] })
  return Promise.all([
    page.route("**/api/platform/visible-models*", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 200, contentType: "application/json", body })
        : route.continue(),
    ),
    page.route("**/api/workspaces/*/visible-models*", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 200, contentType: "application/json", body })
        : route.continue(),
    ),
  ])
}

/** A project runtime needs the built template, which the local stack lacks. */
async function stubProjectRuntime(page: Page) {
  await page.route("**/api/projects/*/sandbox/url", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ready: true,
        status: "running",
        agentUrl: `${API}/stub-agent`,
        url: `${API}/stub-preview`,
        canvasBaseUrl: `${API}/stub-preview`,
      }),
    }),
  )
  await page.route("**/api/projects/*/agent-proxy/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  )
}

async function prepare(page: Page) {
  page.on("pageerror", (error) => console.log("PAGEERROR", (error as Error)?.stack ?? String(error)))
  await stubProjectRuntime(page)
  await stubModelCatalog(page)
  await page.goto("/")
  await page.getByRole("navigation", { name: "App sidebar" }).first().waitFor({ timeout: 120_000 })
  await page.evaluate(writeActiveWorkspaceSelection, [workspaceId, "team"] as const)
}

const modelRows = (page: Page) => page.locator('[data-testid^="model-option-"]')

const infoCard = (page: Page) => page.getByTestId("model-info-card")

const listViewport = (page: Page) => page.getByTestId("model-picker-scroll")

/**
 * Click the trigger in whichever way this panel accepts. The shell mounts a
 * chat panel per open chat at the same coordinates, so a real click can land on
 * a sibling panel painted on top; `dispatchEvent` reaches the trigger itself.
 */
async function clickTrigger(trigger: Locator) {
  const modes: Array<() => Promise<void>> = [
    () => trigger.click({ timeout: 5_000 }),
    () => trigger.click({ force: true, timeout: 5_000 }),
    () => trigger.dispatchEvent("click"),
    async () => {
      await trigger.dispatchEvent("pointerdown")
      await trigger.dispatchEvent("pointerup")
      await trigger.dispatchEvent("click")
    },
  ]
  for (const mode of modes) {
    if (await modelRows(trigger.page()).first().isVisible().catch(() => false)) return
    await mode().catch(() => {})
    if (await modelRows(trigger.page()).first().isVisible({ timeout: 3_000 }).catch(() => false)) return
  }
}

async function openPicker(page: Page) {
  await page.goto(`/projects/${projectId}`)
  await page
    .getByRole("textbox", { name: "Chat message input" })
    .first()
    .waitFor({ state: "visible", timeout: 120_000 })

  const triggers = page.getByRole("button", { name: "Choose model" })
  await triggers.first().waitFor({ state: "visible", timeout: 60_000 })
  const count = await triggers.count()
  for (let index = 0; index < count; index++) {
    const trigger = triggers.nth(index)
    const box = await trigger.boundingBox()
    if (!box || box.width === 0 || box.height === 0) continue
    await clickTrigger(trigger)
    if (await modelRows(page).first().isVisible({ timeout: 3_000 }).catch(() => false)) {
      // The catalog stub must have replaced the real one, or the list cannot
      // scroll far enough to reproduce the drift.
      await expect(modelRows(page)).toHaveCount(CATALOG_SIZE)
      return
    }
  }
  throw new Error(`the model picker never opened (${count} trigger(s) tried)`)
}

/**
 * Scroll the list to the bottom. The wheel is what a person uses; the fallback
 * covers a runner where the pointer is not over the list yet.
 */
async function scrollListToBottom(page: Page, delta = 2_000) {
  const list = listViewport(page)
  const box = await list.boundingBox()
  if (!box) throw new Error("the model list has no box")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let scrolled = 0; scrolled < delta; scrolled += 200) {
    await page.mouse.wheel(0, 200)
  }
  await expect
    .poll(() => list.evaluate((el) => el.scrollTop), { timeout: 10_000 })
    .toBeGreaterThan(0)
}

/** The row whose box is closest to `y` inside the list viewport. */
async function rowNearViewportOffset(page: Page, offset: number): Promise<Locator> {
  const box = await listViewport(page).boundingBox()
  if (!box) throw new Error("the model list has no box")
  const target = box.y + offset
  const rows = modelRows(page)
  const count = await rows.count()
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < count; index++) {
    const rowBox = await rows.nth(index).boundingBox()
    if (!rowBox) continue
    const distance = Math.abs(rowBox.y - target)
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  }
  return rows.nth(best)
}

async function expectCardBesideRow(page: Page, row: Locator) {
  const card = infoCard(page)
  await expect(card).toBeVisible({ timeout: 10_000 })
  const rowBox = await row.boundingBox()
  const cardBox = await card.boundingBox()
  const listBox = await listViewport(page).boundingBox()
  if (!rowBox || !cardBox || !listBox) throw new Error("missing box")
  // The card's top edge is the hovered row's top edge (±2px), and it never
  // leaves the list's vertical span.
  expect(cardBox.y - rowBox.y).toBeLessThanOrEqual(2)
  expect(rowBox.y - cardBox.y).toBeLessThanOrEqual(2)
  expect(cardBox.y).toBeGreaterThanOrEqual(listBox.y - 2)
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 2)
}

test.describe("Model picker hover card (local)", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 1440, height: 900 } })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000)
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await stubProjectRuntime(page)
    await page.goto("/")
    await page.getByRole("navigation", { name: "App sidebar" }).first().waitFor({ timeout: 120_000 })

    const suffix = Date.now().toString(36)
    const workspace = await apiJson(page, "POST", "/api/workspaces", {
      name: `QA hover card ${suffix}`,
      kind: "team",
    })
    workspaceId = workspace.json?.data?.id ?? workspace.json?.id
    expect(workspaceId, JSON.stringify(workspace.json)).toBeTruthy()

    const project = await apiJson(page, "POST", "/api/projects", {
      name: `QA hover card project ${suffix}`,
      workspaceId,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
      schemas: [],
      settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
    })
    projectId = project.json?.data?.id ?? project.json?.id
    expect(projectId, JSON.stringify(project.json)).toBeTruthy()

    await page.close()
  })

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage()
    if (projectId) await page.request.delete(`${API}/api/projects/${projectId}`).catch(() => {})
    if (workspaceId) await page.request.delete(`${API}/api/workspaces/${workspaceId}`).catch(() => {})
    await page.close()
  })

  /**
   * One page load, one open picker: the hover card is checked unscrolled, at
   * the bottom of the list, and while the wheel moves the list under the mouse.
   * Reloading between checks makes the picker's own mount the flaky part of the
   * spec, which is not what this card is about.
   */
  test("the card stays beside its row unscrolled, scrolled and while wheeling", async ({ page }) => {
    test.setTimeout(240_000)
    await prepare(page)
    await openPicker(page)

    // 1. Unscrolled: the card's top is the hovered row's top. The old guess
    //    (index × 32) was already a few px out per row here.
    const early = modelRows(page).nth(2)
    await early.hover()
    await expectCardBesideRow(page, early)

    // 2. Scrolled: a row in the middle of the visible list. This is the case
    //    that used to put the card a whole scroll offset below the row.
    await scrollListToBottom(page)
    const midway = await rowNearViewportOffset(page, 120)
    await midway.hover()
    await expectCardBesideRow(page, midway)

    // 3. The last model: the card stays inside the menu's span, not below it,
    //    and still overlaps the row it describes.
    const last = modelRows(page).last()
    await last.hover()
    const card = infoCard(page)
    await expect(card).toBeVisible({ timeout: 10_000 })
    const lastCardBox = await card.boundingBox()
    const listBox = await listViewport(page).boundingBox()
    const lastBox = await last.boundingBox()
    if (!lastCardBox || !listBox || !lastBox) throw new Error("missing box")
    expect(lastCardBox.y).toBeGreaterThanOrEqual(listBox.y - 2)
    expect(lastCardBox.y + lastCardBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 2)
    expect(lastCardBox.y).toBeLessThan(lastBox.y + lastBox.height)
    expect(lastCardBox.y + lastCardBox.height).toBeGreaterThan(lastBox.y)

    // 4. Wheeling under a stationary pointer: the card moves with the list
    //    instead of staying where the row used to be.
    const list = listViewport(page)
    const listCenter = await list.boundingBox()
    if (!listCenter) throw new Error("the model list has no box")
    await page.mouse.move(listCenter.x + listCenter.width / 2, listCenter.y + listCenter.height / 2)
    await page.mouse.wheel(0, -2_000)
    await expect.poll(() => list.evaluate((el) => el.scrollTop), { timeout: 10_000 }).toBe(0)

    const above = modelRows(page).nth(1)
    await above.hover()
    await expectCardBesideRow(page, above)
    const before = await infoCard(page).boundingBox()
    if (!before) throw new Error("missing card")

    await page.mouse.wheel(0, 72)
    await expect
      .poll(async () => (await infoCard(page).boundingBox())?.y, { timeout: 10_000 })
      .not.toBe(before.y)

    if (await card.isVisible()) {
      const cardBox = await card.boundingBox()
      const scrolledListBox = await listViewport(page).boundingBox()
      if (!cardBox || !scrolledListBox) throw new Error("missing box")
      expect(cardBox.y).toBeGreaterThanOrEqual(scrolledListBox.y - 2)
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(
        scrolledListBox.y + scrolledListBox.height + 2,
      )
      const rowTops: number[] = []
      const rows = modelRows(page)
      for (let index = 0; index < (await rows.count()); index++) {
        const box = await rows.nth(index).boundingBox()
        if (box) rowTops.push(box.y)
      }
      const nearestRowTop = Math.min(...rowTops.map((top) => Math.abs(top - cardBox.y)))
      expect(nearestRowTop).toBeLessThanOrEqual(2)
    }
  })
})
