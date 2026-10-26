// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { Locator, Page } from "@playwright/test"

export const LOCAL_API_BASE = process.env.E2E_API_URL || process.env.STAGING_API_URL || "http://localhost:8002"

/**
 * What is painted on top of an element's own centre, or `null` when nothing is.
 * Occlusion is invisible to `toBeVisible()` — a covered element still has a box —
 * so this asks the browser for the paint stack instead.
 *
 * Elements that are `pointer-events: none` are skipped by hit testing while
 * still being painted, so that is switched off for the measurement (paint order
 * does not depend on it) and restored straight after. The label bubbles use it
 * so they never steal hover from the icon they belong to.
 */
export async function coveredBy(target: Locator): Promise<string | null> {
  return target.evaluate((el) => {
    const node = el as HTMLElement
    const previous = node.style.pointerEvents
    node.style.pointerEvents = "auto"
    const box = node.getBoundingClientRect()
    const top = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2)[0] as HTMLElement | undefined
    node.style.pointerEvents = previous
    if (!top || node.contains(top)) return null
    const classes = typeof top.className === "string" ? top.className.split(" ").slice(0, 3).join(".") : ""
    return `${top.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`
  })
}

/**
 * Local mode opens the Personal workspace (the companion chat); the project
 * home ("What are we building") lives in the Team workspace. Make the team
 * workspace active and land on its home.
 *
 * The home is `/home` since SHO-4: `/` is now the workspace agent chat with a
 * fresh session for a team workspace.
 */
export async function openTeamHome(page: Page, timeout = 30_000): Promise<void> {
  await page.goto("/")
  await page
    .getByRole("navigation", { name: "App sidebar" })
    .or(page.getByRole("tab", { name: "Sign Up" }))
    .first()
    .waitFor({ state: "visible", timeout })

  const teamId = await page.evaluate(async (apiBase) => {
    const res = await fetch(`${apiBase}/api/workspaces`, { credentials: "include" })
    const body = await res.json()
    const items = (body?.items ?? body?.data?.items ?? []) as Array<{ id: string; kind?: string }>
    return items.find((w) => w.kind !== "personal")?.id ?? null
  }, LOCAL_API_BASE)
  if (!teamId) throw new Error("local stack has no team workspace")

  await page.evaluate((id) => {
    localStorage.setItem("shogo:active-workspace-id", id)
    localStorage.setItem("shogo:active-workspace-kind", "team")
  }, teamId)
  await page.goto("/home")
  await page.getByText("What are we building", { exact: false }).first().waitFor({ state: "visible", timeout })
}

/** Start a project from the home composer and wait for its (mocked) bootstrap turn. */
export async function startProjectWithBootstrapTurn(page: Page): Promise<void> {
  await openTeamHome(page)
  const home = page.getByTestId("home-composer-input").or(
    page.getByRole("textbox", { name: "Describe the agent you want to build" }),
  )
  await home.click()
  await home.fill("Build a tiny app for the resume-replay E2E")
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 30_000 })
  await page.getByText("Bootstrap done.").waitFor({ state: "visible", timeout: 30_000 })
}
