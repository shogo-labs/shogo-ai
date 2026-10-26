// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { expect, test, type Page } from "@playwright/test"

/**
 * SHO-210: **New project** must paint its builder on the first frame.
 *
 * `/(app)/new-project` renders `HomeScreen forceBuilder`. Nothing on it needs
 * the network to draw — the greeting, the composer, the **Import** chip and the
 * **stack** chip are all static until the user types — yet it used to show the
 * workspace-chrome skeleton until `useWorkspaceExperience().resolved` and hide
 * the stack chip until `GET /api/tech-stacks` answered.
 *
 * The specs below hold the network back (a delayed `/api/tech-stacks` and an
 * unloaded workspace collection) and assert on what is painted *while the
 * requests are still in flight*, plus the marks that say when each piece of the
 * builder appeared relative to navigation start.
 */

const COMPOSER = '[data-testid="home-composer-input"]'
const IMPORT_CHIP = '[data-testid="project-source-menu-trigger"]'
const STACK_CHIP = '[data-testid="tech-stack-picker-trigger"]'
const SKELETON = '[data-testid="home-chrome-skeleton"]'
const BUILDER = '[data-testid="home-builder"]'

type PaintMarks = Record<string, number>

/**
 * Records, in the page and before any app code runs, the first frame each piece
 * of the builder exists in the DOM. `performance.now()` shares its origin with
 * the navigation entry, so `navStart` → `composer` is real elapsed time.
 */
async function installPaintMarks(page: Page): Promise<void> {
  await page.addInitScript(
    ({ composer, importChip, stackChip, skeleton, builder }) => {
      const marks: Record<string, number> = {}
      ;(window as unknown as { __paintMarks: PaintMarks }).__paintMarks = marks
      const mark = (key: string) => {
        if (marks[key] === undefined) marks[key] = performance.now()
      }
      const navigation = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined
      marks.navStart = navigation?.startTime ?? 0
      mark("scriptsLoaded")

      const watch = () => {
        if (document.querySelector(builder)) mark("routeMounted")
        if (document.querySelector(composer)) mark("composer")
        if (document.querySelector(importChip)) mark("importChip")
        if (document.querySelector(stackChip)) mark("stackChip")
        if (document.querySelector(skeleton)) mark("skeleton")
      }
      const start = () => {
        watch()
        new MutationObserver(watch).observe(document.documentElement, {
          childList: true,
          subtree: true,
        })
      }
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true })
      } else {
        start()
      }
    },
    { composer: COMPOSER, importChip: IMPORT_CHIP, stackChip: STACK_CHIP, skeleton: SKELETON, builder: BUILDER },
  )
}

async function readPaintMarks(page: Page): Promise<PaintMarks> {
  return page.evaluate(
    () => (window as unknown as { __paintMarks?: PaintMarks }).__paintMarks ?? {},
  )
}

function reportPaintMarks(label: string, marks: PaintMarks): void {
  const at = (key: string) => (marks[key] === undefined ? "never" : `${Math.round(marks[key])}ms`)
  console.log(
    `[first-paint] ${label}: navStart 0ms · route mounted ${at("routeMounted")} · ` +
      `composer ${at("composer")} · import chip ${at("importChip")} · stack chip ${at("stackChip")} · ` +
      `skeleton ${at("skeleton")}`,
  )
}

/**
 * Parks every matching request until the returned `release()` runs, so a cold
 * Metro compile on a loaded runner cannot answer it before the assertions do.
 */
async function holdRoute(
  page: Page,
  pattern: string,
  state: { pending: boolean },
): Promise<() => void> {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  await page.route(pattern, async (route) => {
    state.pending = true
    await held
    state.pending = false
    await route.continue().catch(() => {})
  })
  return release
}

