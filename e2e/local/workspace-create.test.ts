// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page, type Locator } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"

/**
 * More than one workspace in local mode — local/desktop E2E test (SHO-43).
 *
 * Local mode used to be locked to a single workspace: the API server seeds a
 * `personal` companion space plus one `team` workspace at bootstrap, the
 * generic workspace CRUD was only reachable through the cloud proxy, and the
 * "Create new workspace" entries were hidden behind `!localMode`, routing the
 * ones that did show to the paid `/(app)/new-workspace` checkout page.
 *
 * Now `local-workspaces.ts` serves the full lifecycle locally (create, rename,
 * delete, deletion preview, activity) and the pickers open the name modal at
 * every width. This spec covers the part a unit test can't: the desktop shell
 * actually creates, renames and deletes a workspace against the real local API,
 * and a delete removes the workspace's files.
 *
 * Start the local stack first:
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *
 * Then:
 *   npx playwright test --config e2e/local/playwright.config.ts workspace-create
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function anyAccountTrigger(page: Page): Locator {
  return page.getByRole("button", { name: /— open account/ })
}

function accountTrigger(page: Page, workspaceName: string): Locator {
  return page.getByRole("button", {
    name: new RegExp(`^${escapeRegExp(workspaceName)}, .+ — open account`),
  })
}

/**
 * A cold `/` load can land on a secondary nav tab and hide the account
 * trigger; retry a bounded number of times rather than asserting on a single
 * load (same helper as workspace-switch.test.ts).
 */
async function goHome(page: Page, attempts = 8): Promise<Locator> {
  const trigger = anyAccountTrigger(page)
  for (let i = 0; i < attempts; i++) {
    await page.goto("/")
    const menuButton = page.getByLabel("Open menu")
    if (await menuButton.isVisible().catch(() => false)) await menuButton.click()

    const appeared = await trigger.waitFor({ state: "visible", timeout: 3_000 }).then(
      () => true,
      () => false,
    )
    if (!appeared) continue
    await page.waitForTimeout(600)
    if (await trigger.isVisible().catch(() => false)) return trigger
  }
  throw new Error(`Account trigger never stayed visible after ${attempts} navigation attempts`)
}

/**
 * The persisted active workspace, read out of the page.
 *
 * Creating or switching a workspace navigates the shell, and `page.evaluate`
 * throws "Execution context was destroyed" when that navigation lands mid-call.
 * `expect.poll` reports a thrown error instead of retrying it, so a healthy
 * switcher fails the spec three times in a row (SHO-249). Swallow exactly that
 * class and return `undefined`: the poll reads again, on the new document.
 */
async function activeWorkspaceId(page: Page): Promise<string | null | undefined> {
  try {
    return await page.evaluate(() => localStorage.getItem("shogo:active-workspace-id"))
  } catch (error) {
    const message = String(error)
    if (/Execution context was destroyed|Cannot find context with specified id|navigat/i.test(message)) {
      return undefined
    }
    throw error
  }
}

async function openAccountPopover(page: Page, trigger: Locator) {
  const popoverOpen = () => page.getByLabel("Sign in to Shogo Cloud").isVisible().catch(() => false)

  await trigger.click()
  await page.waitForTimeout(400)
  if (await popoverOpen()) return

  await trigger.dispatchEvent("pointerdown")
  await page.waitForTimeout(100)
  await trigger.dispatchEvent("pointerup")
  await page.waitForTimeout(400)
  if (await popoverOpen()) return

  await trigger.evaluate((el: HTMLElement) => el.click())
  await page.waitForTimeout(400)
}

interface WorkspaceRow {
  id: string
  name: string
  kind?: string
  slug?: string
}

async function listWorkspaces(page: Page): Promise<WorkspaceRow[]> {
  const response = await page.request.get(`${LOCAL_API_BASE}/api/workspaces`)
  expect(response.ok()).toBeTruthy()
  const body = await response.json()
  const items = (body?.items ?? body?.data ?? []) as WorkspaceRow[]
  return items
}

const created: string[] = []

