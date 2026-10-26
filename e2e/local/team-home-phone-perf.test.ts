// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Home on a phone in a workspace that has grown up: 150 channels, 150 projects
 * and 150 messages.
 *
 * The feed used to be one long ScrollView, so every channel and project in the
 * workspace mounted at once. It is now a single virtualized list, and these
 * tests hold that: the rows on screen are a window into the list, not the whole
 * workspace, and Home comes back from a project without being rebuilt.
 *
 * Runs in the `iphone-15-pro` and `pixel-7` projects (see playwright.config.ts).
 */
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { api, activateTeamWorkspace, signIn } from "./team-nav-seed"

const CHANNELS = 150
const PROJECTS = 150
const MESSAGES = 150

/**
 * More than a phone screen can show and fewer than the workspace holds: a
 * regression back to "mount everything" lands near 300 and fails here.
 */
const MAX_MOUNTED_ROWS = 60

/** Time to first feed paint, cold Metro compile included. */
const FEED_BUDGET_MS = 30_000

const feed = (page: Page) => page.getByTestId("mobile-home-feed")
const rows = (page: Page) => feed(page).getByRole("link")

interface BigSeed {
  workspaceId: string
  projectIds: string[]
  channelIds: string[]
}

async function seedBigWorkspace(page: Page): Promise<BigSeed> {
  const suffix = Date.now().toString(36)
  const workspaces = await api(page, "GET", "/api/workspaces")
  const all = (workspaces.json?.items ?? workspaces.json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
  const workspaceId = all.find((w) => w.kind !== "personal")?.id
  if (!workspaceId) throw new Error(`local stack has no team workspace: ${JSON.stringify(workspaces.json)}`)
  const session = await (await page.request.get(`${LOCAL_API_BASE}/api/auth/get-session`)).json().catch(() => null)

  const projectIds: string[] = []
  for (let i = 0; i < PROJECTS; i += 1) {
    const created = await api(page, "POST", "/api/projects", {
      name: `load-${suffix}-${i}`,
      workspaceId,
      createdBy: session?.user?.id,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
      schemas: [],
    })
    const id = created.json?.data?.id ?? created.json?.id
    if (!id) throw new Error(`project ${i} create failed: ${JSON.stringify(created.json)}`)
    projectIds.push(id)
  }

  const channelIds: string[] = []
  for (let i = 0; i < CHANNELS; i += 1) {
    const created = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, {
      name: `load-${suffix}-${i}`,
      kind: "public",
    })
    const id = created.json?.conversation?.id
    if (!id) throw new Error(`channel ${i} create failed: ${JSON.stringify(created.json)}`)
    channelIds.push(id)
  }

  // One message in each of the first 150 channels, so the list has previews and
  // unread counts to compute rather than an empty workspace.
  for (const id of channelIds.slice(0, MESSAGES)) {
    await api(page, "POST", `/api/conversations/${id}/messages`, { text: `load test message in ${id.slice(0, 8)}` })
  }

  return { workspaceId, projectIds, channelIds }
}

test.describe("Team Home on a phone with 150 channels, 150 projects and 150 messages", () => {
  test.describe.configure({ mode: "serial" })

  let seed: BigSeed
  let seeder: Page

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(600_000)
    const context = await browser.newContext()
    seeder = await context.newPage()
    await signIn(seeder)
    seed = await seedBigWorkspace(seeder)
  })

  test.afterAll(async () => {
    for (const id of seed.channelIds) await seeder.request.delete(`${LOCAL_API_BASE}/api/conversations/${id}`).catch(() => {})
    for (const id of seed.projectIds) await seeder.request.delete(`${LOCAL_API_BASE}/api/projects/${id}`).catch(() => {})
    await seeder.context().close()
  })

  test.beforeEach(async ({ page }) => {
    await signIn(page)
    await activateTeamWorkspace(page, seed.workspaceId)
  })

  test("Home paints inside its budget and mounts only a window of the workspace", async ({ page }) => {
    const started = Date.now()
    await page.goto("/home")
    await expect(feed(page)).toBeVisible({ timeout: FEED_BUDGET_MS })
    const firstPaint = Date.now() - started
    console.log(`[perf] phone Home first paint: ${firstPaint}ms`)
    expect(firstPaint).toBeLessThan(FEED_BUDGET_MS)

    // The workspace holds 300 rows; a phone shows a window of them.
    await expect.poll(async () => rows(page).count(), { timeout: 30_000 }).toBeGreaterThan(0)
    const mounted = await rows(page).count()
    console.log(`[perf] rows mounted on first paint: ${mounted} of ${CHANNELS + PROJECTS}`)
    expect(mounted).toBeLessThan(MAX_MOUNTED_ROWS)
  })

  test("scrolling to the end keeps the mounted rows bounded", async ({ page }) => {
    await page.goto("/home")
    await expect(feed(page)).toBeVisible({ timeout: FEED_BUDGET_MS })
    await expect.poll(async () => rows(page).count(), { timeout: 30_000 }).toBeGreaterThan(0)

    // Reach the last channel in the list without ever mounting all of them.
    for (let i = 0; i < 40; i += 1) {
      await page.mouse.move(200, 400)
      await page.mouse.wheel(0, 3_000)
      const mounted = await rows(page).count()
      expect(mounted, `after ${i + 1} scrolls`).toBeLessThan(MAX_MOUNTED_ROWS)
    }

    // The end of the list is reachable: the "Find and tune" links are the last
    // group, below every channel.
    await expect(feed(page).getByRole("button", { name: "Search messages" })).toBeVisible({ timeout: 30_000 })
  })

  test("Home is a screen you come back to, not one you rebuild", async ({ page }) => {
    await page.goto("/home")
    await expect(feed(page)).toBeVisible({ timeout: FEED_BUDGET_MS })
    const project = feed(page).getByRole("link", { name: new RegExp(`^load-`) }).first()
    await expect(project).toBeVisible({ timeout: 30_000 })
    const projectName = (await project.textContent())?.trim() ?? ""
    await project.click()
    await expect(page).toHaveURL(/\/projects\//, { timeout: 60_000 })

    // Back to Home: the stack pops instead of Home re-mounting from scratch.
    const back = page.getByTestId("project-native-back")
    await expect(back).toBeVisible({ timeout: 60_000 })
    const started = Date.now()
    await back.click()
    await expect(feed(page)).toBeVisible({ timeout: 15_000 })
    const returned = Date.now() - started
    console.log(`[perf] back to Home: ${returned}ms`)
    expect(returned).toBeLessThan(5_000)
    await expect(feed(page).getByRole("link", { name: projectName, exact: true })).toBeVisible()
  })

  test("the workspace avatar is Home's only sidebar button", async ({ page }) => {
    await page.goto("/home")
    await expect(feed(page)).toBeVisible({ timeout: FEED_BUDGET_MS })

    const avatar = feed(page).getByRole("button", { name: /open workspace sidebar$/ })
    await expect(avatar).toBeVisible()
    await avatar.click()
    await expect(page.getByLabel("App sidebar")).toBeVisible({ timeout: 15_000 })
  })
})
