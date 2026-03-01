import { test, expect, type Page } from "@playwright/test"

/**
 * Canvas Visual Editor E2E Tests
 *
 * Tests the full visual editor flow on the dev preview route.
 *
 * Prerequisites: Expo web dev server running on port 8081
 *   bun run web:dev
 *
 * Run:
 *   npx playwright test --config e2e/dev/playwright.config.ts canvas-visual-editor
 */

const DEV_PREVIEW_URL = "/dev/dynamic-app"

async function waitForDevPreview(page: Page) {
  await page.goto(DEV_PREVIEW_URL)
  await page.waitForSelector("text=Dev Preview", { timeout: 30_000 })
  await page.waitForSelector("text=Canvas Editor", { timeout: 5_000 })
}

async function enterEditMode(page: Page) {
  await page.getByText("Edit", { exact: true }).click()
  await expect(page.getByText("Tree", { exact: true })).toBeVisible()
}

async function exitEditMode(page: Page) {
  await page.getByText("Preview", { exact: true }).click()
  await expect(page.getByText("Tree", { exact: true })).not.toBeVisible()
}

test.describe("Canvas Visual Editor", () => {
  test.beforeEach(async ({ page }) => {
    await waitForDevPreview(page)
  })

  test("should display dev preview with sidebar and canvas", async ({
    page,
  }) => {
    await expect(page.getByText("Dev Preview")).toBeVisible()
    await expect(page.getByText("Canvas Editor")).toBeVisible()
    await expect(page.getByText("Expense Tracker").first()).toBeVisible()
    await expect(page.getByText("Habit Tracker")).toBeVisible()
    await expect(page.getByText("Flight Search")).toBeVisible()
    await expect(page.getByText("Total Spent")).toBeVisible()
    await expect(page.getByText("$1,847")).toBeVisible()
    await expect(page.getByText("Edit", { exact: true })).toBeVisible()
  })

  test("should toggle edit mode on and off", async ({ page }) => {
    await expect(page.getByText("Tree", { exact: true })).not.toBeVisible()

    await enterEditMode(page)
    await expect(page.getByText("Preview", { exact: true })).toBeVisible()
    await expect(page.getByText("Tree", { exact: true })).toBeVisible()
    await expect(
      page.getByText("Select a component on the canvas to inspect")
    ).toBeVisible()

    await exitEditMode(page)
    await expect(page.getByText("Tree", { exact: true })).not.toBeVisible()
  })

  test("should select a component and show inspector", async ({ page }) => {
    await enterEditMode(page)

    await page.getByText("Expense Tracker").nth(1).click()

    await expect(page.getByText("#title", { exact: true })).toBeVisible()
    await expect(
      page.getByText("Properties").or(page.getByText("PROPERTIES"))
    ).toBeVisible()
    await expect(page.getByText("Delete", { exact: true })).toBeVisible()
    await expect(page.getByText("Text#title").first()).toBeVisible()
  })

  test("should edit a text property via the inspector", async ({ page }) => {
    await enterEditMode(page)

    await page.getByText("Expense Tracker").nth(1).click()
    await expect(page.getByText("#title", { exact: true })).toBeVisible()

    const textInput = page.locator('input[value="Expense Tracker"]')
    await expect(textInput).toBeVisible()

    await textInput.click({ clickCount: 3 })
    await page.keyboard.type("Budget Tracker Pro")
    await page.keyboard.press("Tab")
    await page.waitForTimeout(500)

    await expect(page.getByText("Budget Tracker Pro")).toBeVisible()
  })

  test("should toggle the component tree panel", async ({ page }) => {
    await enterEditMode(page)

    await expect(page.getByText("Component Tree")).not.toBeVisible()

    await page.getByText("Tree", { exact: true }).click()
    await expect(page.getByText("Component Tree")).toBeVisible()
    await expect(page.getByText("root", { exact: true }).first()).toBeVisible()

    await page.getByText("Tree", { exact: true }).click()
    await expect(page.getByText("Component Tree")).not.toBeVisible()
  })

  test("should add a component via the Add dialog", async ({ page }) => {
    await enterEditMode(page)

    await page.getByText("Add", { exact: true }).click()
    await expect(page.getByText("Add Component")).toBeVisible()

    await expect(page.getByText("Layout", { exact: true })).toBeVisible()
    await expect(page.getByText("Display", { exact: true })).toBeVisible()
    await expect(page.getByText("Interactive", { exact: true })).toBeVisible()

    await page.getByText("Display", { exact: true }).click()
    await page.waitForTimeout(300)
    await page.getByText("Text with typography variants").click()

    await expect(page.getByText("Add Component")).not.toBeVisible({
      timeout: 5_000,
    })
    await expect(page.getByText(/Text#comp_/).first()).toBeVisible()
  })

  test("should delete a component", async ({ page }) => {
    await enterEditMode(page)

    await page.getByText("February 2026").click()
    await expect(page.getByText("#period", { exact: true })).toBeVisible()

    await page.getByText("Delete", { exact: true }).click()

    await expect(page.getByText("February 2026")).not.toBeVisible()
    await expect(
      page.getByText("Select a component on the canvas to inspect")
    ).toBeVisible()
  })

  test("should select components from the tree panel", async ({ page }) => {
    await enterEditMode(page)

    await page.getByText("Tree", { exact: true }).click()
    await expect(page.getByText("Component Tree")).toBeVisible()

    await page.getByText("title", { exact: true }).first().click()

    await expect(page.getByText("#title", { exact: true })).toBeVisible()
    await expect(page.getByText("Text#title").first()).toBeVisible()
  })

  test("should switch between demo surfaces", async ({ page }) => {
    await page.getByText("Flight Search").click()
    await page.waitForTimeout(500)

    await expect(page.getByText("SFO").first()).toBeVisible()

    await enterEditMode(page)
    await expect(
      page.getByText("Select a component on the canvas to inspect")
    ).toBeVisible()
  })

  test("should preserve edits when toggling edit mode", async ({ page }) => {
    await enterEditMode(page)

    await page.getByText("Expense Tracker").nth(1).click()
    await expect(page.getByText("#title", { exact: true })).toBeVisible()

    const textInput = page.locator('input[value="Expense Tracker"]')
    await expect(textInput).toBeVisible()
    await textInput.click({ clickCount: 3 })
    await page.keyboard.type("Edited Title")
    await page.keyboard.press("Tab")
    await page.waitForTimeout(500)

    await exitEditMode(page)
    await expect(page.getByText("Edited Title")).toBeVisible()

    await enterEditMode(page)
    await expect(page.getByText("Edited Title")).toBeVisible()
  })

  test("full editing workflow: add, select, edit, delete", async ({
    page,
  }) => {
    await enterEditMode(page)

    await page.getByText("Tree", { exact: true }).click()
    await expect(page.getByText("Component Tree")).toBeVisible()

    // Add a Text component
    await page.getByText("Add", { exact: true }).click()
    await expect(page.getByText("Add Component")).toBeVisible()
    await page.getByText("Display", { exact: true }).click()
    await page.waitForTimeout(300)
    await page.getByText("Text with typography variants").click()
    await expect(page.getByText("Add Component")).not.toBeVisible({
      timeout: 5_000,
    })
    await expect(page.getByText(/Text#comp_/).first()).toBeVisible()

    // Edit the text property of the newly added component
    const textInput = page.locator("input").first()
    await expect(textInput).toBeVisible()
    await textInput.click({ clickCount: 3 })
    await page.keyboard.type("Hello Visual Editor!")
    await page.keyboard.press("Tab")
    await page.waitForTimeout(500)
    await expect(page.getByText("Hello Visual Editor!")).toBeVisible()

    // Delete the component
    await page.getByText("Delete", { exact: true }).click()
    await expect(page.getByText("Hello Visual Editor!")).not.toBeVisible()
    await expect(
      page.getByText("Select a component on the canvas to inspect")
    ).toBeVisible()
  })
})
