// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phone web: the floating "Back to conversation" button in a thread must close
 * the thread and return to the channel timeline.
 *
 * Runs in the `iphone-15-pro` and `pixel-7` projects (see playwright.config.ts).
 */
import { expect, test, type Page } from "@playwright/test"
import { activateTeamWorkspace, api, cleanupTeamNav, seedTeamNav, signIn, type TeamNavSeed } from "./team-nav-seed"

const backButton = (page: Page) => page.getByRole("button", { name: "Back to conversation" })

test.describe("Team chat thread on phone: back to conversation", () => {
  test.describe.configure({ mode: "serial" })

  let seed: TeamNavSeed
  let seeder: Page
  let rootId: string
  let rootText: string

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext()
    seeder = await context.newPage()
    await signIn(seeder)
    seed = await seedTeamNav(seeder)

    rootText = `thread root ${seed.suffix}`
    await api(seeder, "POST", `/api/conversations/${seed.channelId}/messages`, { text: rootText })
    const list = await api(seeder, "GET", `/api/conversations/${seed.channelId}/messages`)
    rootId = (list.json?.messages ?? []).find((m: any) => !m.threadRootId && m.text === rootText)?.id
    expect(rootId, "seeded thread root message").toBeTruthy()
  })

  test.afterAll(async () => {
    await cleanupTeamNav(seeder, seed)
    await seeder.context().close()
  })

  test.beforeEach(async ({ page }) => {
    await signIn(page)
    await activateTeamWorkspace(page, seed.workspaceId)
  })

  test("back closes a thread opened from its link", async ({ page }) => {
    await page.goto(`/c/${seed.channelId}?thread=${rootId}`)
    await expect(page.getByTestId("floating-thread-header")).toBeVisible({ timeout: 60_000 })

    await backButton(page).click()

    await expect(page).not.toHaveURL(/thread=/, { timeout: 15_000 })
    await expect(page.getByTestId("floating-thread-header")).toHaveCount(0)
    await expect(page.getByTestId("floating-conversation-header")).toBeVisible()
  })

  test("back closes a thread opened from the Reply in thread action", async ({ page }) => {
    await page.goto(`/c/${seed.channelId}`)
    const row = page.getByLabel(new RegExp(`${rootText}$`)).first()
    await expect(row).toBeVisible({ timeout: 60_000 })
    // The action toolbar renders on hover (web), so reveal it before tapping Reply.
    await row.hover()
    await row.getByLabel("Reply in thread").click()
    await expect(page).toHaveURL(new RegExp(`thread=${rootId}`), { timeout: 15_000 })
    await expect(page.getByTestId("floating-thread-header")).toBeVisible()

    await backButton(page).click()

    await expect(page).not.toHaveURL(/thread=/, { timeout: 15_000 })
    await expect(page.getByTestId("floating-thread-header")).toHaveCount(0)
  })

  test("browser back closes a thread opened from the Reply in thread action", async ({ page }) => {
    await page.goto(`/c/${seed.channelId}`)
    const row = page.getByLabel(new RegExp(`${rootText}$`)).first()
    await expect(row).toBeVisible({ timeout: 60_000 })
    await row.hover()
    await row.getByLabel("Reply in thread").click()
    await expect(page.getByTestId("floating-thread-header")).toBeVisible({ timeout: 15_000 })

    await page.goBack()

    await expect(page).toHaveURL(new RegExp(`/c/${seed.channelId}$`), { timeout: 15_000 })
    await expect(page.getByTestId("floating-thread-header")).toHaveCount(0)
    await expect(page.getByTestId("floating-conversation-header")).toBeVisible()
  })
})
