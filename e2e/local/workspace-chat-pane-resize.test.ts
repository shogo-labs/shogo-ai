// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-569 — the right-hand panes of the workspace agent chat are drag-resizable
 * and remember their width, like the project chat's splitter.
 *
 * Russell: *"items on the right in the workspace chat should be resizable just
 * like the project chat"*.
 *
 * On `origin/main` every right-hand pane in `WorkspaceAgentChatScreen` was a
 * hard-coded `w-[45%] min-w-[420px]` column: no handle, so a canvas or a file
 * could never be widened. This spec drives the thing the report was about — the
 * project pane the Working set's chip opens — and asserts the three behaviours
 * the card promises:
 *
 *   1. a col-resize handle on the pane's left edge; dragging it changes the
 *      pane's width live and the width survives a reload;
 *   2. the drag is clamped so the chat column never drops below 480 px;
 *   3. double-clicking the handle restores the 45 % default.
 *
 * Each test seeds its own throwaway workspace, project and attachment through
 * the local API so no model turn runs and nothing another spec reads is
 * touched; the fixture is deleted afterwards.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     workspace-chat-pane-resize --project chromium --retries 0
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { LOCAL_API_BASE, ignoreDevErrorToast } from "./helpers"
import { activateTeamWorkspace, signInByApi } from "./team-nav-seed"

test.setTimeout(180_000)

const PROJECT_PANE = "workspace-project-pane"
const STORAGE_KEY = "shogo.workspaceChat.projectPaneWidth"
/** The chat column may never be squeezed narrower than this (the card's AC). */
const CHAT_MIN_WIDTH = 480

type ApiResult = { status: number; json: any }

