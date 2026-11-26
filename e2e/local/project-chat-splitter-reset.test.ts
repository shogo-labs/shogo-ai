// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-576 — double-clicking the project chat's chat/canvas splitter restores the
 * default chat width.
 *
 * The splitter carried `onDoubleClick` on a react-native `View`, which
 * react-native-web never forwards to the DOM, and `click`/`dblclick` cannot
 * carry it either: the handle appends a full-viewport overlay on pointerdown, so
 * the overlay takes the pointerup that would let the browser count a second
 * click. Before this card the reset had never fired on desktop/web — the width
 * stayed where the drag left it and the stored width stayed with it.
 *
 * The spec drives the real web build: drag the handle, reload (the width
 * persists), double-click it, and reload again. That last reload is the proof
 * the saved width was cleared rather than overwritten: with the key still
 * holding the dragged width the panel would reopen at that width.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     project-chat-splitter-reset --project chromium --retries 0
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { LOCAL_API_BASE, ignoreDevErrorToast } from "./helpers"
import { activateTeamWorkspace, signInByApi } from "./team-nav-seed"

test.setTimeout(180_000)

/** `DEFAULT_CHAT_PANEL_WIDTH` in the project layout. */
const DEFAULT_CHAT_WIDTH = 480

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
  projectId: string
}

/** A private workspace with one project; nothing else in the DB is touched. */
async function seedProject(page: Page): Promise<Fixture> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const created = await api(page, "POST", "/api/workspaces", {
    name: `E2E chat splitter ${stamp}`,
  })
  const workspaceId: string | undefined =
    created.json?.workspace?.id ?? created.json?.data?.id ?? created.json?.id
  expect(workspaceId, `no workspace: ${JSON.stringify(created.json)}`).toBeTruthy()

  await activateTeamWorkspace(page, workspaceId!)

  const me = await api(page, "GET", "/api/auth/get-session")
  const project = await api(page, "POST", "/api/projects", {
    name: `E2E chat splitter ${stamp}`,
    workspaceId,
    createdBy: me.json?.user?.id,
    tier: "starter",
    status: "draft",
    accessLevel: "anyone",
    schemas: [],
    settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
  })
  const projectId: string | undefined = project.json?.data?.id ?? project.json?.id
  expect(projectId, `no project: ${JSON.stringify(project.json)}`).toBeTruthy()

  return { workspaceId: workspaceId!, projectId: projectId! }
}

async function dropFixture(page: Page, fixture: Fixture): Promise<void> {
  await api(page, "DELETE", `/api/projects/${fixture.projectId}`).catch(() => {})
  await api(page, "DELETE", `/api/workspaces/${fixture.workspaceId}`).catch(() => {})
}

function resizeHandle(page: Page): Locator {
  return page.getByLabel("Resize chat panel").first()
}

/** The chat column the handle is pinned to; its width is the splitter's width. */
function chatColumnWidth(handle: Locator): Promise<number> {
  return handle.evaluate((el) => el.parentElement!.getBoundingClientRect().width)
}

async function openProjectChat(page: Page, fixture: Fixture): Promise<Locator> {
  await page.goto(`/projects/${fixture.projectId}`)
  const handle = resizeHandle(page)
  await expect(handle).toBeVisible({ timeout: 120_000 })
  return handle
}

/** The column animates its width (220ms), so read it once it has stopped moving. */
async function settledWidth(handle: Locator): Promise<number> {
  let last = await chatColumnWidth(handle)
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const next = await chatColumnWidth(handle)
    if (Math.abs(next - last) < 0.5) return next
    last = next
  }
  return last
}

/** Drag the handle `dx` pixels to the right (positive widens the chat panel). */
async function dragHandleRight(page: Page, handle: Locator, dx: number): Promise<void> {
  const box = await handle.boundingBox()
  expect(box, "the splitter has no box").not.toBeNull()
  const x = box!.x + box!.width / 2
  const y = box!.y + Math.min(80, box!.height / 2)
  await page.mouse.move(x, y)
  await page.mouse.down()
  // Step frame by frame: the chat column animates its width, and Chrome
  // coalesces pointermove to one per frame, so a fast `steps: 12` move reaches
  // the app as a single first-frame delta instead of the whole drag.
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(x + (dx * i) / 10, y)
    await page.waitForTimeout(25)
  }
  await page.mouse.move(x + dx, y)
  await page.waitForTimeout(50)
  await page.mouse.up()
}

test.describe("project chat, chat/canvas splitter reset", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  let fixture: Fixture
  let page: Page

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    await ignoreDevErrorToast(page)
    await signInByApi(page)
    fixture = await seedProject(page)
  })

  test.afterEach(async () => {
    if (fixture) await dropFixture(page, fixture)
    await page.close()
  })

  test("double-clicking the splitter restores the default width and survives a reload", async () => {
    let handle = await openProjectChat(page, fixture)

    // No saved width: today's default.
    await expect.poll(() => chatColumnWidth(handle), { timeout: 10_000 }).toBe(DEFAULT_CHAT_WIDTH)

    // A drag resizes live and commits on release — the width comes back after a
    // reload, which is what makes the reset below meaningful.
    await dragHandleRight(page, handle, 120)
    const widened = await settledWidth(handle)
    expect(widened).toBeGreaterThan(DEFAULT_CHAT_WIDTH + 60)

    await page.reload()
    handle = resizeHandle(page)
    await expect(handle).toBeVisible({ timeout: 120_000 })
    expect(await settledWidth(handle)).toBeCloseTo(widened, 0)

    // The reset that never fired before this card.
    await handle.dblclick()
    expect(await settledWidth(handle)).toBe(DEFAULT_CHAT_WIDTH)

    // And the stored width is gone, not overwritten: a reload still shows the
    // default instead of the width the drag left behind.
    await page.reload()
    handle = resizeHandle(page)
    await expect(handle).toBeVisible({ timeout: 120_000 })
    expect(await settledWidth(handle)).toBe(DEFAULT_CHAT_WIDTH)
  })

  test("a drag released in place is not the first half of a double-click", async () => {
    const handle = await openProjectChat(page, fixture)
    await expect.poll(() => chatColumnWidth(handle), { timeout: 10_000 }).toBe(DEFAULT_CHAT_WIDTH)

    await dragHandleRight(page, handle, 120)
    const widened = await settledWidth(handle)
    expect(widened).toBeGreaterThan(DEFAULT_CHAT_WIDTH + 60)

    // One press right after the drag: a drag is never a click, so this starts a
    // new drag instead of resetting the width.
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(80, box.height / 2))
    await page.mouse.down()
    await page.mouse.up()

    expect(await settledWidth(handle)).toBeCloseTo(widened, 0)
  })
})
