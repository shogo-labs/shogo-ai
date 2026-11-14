// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { readFileSync } from "fs"
import { join } from "path"
import { test, expect, type Page, type Route } from "@playwright/test"

/**
 * SHO-387, end to end: clicking a video `share_file` link must start playing
 * without pulling the whole file down first.
 *
 * The viewer used to `fetch()` the link, buffer the entire body and hand the
 * `<video>` a `blob:` URL, so a 300 MB mp4 downloaded in full before the first
 * frame. Now it sends one `Range: bytes=0-0` probe (for the error UX and the
 * size) and points the element at the link itself, so the player streams.
 *
 * This spec answers `/api/f/<token>` with a real mp4 fixture and byte-range
 * semantics, and records every request it serves. The assertions are what the
 * browser can actually observe:
 *   - the link is probed with `bytes=0-0` and answered 206,
 *   - the `<video>` `src` is the link, never `blob:`,
 *   - the element asks for its own ranges, and no request is answered as a
 *     whole-file 200 (the fixture refuses to serve a video without a range),
 *   - the file plays (`readyState >= 2`) and the pane's size came from
 *     `Content-Range`, i.e. the client never read the body.
 *
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *   npx playwright test --config e2e/local/playwright.config.ts chat-share-video-streams
 */

const API = process.env.E2E_API_URL || "http://localhost:8002"

