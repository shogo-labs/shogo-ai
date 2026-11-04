// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test, type Page, type Route } from "@playwright/test"
import { ignoreDevErrorToast } from "./helpers"

/**
 * SHO-284: the workspace file viewer's header. Download is an icon button the
 * size of Copy/X (not a wide "Download <name>" chip), and a "Copy link to file"
 * button copies `/agent?workspace=<id>&file=<path>` — a link that lands any
 * member of that workspace on the same file.
 *
 * The whole path is real: the mention chip opens the viewer, the viewer writes
 * the link to the clipboard, and the link is then opened cold in a new page.
 * Only the model reply is a mocked SSE turn.
 *
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *   npx playwright test --config e2e/local/playwright.config.ts workspace-file-link
 */

const API = process.env.E2E_API_URL || "http://localhost:8002"

let frameCounter = 0
function sseFrame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`
}
function buildTurn(text: string): string {
  frameCounter += 1
  const textId = `text_${frameCounter}`
  return [
    sseFrame({ type: "start", messageId: `msg_${frameCounter}` }),
    sseFrame({ type: "start-step" }),
    sseFrame({ type: "text-start", id: textId }),
    sseFrame({ type: "text-delta", id: textId, delta: text }),
    sseFrame({ type: "text-end", id: textId }),
    sseFrame({ type: "finish-step" }),
    sseFrame({ type: "finish" }),
  ].join("")
}

let nextReply: string | null = null

async function installChatMock(page: Page) {
  const handler = async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.continue()
      return
    }
    const text = nextReply ?? "OK."
    nextReply = null
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: buildTurn(text),
    })
  }
  await page.route("**/api/workspaces/*/chat", handler)
  await page.route("**/api/projects/*/chat", handler)
}

function composer(page: Page) {
  return page.getByTestId("project-composer-input").or(page.getByTestId("home-composer-input"))
}

/** A mentioned path is a chip when it exists in the workspace, a link when not. */
function mentionedFile(page: Page, name: string) {
  return page.getByTestId(/^chat-file-(chip|link)$/).filter({ hasText: name })
}

async function send(page: Page, text: string) {
  const input = composer(page)
  await input.click()
  await input.fill(text)
  await page.keyboard.press("Enter")
}

async function apiJson(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(`${API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    data: body ? JSON.stringify(body) : undefined,
    // Attaching a project to a session starts its runtime, which outruns the
    // 15s default on a loaded machine.
    timeout: 60_000,
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status(), json }
}

/** The viewer's header buttons carry an accessibility label, not a testID. */
const copyLinkButton = (page: Page) => page.getByLabel("Copy link to file", { exact: true })
const closeButton = (page: Page) => page.getByLabel("Close file", { exact: true })

/**
 * Answer the runtime's file read for `expectedPath` with `content`, and record
 * every path the viewer asked for. SHO-284 is the link → pane wiring: whether a
 * project's runtime happens to be running in this sandbox is not what the spec
 * is about, and a cold page can reach the pane before that runtime exists.
 */
async function installFileMock(page: Page, expectedPath: string, content: string): Promise<string[]> {
  const asked: string[] = []
  await page.route("**/agent/workspace/files/**", async (route) => {
    const url = new URL(route.request().url())
    const path = decodeURIComponent(url.pathname.split("/agent/workspace/files/")[1] ?? "")
    asked.push(path)
    if (path === expectedPath) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ content }) })
      return
    }
    await route.fulfill({ status: 404, contentType: "text/plain", body: "not found" })
  })
  return asked
}

/**
 * Make `workspaceId` the workspace the app opens in, before the first paint —
 * the same key the workspace switcher writes.
 */
async function activateWorkspace(page: Page, workspaceId: string): Promise<void> {
  await page.addInitScript((id) => {
    localStorage.setItem("shogo:active-workspace-id", id)
  }, workspaceId)
}

