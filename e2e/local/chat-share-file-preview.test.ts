// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page, type Route } from "@playwright/test"

/**
 * Russell's bug, end to end: a `share_file` link to an `.mp4` in the workspace
 * agent chat opened "No preview for this file type." (SHO-165).
 *
 * The whole click path is real — markdown link → in-app file chip → the chat's
 * right-hand file pane → the fetch → the shared file body → the IDE's own
 * video/audio preview and markdown Preview/Source. Only the bytes behind
 * `/api/f/<token>` are fulfilled by the test, so the spec can answer
 * `application/octet-stream` (the desktop route before its MIME fix, or any
 * upstream bucket that does) and prove the file name still decides.
 *
 * The token is a real base64url payload with a `path` claim, which is what the
 * chip reads its name from; the signature is not checked by the app.
 *
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *   npx playwright test --config e2e/local/playwright.config.ts chat-share-file-preview
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

interface ShareFixture {
  /** What the file is called — the chip and the classifier both read it. */
  name: string
  status?: number
  contentType?: string
  body: string | Buffer
}

/** `/api/f/<token>` answers from here, so a spec can shape each download. */
const fixtures = new Map<string, ShareFixture>()

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

/** A share link whose token claims the path the chip shows a name for. */
function shareHref(path: string): string {
  const payload = base64url(
    JSON.stringify({ typ: "file", projectId: "proj-qa", workspaceId: "ws-qa", path }),
  )
  return `/api/f/${payload}.qa-signature`
}

function registerFixture(path: string, fixture: ShareFixture): string {
  const href = shareHref(path)
  const token = href.slice("/api/f/".length)
  fixtures.set(token, { name: path.split("/").pop() ?? path, ...fixture })
  return href
}

