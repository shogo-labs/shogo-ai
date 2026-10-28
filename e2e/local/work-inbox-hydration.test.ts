// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect } from "@playwright/test"

/**
 * `My work` must load even when the workspace list is slow.
 *
 * The screen resolves its workspace through `useActiveWorkspace()`, which is
 * null until the domain store's workspace collection has hydrated. If the
 * screen is not an MST observer it renders the spinner once with
 * `workspaceId === null` and never re-renders when the collection lands, so
 * the inbox query is never issued and the spinner stays forever (this is how
 * `E2E (local mode) (1/3)` failed on `main`: `work-row-*` never rendered).
 *
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *   npx playwright test --config e2e/local/playwright.config.ts work-inbox-hydration
 */
test("My work recovers when the workspace list arrives after the first render", async ({ page }) => {
  await page.goto("/")
  await page
    .getByTestId("project-composer-input")
    .or(page.getByTestId("home-composer-input"))
    .waitFor({ state: "visible", timeout: 60_000 })

  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    await route.continue()
  })

  await page.goto("/work")
  await expect(page.getByRole("heading", { name: "My work" })).toBeVisible({ timeout: 20_000 })

  // The empty state (or a row) proves the inbox query ran; a spinner means it
  // never did.
  await expect(page.getByTestId("work-list").or(page.getByText(/Nothing is assigned to you/))).toBeVisible({
    timeout: 20_000,
  })
})
