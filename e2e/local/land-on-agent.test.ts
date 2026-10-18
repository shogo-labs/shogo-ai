// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-4 in local mode: a cold start opens the workspace agent at `/` with a
 * **new** empty chat for a team workspace (never the previous landing chat),
 * the old team home is at `/home`, an explicit `?chatSessionId=` still wins,
 * and a personal workspace keeps resuming its primary chat.
 *
 * Local counterpart to `e2e/staging/land-on-agent.test.ts` — it needs the local
 * stack (auto-sign-in), not a hosted target. `E2E_LOCAL_START_STACK=1` boots it.
 *
 *   npx playwright test --config e2e/local/playwright.config.ts land-on-agent
 */
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { activateTeamWorkspace, signIn, teamWorkspaceId } from "./team-nav-seed"

/** The workspace agent's composer (ChatInput's default accessibility label). */
function composer(page: Page) {
  return page
    .getByRole("textbox", { name: "Chat message input" })
    .filter({ visible: true })
    .first()
}

async function sessionIds(page: Page, workspaceId: string): Promise<string[]> {
  const res = await page.request.get(`${LOCAL_API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`)
  expect(res.ok(), `list sessions failed: ${res.status()}`).toBe(true)
  const json = await res.json()
  const rows = (json?.sessions ?? json?.items ?? []) as Array<{ id: string }>
  return rows.map((row) => row.id)
}

async function personalWorkspaceId(page: Page): Promise<string> {
  const res = await page.request.get(`${LOCAL_API_BASE}/api/workspaces`)
  const json = await res.json()
  const items = (json?.items ?? json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
  const id = items.find((w) => w.kind === "personal")?.id
  if (!id) throw new Error(`local stack has no personal workspace: ${JSON.stringify(json)}`)
  return id
}

test.describe("Landing on the workspace agent (local)", () => {
  test("a team cold start opens a new empty chat every time; /home is the old home", async ({ page }) => {
    test.setTimeout(180_000)
    await signIn(page)
    const workspaceId = await teamWorkspaceId(page)
    await activateTeamWorkspace(page, workspaceId)

    const before = await sessionIds(page, workspaceId)

    await page.goto("/")
    await expect(composer(page)).toBeVisible({ timeout: 90_000 })
    expect(new URL(page.url()).pathname).toBe("/")
    await expect(page.getByText("What are we building", { exact: false })).toHaveCount(0)

    const afterFirst = await sessionIds(page, workspaceId)
    const mintedFirst = afterFirst.filter((id) => !before.includes(id))
    expect(mintedFirst, "the landing did not open a new session").toHaveLength(1)

    // Reopening lands on another empty chat — the previous one is history.
    await page.reload()
    await expect(composer(page)).toBeVisible({ timeout: 90_000 })
    const afterSecond = await sessionIds(page, workspaceId)
    const mintedSecond = afterSecond.filter((id) => !afterFirst.includes(id))
    expect(mintedSecond, "a reload reused the previous landing chat").toHaveLength(1)
    expect(mintedSecond[0]).not.toBe(mintedFirst[0])

    // An explicit session in the URL still wins and mints nothing.
    await page.goto(`/agent?chatSessionId=${mintedFirst[0]}`)
    await expect(composer(page)).toBeVisible({ timeout: 90_000 })
    expect(new URL(page.url()).searchParams.get("chatSessionId")).toBe(mintedFirst[0])
    expect((await sessionIds(page, workspaceId)).sort()).toEqual(afterSecond.sort())

    // The pre-landing team home is one route away, and the TeamDock points there.
    await page.goto("/home")
    await expect(page.getByText("What are we building", { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })
    expect(new URL(page.url()).pathname).toBe("/home")
  })

  test("a personal cold start keeps resuming its last chat", async ({ page }) => {
    test.setTimeout(180_000)
    await signIn(page)
    const workspaceId = await personalWorkspaceId(page)
    await page.addInitScript((id) => {
      localStorage.setItem("shogo:active-workspace-id", id)
      localStorage.setItem("shogo:active-workspace-kind", JSON.stringify({ id, kind: "personal" }))
    }, workspaceId)

    // The first load may create the workspace's primary session; after that the
    // count must not grow — personal never mints a landing chat.
    await page.goto("/")
    await expect(composer(page)).toBeVisible({ timeout: 90_000 })
    const settled = await sessionIds(page, workspaceId)

    await page.reload()
    await expect(composer(page)).toBeVisible({ timeout: 90_000 })
    expect((await sessionIds(page, workspaceId)).sort()).toEqual([...settled].sort())
    expect(new URL(page.url()).pathname).toBe("/")
  })
})
