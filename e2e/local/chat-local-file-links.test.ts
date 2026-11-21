// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page, type Route } from "@playwright/test"

/**
 * Russell's bug, end to end (SHO-492): on Windows desktop an agent names a local
 * file three ways that all stayed plain text instead of a file chip —
 * `` `file:///C:/…/x.mp4` `` in backticks, `<file:///C:/…>`, and a drive path
 * with no `file://` at all. Every shape must reach the same local-file link the
 * app already understands, and a click must open the side pane (SHO-80), never
 * a browser tab.
 *
 * The message comes through a mocked chat stream, and `/api/local-files` is
 * answered by the test, so the only thing under test is the markdown pipeline:
 * text → chip → pane → the fetch the chip's href names.
 *
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *   npx playwright test --config e2e/local/playwright.config.ts chat-local-file-links
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

/** The absolute paths the viewer asked the local-only route for, in order. */
const localFileRequests: string[] = []

/**
 * `/api/local-files?path=` answers with the body the file name implies. A
 * Windows path arrives forward-slashed and URL-encoded, which is the whole
 * point: the route (and the desktop opener) take `C:/…`, never `C:\…`.
 */
async function installLocalFileMock(page: Page) {
  await page.route("**/api/local-files**", async (route: Route) => {
    const url = new URL(route.request().url())
    localFileRequests.push(url.searchParams.get("path") ?? "")
    const cors = {
      "access-control-allow-origin": route.request().headers()["origin"] ?? "*",
      "access-control-allow-credentials": "true",
      "cache-control": "private, no-store",
    }
    const name = (url.searchParams.get("path") ?? "").split("/").pop() ?? ""
    await route.fulfill({
      status: 200,
      headers: { ...cors, "content-type": "text/markdown; charset=utf-8" },
      body: `# Local ${name}\n\nRead from the machine, not the workspace.\n`,
    })
  })
}

function composer(page: Page) {
  return page.getByTestId("project-composer-input").or(page.getByTestId("home-composer-input"))
}

function fileChip(page: Page, name: string) {
  return page.getByTestId("chat-file-chip").filter({ hasText: name }).last()
}

async function send(page: Page, text: string) {
  const dismiss = page.getByRole("button", { name: "Dismiss error" })
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
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

const ROOT = "C:/Users/russe/AppData/Roaming/Shogo/data/workspaces/.workspace-roots/abc/assets/demo"

test.describe("Local file shapes in the workspace chat", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let newTabs = 0

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    page = await browser.newPage()
    page.context().on("page", () => {
      newTabs += 1
    })
    await page.setViewportSize({ width: 1280, height: 800 })
    await installChatMock(page)
    await installLocalFileMock(page)
    await page.goto("/")
    await composer(page).waitFor({ state: "visible", timeout: 60_000 })

    const workspaces = await apiJson(page, "GET", "/api/workspaces")
    const list =
      workspaces.json?.items ?? workspaces.json?.data ?? workspaces.json?.workspaces ?? workspaces.json
    const rows = Array.isArray(list) ? list : []
    const workspace = rows.find((row: { kind?: string }) => row.kind === "personal") ?? rows[0]
    expect(workspace?.id, `workspace list ${workspaces.status}`).toBeTruthy()
    const primary = await apiJson(page, "POST", `/api/workspaces/${workspace.id}/sessions/primary`, {})
    expect(primary.json?.session?.id, JSON.stringify(primary.json)).toBeTruthy()
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test("all three shapes are chips, and each opens its file in the side pane", async () => {
    const backticked = `${ROOT}/qa-win-code.md`
    const autolinked = `${ROOT}/qa-win-angle.md`
    const drive = "C:\\Users\\russe\\docs\\qa-win-drive.md"
    nextReply = [
      "Three local files:",
      "",
      `- \`file:///${backticked}\``,
      `- <file:///${autolinked}>`,
      `- saved at ${drive} just now`,
    ].join("\n")
    await send(page, "Where are the files?")

    const shapes: Array<{ name: string; path: string }> = [
      { name: "qa-win-code.md", path: backticked },
      { name: "qa-win-angle.md", path: autolinked },
      { name: "qa-win-drive.md", path: "C:/Users/russe/docs/qa-win-drive.md" },
    ]

    for (const shape of shapes) {
      const chip = fileChip(page, shape.name)
      await expect(chip).toBeVisible({ timeout: 30_000 })
      // A local file is the app's chip, not a code span and not a link out.
      expect(await chip.getAttribute("data-file-kind")).toBe("local")
    }
    // The backticked URL is a chip, so nothing on screen is still `file://…`
    // code, and no `<` or `>` survived the autolink.
    await expect(page.getByText(/file:\/\//)).toHaveCount(0)
    await expect(page.locator("code", { hasText: "qa-win-code.md" })).toHaveCount(0)

    for (const shape of shapes) {
      await fileChip(page, shape.name).click()

      const pane = page.getByTestId("workspace-share-file-pane")
      await expect(pane).toBeVisible({ timeout: 30_000 })
      await expect(pane.getByRole("heading", { name: `Local ${shape.name}` })).toBeVisible({
        timeout: 30_000,
      })
      await expect(pane.getByTestId("share-file-error")).toHaveCount(0)

      // The pane asked the local-only route for the drive path with forward
      // slashes: a `/shogo-file` project path could not name it.
      expect(localFileRequests[localFileRequests.length - 1]).toBe(shape.path)
      expect(new URL(page.url()).pathname).toBe("/")
    }

    // Clicking a chip never leaves the app.
    expect(newTabs).toBe(0)
    expect(localFileRequests.every((path) => !path.includes("\\"))).toBe(true)
  })
})
