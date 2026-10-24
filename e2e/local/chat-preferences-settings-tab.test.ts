// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat preferences are Settings → Chat (SHO-109).
 *
 * The standalone `/c/settings` screen is gone: the route now redirects into the
 * Chat tab of the Settings page (wide) or of the Account sheet (phone), which is
 * where the digest email and the channels-panel link send people.
 *
 * The one thing only a browser proves is that the choice survives a reload, so
 * Message sound is flipped to Off, the page is reloaded, the old link is
 * followed again and the row is still checked — with the API agreeing, because
 * the tab writes through `useChatSettings`.
 */
import { expect, test, type Page } from "@playwright/test"
import { api, teamWorkspaceId } from "./team-nav-seed"

const WIDE = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

const soundOff = (page: Page) => page.getByTestId("chat-message-sound-off")
const soundDefault = (page: Page) => page.getByTestId("chat-message-sound-default")

/**
 * A selected `ChoiceRow` is the one the screen reader is told is checked, and
 * the one with the primary border and the tick.
 *
 * `aria-checked` is asserted as well as the class because it is the part that
 * was silently missing: react-native-web 0.21 drops `accessibilityState`, so
 * every settings radio rendered `role="radio"` with no state on web until
 * SHO-111 moved these rows onto `aria-checked`.
 */
const selected = (locator: ReturnType<typeof soundOff>) =>
  expect(locator).toHaveClass(/border-primary/)
const checkedState = (locator: ReturnType<typeof soundOff>, value: boolean) =>
  expect(locator).toHaveAttribute("aria-checked", String(value))

/**
 * Local mode opens the Personal workspace, where chat preferences do not
 * exist. Pin the team workspace the same way `openTeamHome` does, so the tab
 * and its guard see a team shell on the reload too.
 */
async function useTeamWorkspace(page: Page): Promise<string> {
  await page.goto("/")
  await page
    .getByRole("navigation", { name: "App sidebar" })
    .or(page.getByText("What are we building", { exact: false }))
    .first()
    .waitFor({ state: "visible", timeout: 60_000 })
  const teamId = await teamWorkspaceId(page)
  await page.evaluate((id) => {
    localStorage.setItem("shogo:active-workspace-id", id)
    localStorage.setItem("shogo:active-workspace-kind", "team")
  }, teamId)
  return teamId
}

async function messageSound(page: Page, workspaceId: string): Promise<string | undefined> {
  const res = await api(page, "GET", `/api/workspaces/${workspaceId}/chat-settings`)
  return res.json?.settings?.messageSound
}

test.describe("Chat preferences are Settings → Chat", () => {
  test.describe.configure({ mode: "serial" })

  test("the old /c/settings link opens the Chat tab and Message sound survives a reload", async ({
    page,
  }) => {
    test.setTimeout(180_000)
    await page.setViewportSize(WIDE)
    const workspaceId = await useTeamWorkspace(page)

    // The retired screen redirects in-app, so the old URL keeps working.
    await page.goto("/c/settings")
    await expect(soundDefault(page)).toBeVisible({ timeout: 60_000 })
    await expect(page).toHaveURL(/\/settings\?.*tab=chat/)
    await selected(soundDefault(page))
    await checkedState(soundDefault(page), true)
    await checkedState(soundOff(page), false)

    await soundOff(page).click()
    await selected(soundOff(page))
    await checkedState(soundOff(page), true)
    await checkedState(soundDefault(page), false)
    await expect(soundDefault(page)).not.toHaveClass(/border-primary/)
    await expect.poll(() => messageSound(page, workspaceId), { timeout: 30_000 }).toBe("off")

    // A real page reload, then the old link again: the tab reads the choice back.
    await page.reload()
    await page.goto("/c/settings")
    await expect(soundOff(page)).toBeVisible({ timeout: 60_000 })
    await selected(soundOff(page))
    await checkedState(soundOff(page), true)
    await expect(soundDefault(page)).not.toHaveClass(/border-primary/)

    const reset = await api(page, "PATCH", `/api/workspaces/${workspaceId}/chat-settings`, {
      messageSound: "default",
    })
    expect(reset.status).toBe(200)
  })

  test("a personal workspace has no Chat tab and /c/settings does not open one", async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize(WIDE)
    await useTeamWorkspace(page)

    const personalId = await page.evaluate(async (apiBase) => {
      const res = await fetch(`${apiBase}/api/workspaces`, { credentials: "include" })
      const body = await res.json()
      const items = (body?.items ?? body?.data?.items ?? []) as Array<{ id: string; kind?: string }>
      return items.find((w) => w.kind === "personal")?.id ?? null
    }, process.env.E2E_API_URL || "http://localhost:8002")
    test.skip(!personalId, "local stack has no personal workspace")

    await page.evaluate((id) => {
      localStorage.setItem("shogo:active-workspace-id", id as string)
      localStorage.setItem("shogo:active-workspace-kind", "personal")
    }, personalId)

    await page.goto("/c/settings")
    await page.waitForLoadState("networkidle")
    expect(await soundOff(page).count()).toBe(0)
    expect(await soundDefault(page).count()).toBe(0)
  })

  test("the phone lands on the same tab inside the Account sheet", async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize(WIDE)
    await useTeamWorkspace(page)

    await page.setViewportSize(PHONE)
    await page.goto("/c/settings")

    await expect(page).toHaveURL(/\/account(\?|$)/, { timeout: 60_000 })
    const sheet = page.getByTestId("native-account-settings-sheet")
    await expect(sheet).toBeVisible({ timeout: 30_000 })
    await expect(sheet.getByText("Chat", { exact: true }).first()).toBeVisible()
    await expect(sheet.getByTestId("chat-message-sound-off")).toBeVisible()
    await expect(page.getByTestId("settings-legacy-page")).toHaveCount(0)
  })
})