test.describe("More than one workspace (local mode)", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000)
    page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 800 })
  })

  test.afterAll(async () => {
    // The delete test removes its own workspace; this catches a failed run so a
    // half-created workspace never lingers in the developer's local DB.
    for (const id of created) {
      await page?.request.delete(`${LOCAL_API_BASE}/api/workspaces/${id}`).catch(() => undefined)
    }
    await page?.close()
  })

  test("the local API creates, renames and guards workspaces", async () => {
    test.setTimeout(60_000)
    // `page.request` shares this page's cookie jar, and local mode signs the
    // user in on the first page load — so land on the shell before calling the
    // API directly, or every request is a 401.
    await goHome(page)
    const name = `E2E API ${Date.now()}`
    const res = await page.request.post(`${LOCAL_API_BASE}/api/workspaces`, { data: { name } })
    expect(res.status()).toBe(201)
    const body = await res.json()
    const workspace = body.data as WorkspaceRow
    created.push(workspace.id)
    expect(workspace.name).toBe(name)
    expect(workspace.kind).toBe("team")
    expect(workspace.slug).toBeTruthy()

    // No plan cap in local mode.
    const second = await page.request.post(`${LOCAL_API_BASE}/api/workspaces`, {
      data: { name: `${name} 2` },
    })
    expect(second.status()).toBe(201)
    created.push(((await second.json()).data as WorkspaceRow).id)

    // The owner is a member, so the workspace shows up in the caller's list.
    const ids = (await listWorkspaces(page)).map((w) => w.id)
    expect(ids).toContain(workspace.id)

    const renamed = await page.request.patch(`${LOCAL_API_BASE}/api/workspaces/${workspace.id}`, {
      data: { name: `${name} renamed` },
    })
    expect(renamed.status()).toBe(200)
    const renamedBody = await renamed.json()
    expect(renamedBody.data.name).toBe(`${name} renamed`)
    // Renaming must not repoint anything: the slug is an internal identifier.
    expect(renamedBody.data.slug).toBe(workspace.slug)

    const blank = await page.request.post(`${LOCAL_API_BASE}/api/workspaces`, { data: { name: "  " } })
    expect(blank.status()).toBe(400)
    expect((await blank.json()).error.code).toBe("invalid_name")

    const personal = (await listWorkspaces(page)).find((w) => w.kind === "personal")
    expect(personal).toBeTruthy()
    const personalDelete = await page.request.delete(
      `${LOCAL_API_BASE}/api/workspaces/${personal!.id}`,
    )
    expect(personalDelete.status()).toBe(409)
    expect((await personalDelete.json()).error.code).toBe("personal_workspace_required")
  })

  test("wide desktop: Create new workspace opens the name modal, not the paid page", async () => {
    test.setTimeout(90_000)
    const name = `E2E UI ${Date.now()}`
    const trigger = await goHome(page)
    await openAccountPopover(page, trigger)
    await expect(page.getByLabel("Sign in to Shogo Cloud")).toBeVisible({ timeout: 10_000 })

    await page.getByLabel("Create new workspace").first().click()

    // Locally this must be the modal — the cloud checkout page 404s here.
    expect(page.url()).not.toContain("/new-workspace")
    const dialog = page.getByPlaceholder("e.g. My Team, Acme Corp")
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await dialog.fill(name)
    await page.getByText("Create workspace", { exact: true }).click()

    // It lands in the switcher as the active workspace.
    await expect(accountTrigger(page, name)).toBeVisible({ timeout: 30_000 })
    const rows = (await listWorkspaces(page)).filter((w) => w.name === name)
    expect(rows).toHaveLength(1)
    created.push(rows[0].id)

    // …and the shell actually switched into it: the persisted active id is the
    // new workspace's, and it starts empty (the seeded workspace's projects
    // must not follow the switch).
    await expect
      .poll(() => activeWorkspaceId(page), {
        timeout: 30_000,
      })
      .toBe(rows[0].id)
    const projects = await page.request.get(
      `${LOCAL_API_BASE}/api/projects?workspaceId=${rows[0].id}`,
    )
    expect(projects.ok()).toBeTruthy()
    const projectBody = await projects.json()
    expect((projectBody?.items ?? projectBody?.data ?? []) as unknown[]).toHaveLength(0)
  })

  test("narrow web (390px): the same create works from the /account Workspaces section", async () => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 390, height: 844 })
    const name = `E2E Narrow ${Date.now()}`

    await page.goto("/account")
    await page
      .getByText("Workspaces", { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
    await page.getByLabel("Create new workspace").first().click()

    expect(page.url()).not.toContain("/new-workspace")
    const dialog = page.getByPlaceholder("e.g. My Team, Acme Corp")
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await dialog.fill(name)
    await page.getByText("Create workspace", { exact: true }).click()

    await expect
      .poll(async () => (await listWorkspaces(page)).filter((w) => w.name === name).length, {
        timeout: 30_000,
      })
      .toBe(1)
    const createdRow = (await listWorkspaces(page)).find((w) => w.name === name)!
    expect(createdRow.kind).toBe("team")
    created.push(createdRow.id)
    await page.setViewportSize({ width: 1280, height: 800 })
  })

  test("wide desktop: settings shows the deletion preview and deletes the workspace", async () => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    const rows = (await listWorkspaces(page)).filter((w) => w.name.startsWith("E2E UI "))
    expect(rows).toHaveLength(1)
    const workspace = rows[0]

    const preview = await page.request.get(
      `${LOCAL_API_BASE}/api/workspaces/${workspace.id}/deletion-preview`,
    )
    expect(preview.status()).toBe(200)
    const previewBody = await preview.json()
    expect(previewBody.preview.workspaceId).toBe(workspace.id)
    // A brand-new workspace still owns its merged runtime root or nothing at
    // all; either way the preview is a list, never undefined.
    expect(Array.isArray(previewBody.preview.removedDirs)).toBe(true)

    // The narrow test above left a different workspace active, and delete acts
    // on the active one — switch to ours first, the way a user would.
    let trigger = await goHome(page)
    await openAccountPopover(page, trigger)
    await page.getByLabel(workspace.name, { exact: true }).click()
    await expect
      .poll(() => activeWorkspaceId(page), {
        timeout: 30_000,
      })
      .toBe(workspace.id)

    // `/settings` is also an admin-console route, so a cold URL load lands there.
    // Walk in the way the switcher points people: Manage workspaces → the
    // workspace settings tab (the phone surface uses /account instead).
    trigger = await goHome(page)
    await openAccountPopover(page, trigger)
    await page.getByLabel("Manage workspaces").click()
    await expect(page).toHaveURL(/\/settings\?tab=workspace/, { timeout: 20_000 })
    await expect(page.getByText("Delete workspace", { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    })
    await page.getByLabel("Delete workspace").click()

    // Type-to-confirm, then delete.
    const confirmInput = page.getByPlaceholder(`Type "${workspace.name}" to confirm`)
    await expect(confirmInput).toBeVisible({ timeout: 10_000 })
    await confirmInput.fill(workspace.name)
    await page.getByLabel("Confirm delete workspace").click()

    await expect
      .poll(async () => (await listWorkspaces(page)).some((w) => w.id === workspace.id), {
        timeout: 30_000,
      })
      .toBe(false)

    const index = created.indexOf(workspace.id)
    if (index >= 0) created.splice(index, 1)
  })
})
