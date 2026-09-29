// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { Page } from "@playwright/test"

export const LOCAL_API_BASE = process.env.E2E_API_URL || process.env.STAGING_API_URL || "http://localhost:8002"

/**
 * Local mode opens the Personal workspace (the companion chat); the project
 * home ("What are we building") lives in the Team workspace. Make the team
 * workspace active and land on its home.
 */
export async function openTeamHome(page: Page, timeout = 30_000): Promise<void> {
  await page.goto("/")
  const home = page.getByText("What are we building", { exact: false }).first()
  await page.getByRole("navigation", { name: "App sidebar" }).or(home).first().waitFor({ state: "visible", timeout })
  if (await home.isVisible().catch(() => false)) return

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
  await page.goto("/")
  await home.waitFor({ state: "visible", timeout })
}
