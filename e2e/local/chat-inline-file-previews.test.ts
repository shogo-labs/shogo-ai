// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page, type Route } from "@playwright/test"

/**
 * Russell's bug, end to end: a picture or a clip an agent shared into chat was
 * only a name chip, and on a phone the tap led to "no preview" (SHO-388).
 *
 * A message body really carries the `share_file` link — `[QA picture](/api/f/…)`
 * or the bare URL, which is what an agent pastes — so the whole path is real:
 * markdown → `extractInlineMediaLinks` → the card under the text → the chat's
 * file pane. Only the bytes behind `/api/f/<token>` are fulfilled here, so the
 * spec can serve a real PNG, an MP4 and a dead link without a workspace.
 *
 * The token is a base64url payload with a `path` claim — that is where the card
 * reads the file's name from; the signature is not verified by the app.
 *
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *   npx playwright test --config e2e/local/playwright.config.ts chat-inline-file-previews
 */

const API = process.env.E2E_API_URL || "http://localhost:8002"

/** A real 1x1 PNG: a `<img>` only proves it drew when the bytes decode. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

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
  status?: number
  contentType?: string
  body: string | Buffer
}

/** `/api/f/<token>` answers from here, so a spec can shape each download. */
const fixtures = new Map<string, ShareFixture>()

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

/** A share link whose token claims the path the card and the chip name. */
function shareHref(path: string): string {
  const payload = base64url(
    JSON.stringify({ typ: "file", projectId: "proj-qa", workspaceId: "ws-qa", path }),
  )
  return `/api/f/${payload}.qa-signature`
}

function registerFixture(path: string, fixture: ShareFixture): string {
  const href = shareHref(path)
  const token = href.slice("/api/f/".length)
  fixtures.set(token, fixture)
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

function preview(page: Page, kind: "image" | "video") {
  return page.getByTestId(`chat-file-preview-${kind}`).last()
}

/** The pane and the phone modal are one view; either satisfies "in-app". */
function viewer(page: Page) {
  return page.getByTestId("workspace-share-file-pane").or(page.getByTestId("share-file-view"))
}

async function closeViewer(page: Page) {
  const close = page.getByTestId("share-file-close").last()
  if (await close.isVisible().catch(() => false)) {
    await close.click()
    await expect(page.getByTestId("share-file-view")).toHaveCount(0)
  }
}

async function send(page: Page, text: string) {
  // Expo's dev overlay sits above the app when any uncaught rejection reaches
  // the page. It is a dev artifact, not part of the feature under test.
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

test.describe("A message that links a picture and a clip", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 800 })
    await installChatMock(page)
    await installFileMock(page)
    await page.goto("/")
    await composer(page).waitFor({ state: "visible", timeout: 90_000 })

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

  test("draws the picture and the clip under the text, with the chips still inline", async () => {
    const picture = registerFixture("media/qa-picture.png", {
      contentType: "image/png",
      body: PNG_BYTES,
    })
    const clip = registerFixture("media/qa-clip.mp4", {
      contentType: "video/mp4",
      body: Buffer.from("\u0000\u0000\u0000\u0018ftypisom-qa-fixture-bytes"),
    })
    nextReply = `Here they are.\n\n[QA picture](${picture})\n\n[QA clip](${clip})`
    await send(page, "Share the picture and the clip")

    await expect(fileChip(page, "qa-picture.png")).toBeVisible({ timeout: 30_000 })

    // AC1: both cards, drawn under the body — the chips stay where they were.
    const image = preview(page, "image")
    await expect(image).toBeVisible({ timeout: 30_000 })
    await expect(preview(page, "video")).toBeVisible({ timeout: 30_000 })
    await expect(fileChip(page, "qa-clip.mp4")).toBeVisible()

    // The thumbnail really decoded the served bytes; a card that could not
    // would show the "Preview unavailable" row instead.
    const drawnWidth = await image
      .locator("img")
      .first()
      .evaluate((node) => (node as HTMLImageElement).naturalWidth)
    expect(drawnWidth).toBeGreaterThan(0)

    // AC4: the poster card streams metadata — it is never a downloaded blob.
    const videoSrc = await preview(page, "video").locator("video").first().getAttribute("src")
    expect(videoSrc).toBeTruthy()
    expect(videoSrc?.startsWith("blob:")).toBe(false)
  })

  test("a tap opens the app's viewer, never a browser tab", async () => {
    await preview(page, "image").click()

    // AC2: the file is shown in-app — the conversation's pane on a wide screen.
    const view = viewer(page)
    await expect(view.first()).toBeVisible({ timeout: 30_000 })
    await expect(view.first().getByTestId("share-file-error")).toHaveCount(0)
    await expect
      .poll(async () => await view.first().locator("img").count(), { timeout: 20_000 })
      .toBeGreaterThan(0)
    expect(new URL(page.url()).pathname).toBe("/")

    await closeViewer(page)
  })

  test("a dead link says so in the card and still opens on the API's code", async () => {
    const gone = registerFixture("media/qone.png", {
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "expired", message: "This download link has expired" } }),
    })
    nextReply = `Old picture:\n\n[gone](${gone})`
    await send(page, "Show the old picture")

    // AC5: the card degrades to a row that still opens the viewer.
    const unavailable = page.getByText("Preview unavailable · qone.png").last()
    await expect(unavailable).toBeVisible({ timeout: 30_000 })

    await unavailable.click()
    const view = viewer(page)
    await expect(view.first()).toBeVisible({ timeout: 30_000 })
    await expect(view.first().getByTestId("share-file-error")).toContainText("Link expired", {
      timeout: 30_000,
    })
    await expect(view.first().getByText(/"error"\s*:/)).toHaveCount(0)

    await closeViewer(page)
  })

  test("a 390px thread still draws the preview, inside the bubble", async () => {
    // AC1 on a phone: the same cards, sized to the thread. No reload — the
    // cards must survive the layout change, which is what a phone rotation or
    // a narrow window does.
    await page.setViewportSize({ width: 390, height: 844 })

    const image = preview(page, "image")
    await expect(image).toBeVisible()
    const box = await image.boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(80)
    // The card must fit the bubble, not overflow the screen.
    expect(box?.width ?? 0).toBeLessThanOrEqual(390)

    await image.click()
    await expect(viewer(page).first()).toBeVisible({ timeout: 30_000 })
    expect(new URL(page.url()).pathname).toBe("/")
  })
})
