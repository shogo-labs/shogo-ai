// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page, type Route } from "@playwright/test"

/**
 * File paths in an assistant message open the project's IDE.
 *
 * The model reply is a mocked SSE turn (no provider). The project, the
 * fixture files, and the save round-trip go through the real local API.
 *
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *   npx playwright test --config e2e/local/playwright.config.ts chat-file-deep-link
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

test.describe("Chat file deep links", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let projectId: string
  const report = "# E2E Report Heading\n\nA paragraph the preview should render.\n"

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 800 })
    await installChatMock(page)
    await page.goto("/")
    await composer(page).waitFor({ state: "visible", timeout: 30_000 })

    const workspaces = await apiJson(page, "GET", "/api/workspaces")
    const list = workspaces.json?.items ?? workspaces.json?.data ?? workspaces.json?.workspaces ?? workspaces.json
    const rows = Array.isArray(list) ? list : []
    const workspace = rows.find((row: { kind?: string }) => row.kind === "personal") ?? rows[0]
    expect(workspace?.id, `workspace list ${workspaces.status}`).toBeTruthy()

    const sessionRes = await page.request.get(`${API}/api/auth/get-session`)
    const session = await sessionRes.json().catch(() => null)
    const userId = session?.user?.id as string | undefined

    const created = await apiJson(page, "POST", "/api/projects", {
      name: "E2E file deep link",
      workspaceId: workspace.id,
      createdBy: userId,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
      schemas: [],
      settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
    })
    projectId = created.json?.data?.id ?? created.json?.id
    expect(projectId, JSON.stringify(created.json)).toBeTruthy()

    for (const [path, content] of [
      ["E2E-REPORT.md", report],
      ["src/e2e-fixture.ts", "export const fixture = true\n"],
    ] as const) {
      const written = await apiJson(page, "PUT", `/api/projects/${projectId}/files/${path}`, { content })
      expect(written.status, written.json?.error?.message).toBeLessThan(300)
    }

    const primary = await apiJson(page, "POST", `/api/workspaces/${workspace.id}/sessions/primary`, {})
    const sessionId = primary.json?.session?.id
    expect(sessionId, JSON.stringify(primary.json)).toBeTruthy()
    const attached = await apiJson(
      page,
      "POST",
      `/api/workspaces/${workspace.id}/sessions/${sessionId}/projects`,
      { projectId, attachMode: "readwrite" },
    )
    expect(attached.status, JSON.stringify(attached.json)).toBeLessThan(300)

    await page.reload()
    await composer(page).waitFor({ state: "visible", timeout: 30_000 })
  })

  test.afterAll(async () => {
    if (projectId) {
      await page.request.delete(`${API}/api/projects/${projectId}`).catch(() => {})
    }
    await page?.close()
  })

  test("workspace chat opens a markdown file in the IDE preview", async () => {
    nextReply = `Done — report written to the project folder:\n\n${projectId}/E2E-REPORT.md (3 lines)`
    await send(page, "Write the report")

    const link = page.getByTestId("chat-file-link").filter({ hasText: "E2E-REPORT.md" })
    await expect(link).toBeVisible({ timeout: 20_000 })
    await link.click()

    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}`), { timeout: 20_000 })
    await expect(page).toHaveURL(/tab=ide/)
    await expect(page.getByText("E2E-REPORT.md").first()).toBeVisible({ timeout: 30_000 })
    const preview = page.getByTestId("ide-md-preview")
    await expect(preview).toBeVisible({ timeout: 30_000 })
    await expect(preview.getByRole("heading", { name: "E2E Report Heading" })).toBeVisible()
    await expect(preview.locator(".monaco-editor")).toHaveCount(0)
  })

  test("edit mode saves the markdown back to disk", async () => {
    await page.getByTestId("ide-md-mode-edit").click()
    const editor = page.locator(".monaco-editor").last()
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.press("Meta+ArrowDown")
    await page.keyboard.type("\nE2E edited line")
    await page.keyboard.press("Meta+s")

    await expect
      .poll(async () => {
        const read = await apiJson(page, "GET", `/api/projects/${projectId}/files/E2E-REPORT.md`)
        return read.json?.content ?? ""
      }, { timeout: 20_000 })
      .toContain("E2E edited line")

    await page.getByTestId("ide-md-mode-preview").click()
    await expect(page.getByTestId("ide-md-preview")).toContainText("E2E edited line")
  })

  test("a non-markdown path opens straight in the code editor", async () => {
    nextReply = `Updated \`${projectId}/src/e2e-fixture.ts\``
    await send(page, "Show the fixture")
    const link = page.getByTestId("chat-file-link").filter({ hasText: "e2e-fixture.ts" })
    await expect(link).toBeVisible({ timeout: 20_000 })
    await link.click()
    await expect(page.getByText("e2e-fixture.ts").first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(".monaco-editor").last()).toBeVisible()
    await expect(page.getByTestId("ide-md-mode-edit")).toHaveCount(0)
  })

  test("a path clicked inside the project chat stays on the project", async () => {
    const before = page.url()
    nextReply = `Done — report written to the project folder:\n\n${projectId}/E2E-REPORT.md (3 lines)`
    await send(page, "Open the report again")
    const link = page.getByTestId("chat-file-link").filter({ hasText: "E2E-REPORT.md" }).last()
    await expect(link).toBeVisible({ timeout: 20_000 })
    await link.click()
    await expect(page.getByTestId("ide-md-preview")).toBeVisible()
    expect(new URL(page.url()).pathname).toBe(new URL(before).pathname)
  })

  test("urls and fenced paths are not file links", async () => {
    nextReply = "Use and/or here, see https://example.com/a.md, and\n```\nfoo/bar.md\n```"
    await send(page, "No files this time")
    await expect(page.getByText("https://example.com/a.md")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("chat-file-link").filter({ hasText: "foo/bar.md" })).toHaveCount(0)
    await expect(page.getByTestId("chat-file-link").filter({ hasText: "example.com" })).toHaveCount(0)
    await expect(page.locator('a[href^="https://example.com/a.md"]')).toBeVisible()
  })
})