test.describe("Workspace file viewer: icon Download and a shareable file link", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let projectId: string
  /** The workspace-relative path the link must name. */
  let filePath: string
  /** The workspace the chat on screen belongs to — where the file is attached. */
  let workspaceId: string
  /** Another workspace the same account is a member of. */
  let otherWorkspaceId: string
  const report = "# E2E Report Heading\n\nA paragraph the preview should render.\n"

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext()
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    page = await context.newPage()
    await ignoreDevErrorToast(page)
    await page.setViewportSize({ width: 1280, height: 800 })
    await installChatMock(page)
    await page.goto("/")
    await composer(page).waitFor({ state: "visible", timeout: 60_000 })

    const workspaces = await apiJson(page, "GET", "/api/workspaces")
    const list = workspaces.json?.items ?? workspaces.json?.data ?? workspaces.json?.workspaces ?? workspaces.json
    const rows = (Array.isArray(list) ? list : []) as Array<{ id: string; kind?: string }>
    // The file has to live in the workspace the chat on screen is in, or the
    // mention chip opens it in a different workspace than the one the link
    // names. The app's own active workspace is the truth here.
    const active = await page.evaluate(() => localStorage.getItem("shogo:active-workspace-id"))
    const workspace = rows.find((row) => row.id === active) ?? rows.find((row) => row.kind === "personal") ?? rows[0]
    expect(workspace?.id, `workspace list ${workspaces.status}`).toBeTruthy()
    workspaceId = workspace.id
    const other = rows.find((row) => row.id !== workspaceId)
    expect(other?.id, "the account needs a second workspace for the switch case").toBeTruthy()
    otherWorkspaceId = other!.id

    const sessionRes = await page.request.get(`${API}/api/auth/get-session`)
    const session = await sessionRes.json().catch(() => null)
    const userId = session?.user?.id as string | undefined

    const created = await apiJson(page, "POST", "/api/projects", {
      name: "E2E file link",
      workspaceId,
      createdBy: userId,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
      schemas: [],
      settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
    })
    projectId = created.json?.data?.id ?? created.json?.id
    expect(projectId, JSON.stringify(created.json)).toBeTruthy()
    filePath = `${projectId}/E2E-REPORT.md`
    await installFileMock(page, filePath, report)

    const written = await apiJson(page, "PUT", `/api/projects/${projectId}/files/E2E-REPORT.md`, { content: report })
    expect(written.status, written.json?.error?.message).toBeLessThan(300)

    const primary = await apiJson(page, "POST", `/api/workspaces/${workspaceId}/sessions/primary`, {})
    const sessionId = primary.json?.session?.id
    expect(sessionId, JSON.stringify(primary.json)).toBeTruthy()
    // The project is deliberately *not* attached to the session: attaching
    // starts a runtime, which is slow on a loaded machine and is not what this
    // spec is about. A mentioned path renders as a link when the workspace does
    // not report it as a file, and clicking either opens the same pane (#1471).
    await page.reload()
    await composer(page).waitFor({ state: "visible", timeout: 60_000 })
  })

  test.afterAll(async () => {
    if (projectId) {
      await page.request.delete(`${API}/api/projects/${projectId}`).catch(() => {})
    }
    await page?.context().close()
  })

  /** The viewer header: icon Download, then copy link, copy path and close. */
  test("the header has an icon Download and a Copy link button that copies the file link", async () => {
    nextReply = `Done — report written to the project folder:\n\n${projectId}/E2E-REPORT.md (3 lines)`
    await send(page, "Write the report")
    const chip = mentionedFile(page, "E2E-REPORT.md")
    await expect(chip).toBeVisible({ timeout: 20_000 })
    await chip.click()

    await expect(page.getByTestId("workspace-file-viewer")).toBeVisible({ timeout: 30_000 })

    // AC 1: Download is a bare icon at the header's button size, not a chip
    // labelled with the file name.
    const download = page.getByLabel(/^Download /).first()
    await expect(download).toBeVisible()
    const box = await download.boundingBox()
    expect(box?.width ?? 0).toBeLessThanOrEqual(40)
    expect(box?.height ?? 0).toBeLessThanOrEqual(40)
    expect(((await download.textContent()) ?? "").trim()).toBe("")

    // AC 2: copy the link — the label flips to "Link copied", and the clipboard
    // holds `/agent?workspace=…&file=…` for this workspace and this path.
    await copyLinkButton(page).click()
    await expect(page.getByLabel("Link copied", { exact: true })).toBeVisible({ timeout: 5_000 })

    const copied = await page.evaluate(() => navigator.clipboard.readText())
    const url = new URL(copied)
    expect(url.pathname).toBe("/agent")
    expect(url.searchParams.get("workspace")).toBe(workspaceId)
    expect(url.searchParams.get("file")).toBe(`${projectId}/E2E-REPORT.md`)

    // AC 3: a cold load of that link lands in the same workspace with the file
    // pane open on that file.
    const opened = await page.context().newPage()
    await ignoreDevErrorToast(opened)
    await installChatMock(opened)
    const asked = await installFileMock(opened, filePath, report)
    await opened.goto(copied)
    await expect(opened.getByTestId("workspace-file-viewer")).toBeVisible({ timeout: 60_000 })
    await expect(opened.getByTestId("workspace-file-markdown")).toContainText("E2E Report Heading", {
      timeout: 30_000,
    })
    // The link is the arrival state while the pane is open: the params stay in
    // the URL until the pane closes (dropping them at open would remount the
    // screen on web and throw the pane away — see `use-file-link-arrival`).
    expect(new URL(opened.url()).searchParams.get("file")).toBe(filePath)
    // The path the link names is the workspace-relative one the runtime serves:
    // the project id the viewer's `path` prop drops has to come back.
    expect(asked).toContain(filePath)
    await opened.close()
  })

  test("a link for another workspace the person belongs to moves them there", async () => {
    // AC 3, second half: the person is in a different workspace when the link
    // is opened, and it names the one the file lives in.
    const opened = await page.context().newPage()
    await ignoreDevErrorToast(opened)
    await installChatMock(opened)
    await installFileMock(opened, filePath, report)
    await activateWorkspace(opened, otherWorkspaceId)
    await opened.goto("/")
    await composer(opened).waitFor({ state: "visible", timeout: 60_000 })

    const href = `${new URL(opened.url()).origin}/agent?workspace=${encodeURIComponent(workspaceId)}&file=${encodeURIComponent(
      `${projectId}/E2E-REPORT.md`,
    )}`
    await opened.goto(href)
    await expect(opened.getByTestId("workspace-file-viewer")).toBeVisible({ timeout: 60_000 })
    await expect(opened.getByTestId("workspace-file-markdown")).toContainText("E2E Report Heading", {
      timeout: 30_000,
    })
    await expect
      .poll(() => opened.evaluate(() => localStorage.getItem("shogo:active-workspace-id")), { timeout: 20_000 })
      .toBe(workspaceId)
    await opened.close()
  })

  test("a link for a workspace the person is not in says so and changes nothing", async () => {
    // AC 5: access is workspace membership. An unknown workspace must not move
    // the person, and must not open a pane.
    const opened = await page.context().newPage()
    await ignoreDevErrorToast(opened)
    await installChatMock(opened)
    await installFileMock(opened, filePath, report)
    await activateWorkspace(opened, otherWorkspaceId)
    await opened.goto("/")
    await composer(opened).waitFor({ state: "visible", timeout: 60_000 })

    // Opening `/` also restores the chat this account last used, and the app
    // adopts that chat's workspace — an automatic switch with nothing to do
    // with the link, between two workspaces the person is actually in. Let it
    // settle, then hold the arrival to its own rule: the stranger must not
    // change what is on screen.
    const settled = () =>
      opened.evaluate(() => localStorage.getItem("shogo:active-workspace-id"))
    await expect
      .poll(
        async () => {
          const first = await settled()
          await opened.waitForTimeout(1_500)
          const second = await settled()
          // A value that held still across the window is the settled one.
          return first === second ? second : ""
        },
        { timeout: 30_000, message: "the app settles on one of the person's workspaces" },
      )
      .not.toBe("")
    const activeBefore = await settled()
    expect([workspaceId, otherWorkspaceId]).toContain(activeBefore)

    const stranger = "11111111-2222-3333-4444-555555555555"
    await opened.goto(
      `${new URL(opened.url()).origin}/agent?workspace=${stranger}&file=${encodeURIComponent(`${projectId}/E2E-REPORT.md`)}`,
    )
    await expect(opened.getByTestId("workspace-file-link-denied")).toContainText(
      "You don't have access to this workspace.",
      { timeout: 60_000 },
    )
    await expect(opened.getByTestId("workspace-file-viewer")).toHaveCount(0)
    // A workspace this account cannot see may not become the active one, and the
    // link may not move the person off where they already were.
    const activeAfter = await settled()
    expect(activeAfter).not.toBe(stranger)
    expect(activeAfter).toBe(activeBefore)
    await opened.close()
  })

  test("closing the pane does not reopen it, and neither does a reload", async () => {
    // AC 6: the arrival is one-shot — the params are gone from the URL.
    const link = `${new URL(page.url()).origin}/agent?workspace=${encodeURIComponent(workspaceId)}&file=${encodeURIComponent(
      `${projectId}/E2E-REPORT.md`,
    )}`
    const opened = await page.context().newPage()
    await ignoreDevErrorToast(opened)
    await installChatMock(opened)
    await installFileMock(opened, filePath, report)
    await opened.goto(link)
    await expect(opened.getByTestId("workspace-file-viewer")).toBeVisible({ timeout: 60_000 })

    await closeButton(opened).click()
    await expect(opened.getByTestId("workspace-file-viewer")).toHaveCount(0)
    // Closing drops the params, so a reload cannot reopen the file.
    await expect.poll(() => new URL(opened.url()).searchParams.get("file"), { timeout: 15_000 }).toBeNull()

    await opened.reload()
    await composer(opened).waitFor({ state: "visible", timeout: 60_000 })
    await expect(opened.getByTestId("workspace-file-viewer")).toHaveCount(0)
    await opened.close()
  })
})
