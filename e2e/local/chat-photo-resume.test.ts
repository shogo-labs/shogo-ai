// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { deflateSync } from "zlib"
import { expect, test, type Page } from "@playwright/test"
import { openTeamHome } from "./helpers"

/**
 * A photo-heavy agent chat must resume at the bottom and stay there (SHO-407).
 *
 * The unit and RTL specs pin the pieces: `prepareOutgoingFiles` stores a size
 * and a preview, `ImageThumbnail` sizes from the stored size alone, the loader
 * caches and dedupes, and `decideContentSizeChange` settles the first layout.
 * What only a browser can prove is the thing Russell actually reported — that
 * opening a chat with a dozen photos lands at the bottom on the first frame and
 * the offset does not move afterwards, because the thumbnails never change the
 * content height and never ask for the original.
 *
 * The fixture is the persisted shape: every photo part carries `width`,
 * `height` and a `previewUrl`, exactly as `prepareOutgoingFiles` writes them.
 * The previews are served slowly so the transcript has laid out before any of
 * them arrive — the window in which a resizing thumbnail used to pull the
 * reader down.
 *
 *   npx playwright test --config e2e/local/playwright.config.ts chat-photo-resume
 */

test.use({ video: "off", trace: "off" })

/** Photos in the fixture chat. Russell's report was "10+". */
const PHOTO_COUNT = 12
/** Stored size of every photo: 16:9, so the height cap decides the box. */
const PHOTO_WIDTH = 1600
const PHOTO_HEIGHT = 900
/** The box `fitChatImage` gives a 1600×900 photo: height-capped at 260. */
const EXPECTED_WIDTH = 462
const EXPECTED_HEIGHT = 260
/** How long a preview takes to arrive, so it lands after the first layout. */
const PREVIEW_DELAY_MS = 800
/** A height or offset may not move by more than this across the whole load. */
const STABLE_TOLERANCE = 2

const TAIL_MARKER = "photo-chat-tail-marker"
const LEGACY_MARKER = "photo-chat-legacy-marker"
const CHAT_POST_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"
const STREAM_GLOB = "**/api/{projects,workspaces}/*/chat/*/stream*"
const MESSAGES_GLOB = "**/api/chat-messages**"
const DOWNLOAD_GLOB = "**/agent/workspace/download/**"

const previewPath = (index: number) => `/agent/workspace/download/.previews/photo-${index}-preview.jpg`
const originalPath = (index: number) => `/agent/workspace/download/orig/photo-${index}.png`

function crc32(buffer: Buffer): number {
  let crc = ~0
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A real greyscale PNG of the given size — true natural pixels, tiny on the wire. */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  const scanline = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 0x80)])
  const raw = Buffer.concat(Array.from({ length: height }, () => scanline))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/**
 * The transcript's scroll container, found from a marker it renders: the
 * nearest ancestor that actually scrolls. The panel has no test id for it, and
 * a hard-coded class would break on the next layout change.
 */
const FIND_SCROLLER = `function (marker) {
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  var node = walker.nextNode()
  var anchor = null
  while (node) {
    if (node.textContent && node.textContent.indexOf(marker) !== -1) {
      anchor = node.parentElement
      break
    }
    node = walker.nextNode()
  }
  if (!anchor) return null
  var el = anchor
  while (el && el !== document.body) {
    var style = getComputedStyle(el)
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20) return el
    el = el.parentElement
  }
  return null
}`

/**
 * Sample the transcript's offset and content height on every frame, from the
 * moment the tail turn is in the DOM. A single `scrollTop` read after the fact
 * cannot tell "landed at the bottom once" from "was pulled down four times and
 * happened to end up there", which is the whole bug.
 */
