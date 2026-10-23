// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-170 — a chat image preview is sized to the image *and* to the pane it is
 * in, instead of sitting in a fixed 220px box.
 *
 * The helper's unit tests pin the arithmetic and the RTL specs pin the wiring;
 * what only a browser can prove is that the width the React Native Web tree
 * actually lays out matches the rule: the pane is measured from the real row,
 * `onLoad` really reports natural pixels, and a wide image never spills out of
 * the pane it is in. So every assertion here compares the rendered box against
 * the width of the row the image actually got.
 */
import { deflateSync } from "zlib"
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

const suffix = Date.now().toString(36)
/** 16:9 screenshot, the case that used to become a 124px strip. */
const WIDE = `wide-${suffix}.png`
/** 6:1 panorama — wide enough that only the pane, never the 640 cap, limits it. */
const PANORAMA = `panorama-${suffix}.png`
/** The same panorama shared into a thread, where the pane is narrower. */
const PANORAMA_THREAD = `panorama-thread-${suffix}.png`
/** Smaller than the max on both axes, so it must not be upscaled. */
const SMALL = `small-${suffix}.png`
/** Portrait phone shot, which must stay inside the max height. */
const TALL = `tall-${suffix}.png`
/** 16:9 uploaded the way older builds did: no stored dimensions. */
const UNMEASURED = `unmeasured-${suffix}.png`

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

/** The box is rounded from a fractional layout, so a rendered size may differ by a hair. */
function near(actual: number, expected: number, tolerance = 1) {
  expect(Math.abs(actual - expected), `${actual} ≈ ${expected}`).toBeLessThanOrEqual(tolerance)
}

interface Rendered {
  width: number
  height: number
  /** Width of the attachment row the image sits in — the pane it was given. */
  rowWidth: number
}

/**
 * The rendered box of one shared image, and the row that holds it.
 *
 * React Native Web puts the image's own label on the box that carries the
 * width/height it was given, so that box — not the inner `<img>` — is the
 * preview. The row is the flex-wrap attachment row MessageRow measures.
 */
async function rendered(page: Page, name: string): Promise<Rendered> {
  const image = page.locator(`[data-testid="message-attachments"] [aria-label="${name}"]`).first()
  await image.scrollIntoViewIfNeeded()
  return image.evaluate((node) => {
    const box = node.getBoundingClientRect()
    const row = node.closest('[data-testid="message-attachments"]') as HTMLElement
    return { width: box.width, height: box.height, rowWidth: row.getBoundingClientRect().width }
  })
}

/**
 * Waits for the preview to settle. The row is unmeasured on the first paint, so
 * the image starts at the 220px fallback and refits once `onLayout` (and, for an
 * attachment with no stored size, `onLoad`) has reported.
 */
async function settled(page: Page, name: string, accept: (box: Rendered) => boolean): Promise<Rendered> {
  let last: Rendered = { width: 0, height: 0, rowWidth: 0 }
  await expect
    .poll(async () => {
      last = await rendered(page, name)
      return accept(last)
    }, { timeout: 20_000 })
    .toBe(true)
  return last
}

/** Uploads a real image and posts it; `store` controls whether dimensions are recorded. */
async function share(
  page: Page,
  conversationId: string,
  name: string,
  size: { width: number; height: number },
  options: { store?: boolean; threadRootId?: string } = {},
) {
  const store = options.store ?? true
  const upload = await page.request.post(`${LOCAL_API_BASE}/api/conversations/${conversationId}/attachments`, {
    multipart: {
      file: { name, mimeType: "image/png", buffer: png(size.width, size.height) },
      ...(store ? { width: String(size.width), height: String(size.height) } : {}),
    },
  })
  expect(upload.status(), await upload.text()).toBe(201)
  const attachment = (await upload.json()).attachment as { id: string; width: number | null }
  expect(attachment.width, "the upload kept the dimensions it was given").toBe(store ? size.width : null)
  const sent = await api(page, "POST", `/api/conversations/${conversationId}/messages`, {
    text: `${name} preview`,
    attachmentIds: [attachment.id],
    clientMsgId: crypto.randomUUID(),
    ...(options.threadRootId ? { threadRootId: options.threadRootId } : {}),
  })
  expect(sent.status, JSON.stringify(sent.json)).toBe(201)
  return { attachmentId: attachment.id, messageId: sent.json.message.id as string }
}