async function api(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  const res = await page.request.fetch(`${LOCAL_API_BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    data: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status(), json: await res.json().catch(() => null) }
}

interface Fixture {
  workspaceId: string
  sessionId: string
  projectId: string
  projectName: string
  message: string
}

/** A private workspace whose agent chat holds one attached project. */
async function seedChat(page: Page): Promise<Fixture> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const created = await api(page, "POST", "/api/workspaces", {
    name: `E2E pane resize ${stamp}`,
  })
  const workspaceId: string | undefined =
    created.json?.workspace?.id ?? created.json?.data?.id ?? created.json?.id
  expect(workspaceId, `no workspace: ${JSON.stringify(created.json)}`).toBeTruthy()

  await activateTeamWorkspace(page, workspaceId!)

  const primary = await api(
    page,
    "POST",
    `/api/workspaces/${workspaceId}/sessions/primary`,
    {},
  )
  const sessionId: string | undefined = primary.json?.session?.id
  expect(sessionId, `no session: ${JSON.stringify(primary.json)}`).toBeTruthy()

  const me = await api(page, "GET", "/api/auth/get-session")
  const projectName = `E2E pane resize ${stamp}`
  const project = await api(page, "POST", "/api/projects", {
    name: projectName,
    workspaceId,
    createdBy: me.json?.user?.id,
    tier: "starter",
    status: "draft",
    accessLevel: "anyone",
    schemas: [],
    settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
  })
  const projectId: string | undefined =
    project.json?.data?.id ?? project.json?.id
  expect(projectId, `no project: ${JSON.stringify(project.json)}`).toBeTruthy()

  const message = `hello from the pane resize e2e ${stamp}`
  const posted = await api(page, "POST", "/api/chat-messages", {
    sessionId,
    role: "user",
    content: message,
  })
  expect(
    posted.status,
    `message failed: ${JSON.stringify(posted.json)}`,
  ).toBeLessThan(300)

  const attached = await api(
    page,
    "POST",
    `/api/workspaces/${workspaceId}/sessions/${sessionId}/projects`,
    { projectId, attachMode: "readwrite" },
  )
  expect(
    attached.status,
    `attach failed: ${JSON.stringify(attached.json)}`,
  ).toBeLessThan(300)

  return {
    workspaceId: workspaceId!,
    sessionId: sessionId!,
    projectId: projectId!,
    projectName,
    message,
  }
}

async function dropFixture(page: Page, fixture: Fixture): Promise<void> {
  await api(page, "DELETE", `/api/projects/${fixture.projectId}`).catch(() => {})
  await api(page, "DELETE", `/api/workspaces/${fixture.workspaceId}`).catch(() => {})
}

function composer(page: Page) {
  return page
    .getByRole("textbox", { name: "Chat message input" })
    .filter({ visible: true })
    .first()
}

async function openChat(page: Page, fixture: Fixture): Promise<void> {
  await page.goto(`/?chatSessionId=${fixture.sessionId}`)
  await composer(page).waitFor({ state: "visible", timeout: 120_000 })
  await page.getByText(fixture.message).first().waitFor({ state: "visible", timeout: 60_000 })
}

/** The collapsed dock header for *this* project (see the working-set spec). */
function workingSetHeaderFor(page: Page, fixture: Fixture) {
  return page
    .getByRole("button", { name: "Working set", exact: true })
    .filter({ has: page.getByText(fixture.projectName, { exact: true }) })
    .first()
}

function chip(page: Page, fixture: Fixture) {
  return page.getByLabel(`${fixture.projectName} project`).first()
}

/** Expand the dock and press the project's chip: the pane opens beside the chat. */
async function openProjectPane(page: Page, fixture: Fixture): Promise<Locator> {
  await openChat(page, fixture)
  const header = workingSetHeaderFor(page, fixture)
  await expect(header).toBeVisible()
  const projectChip = chip(page, fixture)
  if (!(await projectChip.isVisible().catch(() => false))) await header.click()
  await expect(projectChip).toBeVisible()
  await projectChip.click()

  const pane = page.getByTestId(PROJECT_PANE).first()
  await expect(pane).toBeVisible({ timeout: 60_000 })
  return pane
}

function resizeHandle(pane: Locator): Locator {
  return pane.getByLabel("Resize panel")
}

/** The pane's own box, and the row it and the chat share. */
async function boxes(pane: Locator): Promise<{ pane: number; row: number; chat: number }> {
  const measured = await pane.evaluate((el) => {
    const pane = el.getBoundingClientRect()
    const row = el.parentElement?.getBoundingClientRect()
    const chat = el.parentElement?.firstElementChild?.getBoundingClientRect()
    return {
      pane: pane.width,
      row: row?.width ?? 0,
      chat: chat?.width ?? 0,
    }
  })
  return measured
}

async function storedWidth(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)
}

/**
 * Drag the handle `dx` pixels left (positive widens the pane), in real steps.
 * Returns the pane's width at the moment of `pointerdown` — the width the drag
 * itself starts from, which is what the +dx assertion must be measured against
 * (the row can settle a frame after the pane first opens).
 */
async function dragHandle(page: Page, handle: Locator, dx: number): Promise<number> {
  const box = await handle.boundingBox()
  expect(box, "the resize handle has no box").not.toBeNull()
  const startWidth = await handle.evaluate(
    (el) => el.parentElement!.getBoundingClientRect().width,
  )
  const x = box!.x + box!.width / 2
  const y = box!.y + Math.min(80, box!.height / 2)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - dx, y, { steps: 12 })
  await page.mouse.up()
  return startWidth
}

test.describe("workspace agent chat, right-hand pane resize", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  let fixture: Fixture
  let page: Page

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    await ignoreDevErrorToast(page)
    await signInByApi(page)
    fixture = await seedChat(page)
  })

  test.afterEach(async () => {
    if (fixture) await dropFixture(page, fixture)
    await page.close()
  })

  test("dragging the project pane's handle widens it and the width survives a reload", async () => {
    const pane = await openProjectPane(page, fixture)

    // With nothing saved the pane keeps today's look: 45 % of the row.
    const before = await boxes(pane)
    expect(before.row).toBeGreaterThan(600)
    expect(Math.abs(before.pane - Math.max(420, Math.round(before.row * 0.45)))).toBeLessThanOrEqual(2)

    const handle = resizeHandle(pane)
    await expect(handle).toBeVisible()

    // Drag 100 px left: the pane grows by (startX - clientX) from the width it
    // had when the drag began.
    const startWidth = await dragHandle(page, handle, 100)
    await expect
      .poll(async () => (await boxes(pane)).pane, { timeout: 5_000 })
      .toBeCloseTo(startWidth + 100, 0)
    const widened = await boxes(pane)
    expect(widened.chat).toBeLessThan(before.chat)

    // The commit on pointer-up persisted it, and the chat is still usable.
    expect(await storedWidth(page)).toBe(String(Math.round(widened.pane)))
    expect(widened.chat).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH)

    // A reload reopens the chat with no pane; the pane the chip opens again is
    // the width the user dragged, not the 45 % default.
    await page.reload()
    const reopened = await openProjectPane(page, fixture)
    const afterReload = await boxes(reopened)
    expect(Math.abs(afterReload.pane - widened.pane)).toBeLessThanOrEqual(2)
  })

  test("the drag is clamped so the chat column never drops below 480px", async () => {
    const pane = await openProjectPane(page, fixture)
    const before = await boxes(pane)

    // Far past any sensible width: the clamp, not the drag, decides.
    await dragHandle(page, resizeHandle(pane), before.row)

    const clamped = await boxes(pane)
    expect(clamped.pane).toBeLessThanOrEqual(before.row - CHAT_MIN_WIDTH + 1)
    expect(clamped.chat).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH - 1)
    // And it did widen to that ceiling rather than refusing to move.
    expect(clamped.pane).toBeGreaterThan(before.pane)
  })

  test("double-clicking the handle restores the 45% default", async () => {
    const pane = await openProjectPane(page, fixture)
    const before = await boxes(pane)
    const handle = resizeHandle(pane)

    await dragHandle(page, handle, 160)
    const widened = await boxes(pane)
    expect(widened.pane).toBeGreaterThan(before.pane)

    await handle.dblclick()

    const reset = await boxes(pane)
    expect(Math.abs(reset.pane - before.pane)).toBeLessThanOrEqual(2)
    expect(await storedWidth(page)).toBeNull()
  })
})