const SAMPLE_TRANSCRIPT = `function (marker) {
  window.__e2ePhotoSamples = []
  var started = false
  function tick() {
    if (!started) {
      var el = window.__e2eFindScroller(marker)
      if (!el) { requestAnimationFrame(tick); return }
      started = true
      window.__e2ePhotoScroller = el
    }
    var scroller = window.__e2ePhotoScroller
    var sample = {
      top: scroller.scrollTop,
      height: scroller.scrollHeight,
      viewport: scroller.clientHeight,
      at: performance.now(),
    }
    // Every frame, not only the changes: a transcript that never moves still
    // has to produce a series to assert on.
    window.__e2ePhotoSamples.push(sample)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}`

function sseFrame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

function completedTurn(messageId: string, text: string): string {
  return [
    sseFrame({ type: "start", messageId }),
    sseFrame({ type: "start-step" }),
    sseFrame({ type: "text-start", id: `${messageId}-t` }),
    sseFrame({ type: "text-delta", id: `${messageId}-t`, delta: text }),
    sseFrame({ type: "text-end", id: `${messageId}-t` }),
    sseFrame({ type: "finish-step" }),
    sseFrame({ type: "finish" }),
  ].join("")
}

function savedRow(
  id: string,
  role: "user" | "assistant",
  parts: unknown[],
  createdAt: number,
): Record<string, unknown> {
  const text = parts.map((part) => (part as { text?: string }).text ?? "").join("\n")
  return {
    id,
    sessionId: "",
    role,
    content: text,
    parts: JSON.stringify(parts),
    createdAt,
    updatedAt: createdAt,
  }
}

/**
 * The fixture: one user turn per photo, each carrying the persisted part shape,
 * plus a legacy turn whose part has no stored size and no preview — the shape
 * every message sent before SHO-407 has.
 */
function chatRows(legacyDataUrl: string): Array<Record<string, unknown>> {
  const base = Date.now() - (PHOTO_COUNT + 1) * 60_000
  const rows: Array<Record<string, unknown>> = []
  for (let index = 0; index < PHOTO_COUNT; index++) {
    const tail = index === PHOTO_COUNT - 1 ? `\n\n${TAIL_MARKER}` : ""
    rows.push(
      savedRow(
        `u${index}`,
        "user",
        [
          { type: "text", text: `photo ${index}${tail}` },
          {
            type: "file",
            mediaType: "image/png",
            url: originalPath(index),
            previewUrl: previewPath(index),
            name: `photo-${index}.png`,
            width: PHOTO_WIDTH,
            height: PHOTO_HEIGHT,
          },
        ],
        base + index * 60_000,
      ),
      savedRow(
        `a${index}`,
        "assistant",
        [{ type: "text", text: `Got photo ${index}.` }],
        base + index * 60_000 + 20_000,
      ),
    )
  }
  rows.push(
    savedRow(
      "u-legacy",
      "user",
      [
        { type: "text", text: `legacy photo\n\n${LEGACY_MARKER}` },
        {
          type: "file",
          mediaType: "image/png",
          url: legacyDataUrl,
          name: "legacy.png",
        },
      ],
      base + PHOTO_COUNT * 60_000,
    ),
    savedRow(
      "a-legacy",
      "assistant",
      [{ type: "text", text: "Got the legacy photo." }],
      base + PHOTO_COUNT * 60_000 + 20_000,
    ),
  )
  return rows
}

interface PhotoChatState {
  rows: Array<Record<string, unknown>>
  sessionId: string | null
  /** Every workspace download the page asked for, in order. */
  downloads: string[]
}

/**
 * Serve the project chat's history from the fixture, its (idle) turn endpoints,
 * and the workspace download route the thumbnails go through.
 */