test.describe("New project paints the builder on the first frame", () => {
  test("composer, Import and stack chips are there before /api/tech-stacks and the workspace list answer", async ({
    page,
  }) => {
    await installPaintMarks(page)
    const techStacks = { pending: false }
    const workspaces = { pending: false }
    const releaseTechStacks = await holdRoute(page, "**/api/tech-stacks*", techStacks)
    const releaseWorkspaces = await holdRoute(page, "**/api/workspaces*", workspaces)

    try {
      await page.goto("/new-project")

      // Whatever the route paints first — the builder or the chrome skeleton —
      // the marks below say when each piece appeared. The assertions then say
      // which of the two it had to be. The budget is a cold Metro compile.
      await expect(page.locator(`${BUILDER}, ${SKELETON}`).first()).toBeAttached({
        timeout: 120_000,
      })
      reportPaintMarks("new-project, tech-stacks + workspaces held", await readPaintMarks(page))

      await expect(page.getByTestId("home-composer-input")).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId("project-source-menu-trigger").first()).toBeVisible()
      await expect(page.getByTestId("tech-stack-picker-trigger").first()).toBeVisible()
      // Painted while both requests were still unanswered, i.e. not a "the slow
      // part finished first" pass.
      expect(techStacks.pending).toBe(true)
      expect(workspaces.pending).toBe(true)
      await expect(page.locator(SKELETON)).toHaveCount(0)
      await expect(page.getByText("What are we building", { exact: false }).first()).toBeVisible()
    } finally {
      releaseTechStacks()
      releaseWorkspaces()
    }
  })

  test("the stack chip shows the fallback stacks when /api/tech-stacks fails, and a pick sticks", async ({
    page,
  }) => {
    await installPaintMarks(page)
    await page.route("**/api/tech-stacks*", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
    )

    await page.goto("/new-project")
    const chip = page.getByTestId("tech-stack-picker-trigger").first()
    await expect(chip).toBeVisible({ timeout: 120_000 })
    await expect(chip).toContainText("React App")

    await chip.click()
    await page.getByText("Expo (React Native)", { exact: true }).first().click()
    await expect(chip).toContainText("Expo (React Native)")
  })

  test("a second visit shows the chip from the cached list without refetching first", async ({
    page,
  }) => {
    let requests = 0
    await page.route("**/api/tech-stacks*", async (route) => {
      requests += 1
      await route.continue()
    })

    await page.goto("/new-project")
    await expect(page.getByTestId("tech-stack-picker-trigger").first()).toBeVisible({
      timeout: 120_000,
    })
    expect(requests).toBe(1)

    // Leave the builder and come back through the app's own Create menu, so the
    // page (and the picker's module cache) survives.
    await page.getByRole("button", { name: "Create" }).first().click()
    await page.getByText("New project", { exact: true }).first().click()
    await expect(page.getByTestId("home-composer-input")).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId("tech-stack-picker-trigger").first()).toBeVisible()
    expect(requests).toBe(1)
  })

  test("`/` and `/home` keep the chrome skeleton while the workspace collection loads", async ({
    page,
  }) => {
    await installPaintMarks(page)
    const workspaces = { pending: false }
    const releaseWorkspaces = await holdRoute(page, "**/api/workspaces*", workspaces)

    try {
      await page.goto("/home")
      await expect(page.locator(SKELETON)).toBeVisible({ timeout: 120_000 })
      expect(workspaces.pending).toBe(true)
      await expect(page.locator(COMPOSER)).toHaveCount(0)

      // The agent landing keeps the same gate — it picks its surface from the
      // kind, so it must not paint a surface it may have to swap.
      await page.goto("/")
      await expect(page.locator(SKELETON)).toBeVisible({ timeout: 60_000 })
      expect(workspaces.pending).toBe(true)
      await expect(page.locator(COMPOSER)).toHaveCount(0)
    } finally {
      releaseWorkspaces()
    }
  })

  test("the builder fits a 390px phone and paints the same four pieces", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const workspaces = { pending: false }
    const releaseWorkspaces = await holdRoute(page, "**/api/workspaces*", workspaces)
    const techStacks = { pending: false }
    const releaseTechStacks = await holdRoute(page, "**/api/tech-stacks*", techStacks)

    try {
      await page.goto("/new-project")
      await expect(page.getByTestId("home-composer-input")).toBeVisible({ timeout: 120_000 })
      // At phone width the Import and stack chips fold into the composer's "+"
      // sheet rather than sitting beside the input, so the first frame owes the
      // composer plus that entry point — and the sheet already holds both.
      const add = page.getByLabel("Add", { exact: true }).first()
      await expect(add).toBeVisible()
      // Painted while the workspace collection was still unanswered.
      expect(workspaces.pending).toBe(true)
      await expect(page.locator(SKELETON)).toHaveCount(0)
    } finally {
      releaseTechStacks()
      releaseWorkspaces()
    }
  })

  test("the stack picked from the fallback catalog is the one the new project persists", async ({
    page,
  }) => {
    await page.route("**/api/tech-stacks*", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
    )
    const creates: Array<Record<string, unknown>> = []
    page.on("request", (request) => {
      if (request.method() !== "POST") return
      if (!/\/api\/projects\/?$/.test(new URL(request.url()).pathname)) return
      try {
        creates.push(JSON.parse(request.postData() ?? "{}") as Record<string, unknown>)
      } catch {
        // A non-JSON body is not a create we can read; the poll below fails.
      }
    })

    await page.goto("/new-project")
    const chip = page.getByTestId("tech-stack-picker-trigger").first()
    await expect(chip).toBeVisible({ timeout: 120_000 })
    // The API is down, so this list is the static fallback catalog.
    await chip.click()
    await page.getByText("Expo (React Native)", { exact: true }).first().click()
    await expect(chip).toContainText("Expo (React Native)")

    await page.getByTestId("home-composer-input").first().click()
    await page.keyboard.type("a tiny kanban board")
    await page.keyboard.press("Enter")

    await expect.poll(() => creates.length, { timeout: 60_000 }).toBeGreaterThan(0)
    const settings = creates[0]?.settings
    const persisted = (
      typeof settings === "string" ? JSON.parse(settings) : settings
    ) as Record<string, unknown> | undefined
    expect(persisted?.techStackId).toBe("expo-app")
  })
})