test.describe("Chat image preview sizing", () => {
  test.describe.configure({ mode: "serial" })

  let workspaceId: string
  let channelId: string
  let threadRootId: string

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const page = await browser.newPage()
    await signIn(page)
    workspaceId = await teamWorkspaceId(page)

    const channel = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, {
      name: `images-${suffix}`,
      kind: "public",
    })
    channelId = channel.json?.conversation?.id
    expect(channelId, JSON.stringify(channel.json)).toBeTruthy()

    await share(page, channelId, WIDE, { width: 1600, height: 900 })
    await share(page, channelId, PANORAMA, { width: 3000, height: 500 })
    await share(page, channelId, SMALL, { width: 120, height: 80 })
    await share(page, channelId, TALL, { width: 900, height: 1600 })
    await share(page, channelId, UNMEASURED, { width: 1600, height: 900 }, { store: false })

    const root = await api(page, "POST", `/api/conversations/${channelId}/messages`, {
      text: `thread root ${suffix}`,
      clientMsgId: crypto.randomUUID(),
    })
    expect(root.status, JSON.stringify(root.json)).toBe(201)
    threadRootId = root.json.message.id
    await share(page, channelId, PANORAMA_THREAD, { width: 3000, height: 500 }, { threadRootId })
    await page.close()
  })

  test("a 16:9 screenshot grows past the old 220px strip and keeps its aspect", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await activateTeamWorkspace(page, workspaceId)
    await page.goto(`/c/${channelId}`)

    // 462×260: the height cap decides the width, not the old fixed 220.
    const box = await settled(page, WIDE, (b) => Math.abs(b.height - 260) <= 1.5)
    expect(box.width).toBeGreaterThan(220)
    near(box.width, 462)
    near(box.height, 260)
    // The box matches the image's aspect, so nothing is cropped.
    expect(box.width / box.height).toBeCloseTo(16 / 9, 1)
    expect(box.width).toBeLessThanOrEqual(box.rowWidth + 1)
  })

  test("the width follows the pane: the thread sidebar refits the same panorama", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await activateTeamWorkspace(page, workspaceId)

    await page.goto(`/c/${channelId}`)
    const channel = await settled(page, PANORAMA, (b) => b.rowWidth > 0 && b.width > 220)
    // A 6:1 panorama is never height-capped, so the width rule is exact here.
    near(channel.width, Math.min(channel.rowWidth, 640))
    expect(channel.width).toBeLessThanOrEqual(640)

    await page.goto(`/c/${channelId}?thread=${threadRootId}`)
    await expect(page.getByLabel("Close thread")).toBeVisible({ timeout: 30_000 })
    const thread = await settled(page, PANORAMA_THREAD, (b) => b.rowWidth > 0 && b.width > 0)
    expect(thread.rowWidth).toBeLessThan(channel.rowWidth)
    // The same image in a narrower pane is fitted to *that* pane, not the window.
    near(thread.width, Math.min(thread.rowWidth, 640))
    expect(thread.width).toBeLessThanOrEqual(thread.rowWidth + 1)

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })

  test("a small image is not upscaled, and a tall one stays inside the max height", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await activateTeamWorkspace(page, workspaceId)
    await page.goto(`/c/${channelId}`)

    const small = await settled(page, SMALL, (b) => b.width > 0 && b.height > 0)
    near(small.width, 120)
    near(small.height, 80)

    // 900×1600: the height cap gives way to a 146px width, not a sliver.
    const tall = await settled(page, TALL, (b) => Math.abs(b.height - 260) <= 1.5)
    near(tall.height, 260)
    near(tall.width, 146)
    expect(tall.width).toBeGreaterThanOrEqual(120)
    expect(tall.width / tall.height).toBeCloseTo(900 / 1600, 1)
  })

  test("the preview still opens the lightbox and offers the download badge", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await activateTeamWorkspace(page, workspaceId)
    await page.goto(`/c/${channelId}`)

    await settled(page, WIDE, (b) => b.width > 220)
    // The badge sits on the image and opens a signed download, as before.
    await expect(page.getByLabel(`Download ${WIDE}`).first()).toBeVisible()

    await page.getByLabel(`Open ${WIDE}`).first().click()
    const lightbox = page.getByRole("dialog")
    await expect(lightbox).toBeVisible({ timeout: 15_000 })
    await expect(lightbox.getByText(WIDE)).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
  })

  test("an attachment with no stored dimensions takes its aspect from the loaded image", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await activateTeamWorkspace(page, workspaceId)
    await page.goto(`/c/${channelId}`)

    // Before it loads it can only guess the fallback aspect; once the browser
    // reports the real 1600×900 the box is refitted to 462×260.
    const box = await settled(page, UNMEASURED, (b) => Math.abs(b.height - 260) <= 1.5 && b.width > 400)
    near(box.width, 462)
    expect(box.width / box.height).toBeCloseTo(16 / 9, 1)
    expect(box.width).toBeLessThanOrEqual(box.rowWidth + 1)
  })
})