async function installPhotoChat(page: Page): Promise<PhotoChatState> {
  const state: PhotoChatState = {
    rows: chatRows(`data:image/png;base64,${png(PHOTO_WIDTH, PHOTO_HEIGHT).toString("base64")}`),
    sessionId: null,
    downloads: [],
  }
  await page.addInitScript(`window.__e2eFindScroller = ${FIND_SCROLLER}`)
  await page.addInitScript(`window.__e2eSampleTranscript = ${SAMPLE_TRANSCRIPT}`)

  await page.route(DOWNLOAD_GLOB, async (route) => {
    const url = new URL(route.request().url())
    state.downloads.push(url.pathname)
    // A preview is a small JPEG; the original is the full photo. Serving them
    // differently is what makes "the thumbnail never asked for the original"
    // an assertion rather than a hope.
    const isPreview = url.pathname.includes("/.previews/")
    if (isPreview) await new Promise((resolve) => setTimeout(resolve, PREVIEW_DELAY_MS))
    await route.fulfill({
      status: 200,
      contentType: isPreview ? "image/jpeg" : "image/png",
      body: png(isPreview ? 640 : PHOTO_WIDTH, isPreview ? 360 : PHOTO_HEIGHT),
    })
  })

  await page.route(CHAT_POST_GLOB, async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    state.sessionId =
      state.sessionId ?? route.request().headers()["x-chat-session-id"] ?? null
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: completedTurn("msg_bootstrap", "Bootstrap done."),
    })
  })

  await page.route(TURN_GLOB, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "completed" }),
    })
  })

  await page.route(STREAM_GLOB, async (route) => {
    await route.fulfill({ status: 204, body: "" })
  })

  await page.route(MESSAGES_GLOB, async (route) => {
    const request = route.request()
    if (request.method() !== "GET") return route.continue()
    const url = new URL(request.url())
    const sessionId =
      state.sessionId ?? url.searchParams.get("sessionId") ?? "session-under-test"
    const rows = state.rows.map((row) => ({ ...row, sessionId }))

    if (url.pathname.endsWith("/changes")) {
      const newest = rows.reduce((cursor, row) => Math.max(cursor, Number(row.updatedAt)), 0)
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          items: [],
          total: rows.length,
          cursor: new Date(newest).toISOString(),
          reset: false,
        }),
      })
      return
    }

    const newestFirst = [...rows].sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, items: newestFirst, total: rows.length }),
    })
  })

  return state
}

async function openPhotoChat(page: Page): Promise<PhotoChatState> {
  const state = await installPhotoChat(page)
  await openTeamHome(page)
  const home = page
    .getByTestId("home-composer-input")
    .or(page.getByRole("textbox", { name: "Describe the agent you want to build" }))
  await home.click()
  await home.fill(`Build a photo-heavy E2E project (${PHOTO_COUNT} photos)`)
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 60_000 })
  await expect(page.getByText(TAIL_MARKER, { exact: false }).first()).toBeVisible({
    timeout: 90_000,
  })
  // Start sampling the moment the transcript exists, before the previews land.
  await page.evaluate((marker) => (window as any).__e2eSampleTranscript(marker), TAIL_MARKER)
  return state
}

interface Sample {
  top: number
  height: number
  viewport: number
  at: number
}

async function samples(page: Page): Promise<Sample[]> {
  return page.evaluate(() => (window as any).__e2ePhotoSamples as Sample[])
}

/** Wait until every preview has been requested and the transcript has settled. */
async function waitForPreviews(page: Page, state: PhotoChatState): Promise<void> {
  await expect
    .poll(() => state.downloads.filter((path) => path.includes("/.previews/")).length, {
      timeout: 30_000,
    })
    .toBe(PHOTO_COUNT)
  // Let the last preview paint and any follow-up layout happen.
  await page.waitForTimeout(1_200)
}

/** The rendered box of the nth thumbnail, in transcript order. */
async function thumbnailBox(page: Page, index: number) {
  const node = page.locator('[data-testid="image-thumbnail"]').nth(index)
  await node.scrollIntoViewIfNeeded()
  return node.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { width: box.width, height: box.height }
  })
}

