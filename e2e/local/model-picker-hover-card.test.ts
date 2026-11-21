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

const modelTrigger = (page: Page) =>
  page.getByRole("button", { name: "Choose model" }).first()

const modelRows = (page: Page) => page.locator('[data-testid^="model-option-"]')

const infoCard = (page: Page) => page.getByTestId("model-info-card")

const listViewport = (page: Page) => page.getByTestId("model-picker-scroll")

async function openPicker(page: Page) {
  await page.goto(`/projects/${projectId}`)
  const trigger = modelTrigger(page)
  await trigger.waitFor({ state: "visible", timeout: 120_000 })
  await trigger.click({ force: true })
  await modelRows(page).first().waitFor({ state: "visible", timeout: 30_000 })
  // The catalog stub must have replaced the real one, or the list cannot scroll.
  await expect(modelRows(page)).toHaveCount(CATALOG_SIZE)
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

  test("an unscrolled list puts the card's top on the hovered row", async ({ page }) => {
    test.setTimeout(240_000)
    await prepare(page)
    await openPicker(page)

    const row = modelRows(page).nth(2)
    await row.hover()
    await expectCardBesideRow(page, row)
  })

  test("after scrolling, the card is still beside the hovered row", async ({ page }) => {
    test.setTimeout(240_000)
    await prepare(page)
    await openPicker(page)
    await scrollListToBottom(page)

    // A row in the middle of the visible list: this is the case that used to
    // put the card a full scroll offset below the row.
    const row = await rowNearViewportOffset(page, 120)
    await row.hover()
    await expectCardBesideRow(page, row)
  })

  test("the last model's card stays inside the menu, not below it", async ({ page }) => {
    test.setTimeout(240_000)
    await prepare(page)
    await openPicker(page)
    await scrollListToBottom(page)

    const last = modelRows(page).last()
    await last.hover()
    const card = infoCard(page)
    await expect(card).toBeVisible({ timeout: 10_000 })

    const cardBox = await card.boundingBox()
    const listBox = await listViewport(page).boundingBox()
    const lastBox = await last.boundingBox()
    if (!cardBox || !listBox || !lastBox) throw new Error("missing box")

    expect(cardBox.y).toBeGreaterThanOrEqual(listBox.y - 2)
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 2)
    // ...and it still overlaps the row it describes.
    expect(cardBox.y).toBeLessThan(lastBox.y + lastBox.height)
    expect(cardBox.y + cardBox.height).toBeGreaterThan(lastBox.y)
  })

  test("wheeling over a hovered row carries the card with the list", async ({ page }) => {
    test.setTimeout(240_000)
    await prepare(page)
    await openPicker(page)

    const row = modelRows(page).nth(1)
    await row.hover()
    await expectCardBesideRow(page, row)
    const before = await infoCard(page).boundingBox()
    if (!before) throw new Error("missing card")

    // Two rows of wheel under a pointer that does not move: the card must move
    // with the list, not stay where the row used to be.
    await page.mouse.wheel(0, 72)
    await expect
      .poll(async () => (await infoCard(page).boundingBox())?.y, { timeout: 10_000 })
      .not.toBe(before.y)

    // The card is either beside the row now under the pointer, or gone because
    // that row left the viewport — never floating beside empty space. Either
    // way its top edge is a row's top edge, inside the list.
    const card = infoCard(page)
    if (await card.isVisible()) {
      const cardBox = await card.boundingBox()
      const listBox = await listViewport(page).boundingBox()
      if (!cardBox || !listBox) throw new Error("missing box")
      expect(cardBox.y).toBeGreaterThanOrEqual(listBox.y - 2)
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 2)

      const rows = modelRows(page)
      const rowTops: number[] = []
      for (let index = 0; index < (await rows.count()); index++) {
        const box = await rows.nth(index).boundingBox()
        if (box) rowTops.push(box.y)
      }
      const nearestRowTop = Math.min(...rowTops.map((top) => Math.abs(top - cardBox.y)))
      expect(nearestRowTop).toBeLessThanOrEqual(2)
    }
  })
})