/** A real, decodable mp4: the element has to actually play it. */
const MP4 = readFileSync(
  join(__dirname, "../../apps/api/src/__tests__/fixtures/video/blue-up.mp4"),
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

interface Served {
  /** The `Range` the app sent, or null when it asked for the whole file. */
  range: string | null
  status: number
}

/** `/api/f/<token>` answers from here and records what the app asked for. */
const fixtures = new Map<string, { body: Buffer; status?: number; contentType?: string }>()
const served: Served[] = []

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

function shareHref(path: string): string {
  const payload = base64url(
    JSON.stringify({ typ: "file", projectId: "proj-qa", workspaceId: "ws-qa", path }),
  )
  return `/api/f/${payload}.qa-signature`
}

function registerFixture(
  path: string,
  fixture: { body: Buffer; status?: number; contentType?: string },
): string {
  const href = shareHref(path)
  fixtures.set(href.slice("/api/f/".length), fixture)
  return href
}

function corsHeaders(route: Route): Record<string, string> {
  return {
    "access-control-allow-origin": route.request().headers()["origin"] ?? "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "cache-control": "private, no-store",
  }
}

async function installFileMock(page: Page) {
  await page.route("**/api/f/*", async (route: Route) => {
    const cors = corsHeaders(route)
    // The probe adds `Range`, which is not a CORS-safelisted request header, so
    // the browser asks first — and the real API answers it (server.ts allows
    // `*` headers for an allowed origin).
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors })
      return
    }

    const token = new URL(route.request().url()).pathname.split("/").pop() ?? ""
    const fixture = fixtures.get(token)
    if (!fixture) {
      served.push({ range: route.request().headers()["range"] ?? null, status: 404 })
      await route.fulfill({
        status: 404,
        headers: { ...cors, "content-type": "application/json" },
        body: JSON.stringify({ error: { code: "file_not_found", message: "File not found" } }),
      })
      return
    }
    if (fixture.status && fixture.status >= 400) {
      served.push({ range: route.request().headers()["range"] ?? null, status: fixture.status })
      await route.fulfill({
        status: fixture.status,
        headers: { ...cors, "content-type": fixture.contentType ?? "application/json" },
        body: JSON.stringify({ error: { code: "expired", message: "This download link has expired" } }),
      })
      return
    }

    const body = fixture.body
    const size = body.length
    const contentType = fixture.contentType ?? "video/mp4"
    const range = route.request().headers()["range"] ?? null
    const headers = { ...cors, "content-type": contentType, "accept-ranges": "bytes" }

    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
    if (!range || !match) {
      // A video route that answers a whole-file 200 is exactly the bug: record
      // it as such, the assertions below refuse it.
      served.push({ range, status: 200 })
      await route.fulfill({
        status: 200,
        headers: { ...headers, "content-length": String(size) },
        body,
      })
      return
    }

    const [, rawStart, rawEnd] = match
    const start = rawStart ? Number(rawStart) : Math.max(0, size - Number(rawEnd))
    const end = rawStart && rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1
    if (start >= size) {
      served.push({ range, status: 416 })
      await route.fulfill({ status: 416, headers: { ...headers, "content-range": `bytes */${size}` } })
      return
    }
    const slice = body.subarray(start, end + 1)
    served.push({ range, status: 206 })
    await route.fulfill({
      status: 206,
      headers: {
        ...headers,
        "content-length": String(slice.length),
        "content-range": `bytes ${start}-${end}/${size}`,
      },
      body: slice,
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

test.describe("A video share_file link in chat streams instead of downloading", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    served.length = 0
    page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 800 })
    await installChatMock(page)
    await installFileMock(page)
    await page.goto("/")
    await composer(page).waitFor({ state: "visible", timeout: 120_000 })
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("an .mp4 plays from the link over byte ranges, never from a blob", async () => {
    test.setTimeout(180_000)
    served.length = 0
    const href = registerFixture("media/qa-clip.mp4", { body: MP4 })
    nextReply = `Clip:\n\n[QA clip](${href})`
    await send(page, "Share the clip")

    const chip = fileChip(page, "qa-clip.mp4")
    await expect(chip).toBeVisible({ timeout: 30_000 })
    expect(await chip.getAttribute("data-file-kind")).toBe("share")
    await chip.click()

    const pane = page.getByTestId("workspace-share-file-pane")
    await expect(pane).toBeVisible({ timeout: 30_000 })
    const video = pane.locator("video")
    await expect(video).toHaveCount(1, { timeout: 30_000 })

    // The element streams the link itself. A blob URL here is the old bug:
    // it can only exist after the whole body has been buffered into memory.
    const src = await video.getAttribute("src")
    expect(src ?? "").not.toContain("blob:")
    expect(src).toBe(href)

    // One `bytes=0-0` probe first, answered 206 with the total size — that is
    // what the pane's size line is built from, without reading the body.
    await expect
      .poll(() => served.length, { timeout: 20_000 })
      .toBeGreaterThan(0)
    expect(served[0]).toEqual({ range: "bytes=0-0", status: 206 })
    await expect(pane.getByText(/4 KB/)).toBeVisible({ timeout: 20_000 })

    // It really plays, and every request it made while playing was a range.
    await expect
      .poll(async () => await video.evaluate((el) => (el as HTMLVideoElement).readyState), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(2)
    await expect
      .poll(() => served.filter((entry) => entry.range === null).length, { timeout: 10_000 })
      .toBe(0)

    // It opened in the pane, not in a modal or a browser tab.
    expect(new URL(page.url()).pathname).toBe("/")
    await expect(pane.getByText("No preview for this file type.")).toHaveCount(0)
  })

  test("a dead video link still shows the API's code, not a broken player", async () => {
    test.setTimeout(180_000)
    served.length = 0
    const href = registerFixture("media/qa-gone.mp4", {
      body: MP4,
      status: 410,
      contentType: "application/json",
    })
    nextReply = `Old clip:\n\n[QA gone](${href})`
    await send(page, "Open the old clip")

    const chip = fileChip(page, "qa-gone.mp4")
    await expect(chip).toBeVisible({ timeout: 30_000 })
    await chip.click()

    const pane = page.getByTestId("workspace-share-file-pane")
    await expect(pane.getByTestId("share-file-error")).toBeVisible({ timeout: 30_000 })
    await expect(pane.getByTestId("share-file-error")).toContainText("Link expired")
    await expect(pane.locator("video")).toHaveCount(0)
    await expect(pane.getByText(/"error"\s*:/)).toHaveCount(0)
    await expect(pane.getByTestId("share-file-retry")).toBeVisible()
  })
})