test.describe("a photo-heavy agent chat resumes at the bottom and stays there", () => {
  test("12 photos: the first layout lands at the bottom and the offset never moves", async ({
    page,
  }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    const state = await openPhotoChat(page)
    await waitForPreviews(page, state)

    const series = await samples(page)
    expect(series.length, "the transcript was never sampled").toBeGreaterThan(2)

    // The window that matters is the one the photos load in. The attachment
    // row is measured on its first layout (SHO-170), so the transcript settles
    // its height once before any image arrives; from the frame it reaches its
    // final height, nothing an image does may move it.
    const finalHeight = series[series.length - 1].height
    const settledIndex = series.findIndex((sample) => sample.height >= finalHeight - STABLE_TOLERANCE)
    expect(settledIndex, "the transcript never reached its final height").toBeGreaterThanOrEqual(0)
    const after = series.slice(settledIndex)
    const last = after[after.length - 1]

    // The content height is final before the photos arrive: the thumbnails are
    // already their stored size, so nothing they do can grow the transcript.
    const tallest = Math.max(...after.map((sample) => sample.height))
    const shortest = Math.min(...after.map((sample) => sample.height))
    expect(
      tallest - shortest,
      `the transcript changed height by ${tallest - shortest}px while the photos loaded`,
    ).toBeLessThanOrEqual(STABLE_TOLERANCE)

    // And it landed at the true bottom, not part-way up.
    expect(
      last.top,
      `the transcript settled ${last.height - last.viewport - last.top}px above its bottom`,
    ).toBeGreaterThanOrEqual(last.height - last.viewport - STABLE_TOLERANCE)

    // The offset only ever moved down. A resize that pulled the reader down
    // would show up as a later sample above an earlier one.
    const highest = Math.max(...after.map((sample) => sample.top))
    expect(
      last.top,
      `the transcript was pulled back up: it reached ${highest}px and ended at ${last.top}px`,
    ).toBeGreaterThanOrEqual(highest - STABLE_TOLERANCE)
  })

  test("thumbnails ask for the preview only, once each, and never the original", async ({
    page,
  }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    const state = await openPhotoChat(page)
    await waitForPreviews(page, state)

    const originals = state.downloads.filter((path) => path.includes("/orig/"))
    expect(
      originals,
      `a thumbnail fetched the full-size photo: ${originals.join(", ")}`,
    ).toEqual([])

    const previews = state.downloads.filter((path) => path.includes("/.previews/"))
    expect(previews.length, "a preview was fetched more than once").toBe(PHOTO_COUNT)
    expect(new Set(previews).size, "a preview was fetched more than once").toBe(PHOTO_COUNT)
  })

  test("a stored size makes the box final, and a legacy part keeps a fixed box", async ({
    page,
  }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    const state = await openPhotoChat(page)

    // 1600×900 is height-capped at 260, which gives 462 wide — the same box
    // `fitChatImage` computes from the stored size, on the first frame. Wait
    // for the attachment row to be measured, which is the only thing that can
    // still move the box, and record it while the previews are in flight.
    await expect
      .poll(async () => (await thumbnailBox(page, 0)).height, { timeout: 20_000 })
      .toBeGreaterThan(EXPECTED_HEIGHT - 2)
    const beforeLoad = await thumbnailBox(page, 0)
    expect(Math.abs(beforeLoad.height - EXPECTED_HEIGHT)).toBeLessThanOrEqual(1.5)
    expect(Math.abs(beforeLoad.width - EXPECTED_WIDTH)).toBeLessThanOrEqual(1.5)

    await waitForPreviews(page, state)

    // The preview arriving must not resize the box: that resize is what pulled
    // a resumed chat down once per photo.
    const afterLoad = await thumbnailBox(page, 0)
    expect(afterLoad.width, "the thumbnail resized when its image loaded").toBeCloseTo(
      beforeLoad.width,
      1,
    )
    expect(afterLoad.height, "the thumbnail resized when its image loaded").toBeCloseTo(
      beforeLoad.height,
      1,
    )

    // The legacy part has no stored size, so it gets the fixed fallback box
    // (4:3) and never measures the image it loads. Its real aspect is 16:9, so
    // a box that measured would be 1.78, not 1.33.
    const legacy = await thumbnailBox(page, PHOTO_COUNT)
    expect(legacy.width).toBeGreaterThan(0)
    expect(
      legacy.width / legacy.height,
      "the legacy thumbnail resized itself after loading",
    ).toBeCloseTo(4 / 3, 1)
  })
})