async function installFileMock(page: Page) {
  await page.route("**/api/f/*", async (route: Route) => {
    const token = new URL(route.request().url()).pathname.split("/").pop() ?? ""
    const fixture = fixtures.get(token)
    // A cross-origin download with `credentials: include` needs the origin
    // echoed back; the API sends the same two headers in local mode.
    const cors = {
      "access-control-allow-origin": route.request().headers()["origin"] ?? "*",
      "access-control-allow-credentials": "true",
      "cache-control": "private, no-store",
    }
    if (!fixture) {
      await route.fulfill({
        status: 404,
        headers: { ...cors, "content-type": "application/json" },
        body: JSON.stringify({ error: { code: "file_not_found", message: "File not found" } }),
      })
      return
    }
    await route.fulfill({
      status: fixture.status ?? 200,
      headers: {
        ...cors,
        "content-type": fixture.contentType ?? "application/octet-stream",
      },
      body: fixture.body,
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
  // Expo's dev overlay sits above the app when any uncaught rejection reaches
  // the page (Monaco's dispose path emits a cancelled promise). It is a dev
  // artifact, not part of the feature under test: close it so the click lands.
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

test.describe("A share_file link in the workspace chat", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 800 })
    await installChatMock(page)
    await installFileMock(page)
    await page.goto("/")
    await composer(page).waitFor({ state: "visible", timeout: 60_000 })

    // The workspace chat is the personal workspace's primary session.
    const workspaces = await apiJson(page, "GET", "/api/workspaces")
    const list = workspaces.json?.items ?? workspaces.json?.data ?? workspaces.json?.workspaces ?? workspaces.json
    const rows = Array.isArray(list) ? list : []
    const workspace = rows.find((row: { kind?: string }) => row.kind === "personal") ?? rows[0]
    expect(workspace?.id, `workspace list ${workspaces.status}`).toBeTruthy()
    const primary = await apiJson(page, "POST", `/api/workspaces/${workspace.id}/sessions/primary`, {})
    expect(primary.json?.session?.id, JSON.stringify(primary.json)).toBeTruthy()
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test("an .mp4 opens in the right-hand pane and plays, even when the server says octet-stream", async () => {
    const href = registerFixture("media/qa-clip.mp4", {
      contentType: "application/octet-stream",
      body: Buffer.from("\u0000\u0000\u0000\u0018ftypisom-qa-fixture-bytes"),
    })
    nextReply = `Rendered the clip.\n\n[QA clip](${href})`
    await send(page, "Share the clip")

    const chip = fileChip(page, "qa-clip.mp4")
    await expect(chip).toBeVisible({ timeout: 30_000 })
    // The chip is the in-app opener (SHO-80); without the chat's provider this
    // would be a plain link that leaves the app.
    expect(await chip.getAttribute("data-file-kind")).toBe("share")
    await chip.click()

    await expect(page.getByTestId("workspace-share-file-pane")).toBeVisible({ timeout: 30_000 })
    const pane = page.getByTestId("workspace-share-file-pane")
    const video = pane.locator("video")
    await expect(video).toHaveCount(1, { timeout: 30_000 })
    await expect(video).toHaveAttribute("controls", "")
    const src = await video.getAttribute("src")
    expect(src?.startsWith("blob:")).toBe(true)

    // The blob carries the type the name implies, not the octet-stream answer:
    // without that the browser has no decoder to pick.
    const blobType = await page.evaluate(async (url) => {
      const response = await fetch(url)
      const blob = await response.blob()
      return blob.type
    }, src!)
    expect(blobType).toBe("video/mp4")

    await expect(pane.getByText("No preview for this file type.")).toHaveCount(0)
    // It opened in the pane, not in a modal or a browser tab.
    expect(new URL(page.url()).pathname).toBe("/")
  })

  test("an .mp3 opens an <audio controls> in the pane", async () => {
    const href = registerFixture("media/qa-take.mp3", {
      contentType: "audio/mpeg",
      body: Buffer.from("ID3-qa-fixture-bytes"),
    })
    nextReply = `Voice memo:\n\n[QA take](${href})`
    await send(page, "Share the take")

    const chip = fileChip(page, "qa-take.mp3")
    await expect(chip).toBeVisible({ timeout: 30_000 })
    await chip.click()

    const pane = page.getByTestId("workspace-share-file-pane")
    const audio = pane.locator("audio")
    await expect(audio).toHaveCount(1, { timeout: 30_000 })
    await expect(audio).toHaveAttribute("controls", "")
    expect((await audio.getAttribute("src"))?.startsWith("blob:")).toBe(true)
  })

  test("a .md opens on Preview, and its Source toggle is read-only", async () => {
    const href = registerFixture("docs/qa-plan.md", {
      contentType: "text/markdown",
      body: "# QA Preview Heading\n\nA paragraph the preview must render.\n",
    })
    nextReply = `Plan is here:\n\n[QA plan](${href})`
    await send(page, "Share the plan")

    const chip = fileChip(page, "qa-plan.md")
    await expect(chip).toBeVisible({ timeout: 30_000 })
    await chip.click()

    const pane = page.getByTestId("workspace-share-file-pane")
    await expect(pane).toBeVisible({ timeout: 30_000 })
    await expect(pane.getByRole("heading", { name: "QA Preview Heading" })).toBeVisible({
      timeout: 30_000,
    })

    // A viewer never offers to edit the file it was handed.
    await expect(pane.getByTestId("ide-md-mode-edit")).toHaveCount(0)
    const source = pane.getByTestId("file-view-md-mode-source")
    await expect(source).toBeVisible()
    await source.click()

    const editor = pane.locator(".monaco-editor").first()
    await expect(editor).toBeVisible({ timeout: 30_000 })
    // `domReadOnly` reaches the DOM: the input surface refuses input outright.
    await expect
      .poll(
        async () =>
          await editor
            .locator("textarea")
            .first()
            .evaluate((node) => node.hasAttribute("readonly")),
        { timeout: 20_000 },
      )
      .toBe(true)

    await editor.click()
    await page.keyboard.type("QA-TYPED-TEXT")
    await expect(page.getByText("QA-TYPED-TEXT")).toHaveCount(0)

    // And the source is the file, not the rendered view.
    await pane.getByTestId("ide-md-mode-preview").click()
    await expect(pane.getByRole("heading", { name: "QA Preview Heading" })).toBeVisible()
    await expect(pane.getByText("QA-TYPED-TEXT")).toHaveCount(0)
  })

  test("an expired link still says so in the pane and offers Retry, never raw JSON", async () => {
    const href = registerFixture("media/qone.mp4", {
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "expired", message: "This download link has expired" } }),
    })
    nextReply = `Old link:\n\n[gone](${href})`
    await send(page, "Open the old link")

    const chip = fileChip(page, "qone.mp4")
    await expect(chip).toBeVisible({ timeout: 30_000 })
    await chip.click()

    const pane = page.getByTestId("workspace-share-file-pane")
    await expect(pane.getByTestId("share-file-error")).toContainText("Link expired", {
      timeout: 30_000,
    })
    await expect(pane.getByTestId("share-file-retry")).toBeVisible()
    await expect(pane.getByText(/"error"\s*:/)).toHaveCount(0)
  })
})
