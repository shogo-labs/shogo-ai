// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phone web must not zoom, and must not stay in landscape (SHO-405).
 *
 * The rules that do this live in the web shell — `scripts/web-shell-guards.js`,
 * rendered by `app/+html.tsx` and by the post-export step that patches the
 * shipped `dist/index.html` — so this spec serves that exact CSS, script and
 * markup to Chromium rather than the whole app: the question is what a browser
 * does with them, and that needs no session.
 *
 * At a real phone viewport with touch emulated:
 * - pinch (two-finger `touchmove`, iOS `gesturestart`) and ctrl+wheel are
 *   cancelled, while a one-finger scroll is not;
 * - a focused input is at least 16px, so iOS never auto-zooms it;
 * - a landscape phone is covered by the rotate prompt.
 * Everywhere that is not a phone — iPad in both orientations, a touch laptop, a
 * desktop browser — none of that applies, so pinch/browser zoom and type sizes
 * are untouched.
 */

import { expect, test, type Browser, type Page } from "@playwright/test"
import { createServer, type Server } from "node:http"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { AddressInfo } from "node:net"

const {
  LANDSCAPE_OVERLAY_HTML,
  LANDSCAPE_OVERLAY_ID: OVERLAY_ID,
  PHONE_GUARD_STYLE_ID,
  PHONE_VIEWPORT_GUARD_CSS,
  VIEWPORT_META_CONTENT,
  ZOOM_GUARD_SCRIPT,
} = require("../../apps/mobile/scripts/web-shell-guards.js") as {
  LANDSCAPE_OVERLAY_HTML: string
  LANDSCAPE_OVERLAY_ID: string
  PHONE_GUARD_STYLE_ID: string
  PHONE_VIEWPORT_GUARD_CSS: string
  VIEWPORT_META_CONTENT: string
  ZOOM_GUARD_SCRIPT: string
}

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="${VIEWPORT_META_CONTENT}" />
    <style id="${PHONE_GUARD_STYLE_ID}">${PHONE_VIEWPORT_GUARD_CSS}</style>
  </head>
  <body style="margin:0">
    <div id="root">
      <input id="composer" style="font-size:12px" />
      <textarea id="note" style="font-size:13px"></textarea>
      <p id="app-text">the app</p>
    </div>
    <!-- Same wrapper + markup + script +html.tsx renders. -->
    <div style="display:contents">${LANDSCAPE_OVERLAY_HTML}</div>
    <script data-shogo-zoom-guard>${ZOOM_GUARD_SCRIPT}</script>
  </body>
</html>`

let server: Server
let pageUrl: string

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(PAGE)
  })
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
  pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})

test.afterAll(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
})

interface ViewportOptions {
  viewport: { width: number; height: number }
  hasTouch?: boolean
  isMobile?: boolean
}

async function withViewport(browser: Browser, options: ViewportOptions, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({
    screen: options.viewport,
    deviceScaleFactor: 3,
    isMobile: options.isMobile ?? false,
    hasTouch: options.hasTouch ?? false,
    ...options,
  })
  try {
    const page = await context.newPage()
    await page.goto(pageUrl)
    await run(page)
  } finally {
    await context.close()
  }
}

const phone = (width: number, height: number) => ({ viewport: { width, height }, hasTouch: true, isMobile: true })

/** Fires the gestures that zoom, and a plain one-finger scroll. Returns which were cancelled. */
function zoomProbe(page: Page) {
  return page.evaluate(() => {
    const touch = (id: number) => new Touch({ identifier: id, target: document.body, clientX: 10, clientY: 10 })
    const fire = (type: string, touches: Touch[]) =>
      document.body.dispatchEvent(
        new TouchEvent(type, {
          touches,
          targetTouches: touches,
          changedTouches: touches,
          cancelable: true,
          bubbles: true,
        }),
      )

    fire("touchstart", [touch(1), touch(2)])
    const pinch = fire("touchmove", [touch(1), touch(2)])
    const scroll = fire("touchmove", [touch(1)])
    fire("touchend", [])

    const gesture = new Event("gesturestart", { cancelable: true, bubbles: true })
    document.body.dispatchEvent(gesture)

    const wheel = new WheelEvent("wheel", { ctrlKey: true, cancelable: true, bubbles: true })
    document.body.dispatchEvent(wheel)

    return { pinch, scroll, gesture: gesture.defaultPrevented, wheel: wheel.defaultPrevented }
  })
}

function computedStyles(page: Page) {
  return page.evaluate(() => ({
    touchAction: getComputedStyle(document.documentElement).touchAction,
    input: getComputedStyle(document.getElementById("composer")!).fontSize,
    textarea: getComputedStyle(document.getElementById("note")!).fontSize,
    viewport: document.querySelector('meta[name="viewport"]')!.getAttribute("content"),
  }))
}

test.describe("a phone can't zoom", () => {
  test("pinch, gesture events and ctrl+wheel are cancelled; one-finger scroll is not", async ({ browser }) => {
    await withViewport(browser, phone(393, 852), async (page) => {
      const result = await zoomProbe(page)
      expect(result.pinch).toBe(false)
      expect(result.gesture).toBe(true)
      expect(result.wheel).toBe(true)
      // Scrolling must keep working — the guard only blocks multi-touch.
      expect(result.scroll).toBe(true)
    })
  })

  test("double-tap zoom is off and a focused input is at least 16px", async ({ browser }) => {
    await withViewport(browser, phone(393, 852), async (page) => {
      const styles = await computedStyles(page)
      expect(styles.touchAction).toBe("pan-x pan-y")
      expect(styles.input).toBe("16px")
      expect(styles.textarea).toBe("16px")
      expect(styles.viewport).toContain("user-scalable=no")
    })
  })

  test("it still holds in landscape, where the gate matches on height", async ({ browser }) => {
    await withViewport(browser, phone(852, 393), async (page) => {
      const result = await zoomProbe(page)
      expect(result.pinch).toBe(false)
      expect(result.gesture).toBe(true)
      expect((await computedStyles(page)).input).toBe("16px")
    })
  })
})

test.describe("landscape phones get the rotate prompt", () => {
  test("a landscape phone is covered by the prompt, a portrait phone is not", async ({ browser }) => {
    await withViewport(browser, phone(852, 393), async (page) => {
      const overlay = page.locator(`#${OVERLAY_ID}`)
      await expect(overlay).toBeVisible()
      expect(await overlay.boundingBox()).toEqual({ x: 0, y: 0, width: 852, height: 393 })
      // It sits above the app, so nothing behind it can be tapped.
      expect(await overlay.evaluate((node) => getComputedStyle(node).zIndex)).toBe("2147483647")
    })

    await withViewport(browser, phone(393, 852), async (page) => {
      await expect(page.locator(`#${OVERLAY_ID}`)).toBeHidden()
      await expect(page.locator("#app-text")).toBeVisible()
    })
  })
})

test.describe("everything that is not a phone keeps its zoom", () => {
  for (const [name, viewport] of [
    ["an iPad in portrait (768x1024)", { width: 768, height: 1024 }],
    ["an iPad in landscape (1024x768)", { width: 1024, height: 768 }],
  ] as const) {
    test(`${name}: no prompt, no pinch guard, no 16px type`, async ({ browser }) => {
      await withViewport(browser, { viewport, hasTouch: true, isMobile: true }, async (page) => {
        await expect(page.locator(`#${OVERLAY_ID}`)).toBeHidden()
        const result = await zoomProbe(page)
        expect(result.pinch).toBe(true)
        expect(result.gesture).toBe(false)
        expect(result.wheel).toBe(false)
        const styles = await computedStyles(page)
        expect(styles.input).toBe("12px")
        expect(styles.touchAction).toBe("auto")
      })
    })
  }

  test("a touch laptop (1440x900): no prompt, no 16px type", async ({ browser }) => {
    await withViewport(browser, { viewport: { width: 1440, height: 900 }, hasTouch: true }, async (page) => {
      await expect(page.locator(`#${OVERLAY_ID}`)).toBeHidden()
      expect((await computedStyles(page)).input).toBe("12px")
    })
  })

  test("a desktop browser (1440x900): no prompt, no 16px type, ctrl+wheel keeps zooming", async ({ browser }) => {
    await withViewport(browser, { viewport: { width: 1440, height: 900 } }, async (page) => {
      await expect(page.locator(`#${OVERLAY_ID}`)).toBeHidden()
      expect((await computedStyles(page)).input).toBe("12px")
      const wheel = await page.evaluate(() => {
        const event = new WheelEvent("wheel", { ctrlKey: true, cancelable: true, bubbles: true })
        document.body.dispatchEvent(event)
        return event.defaultPrevented
      })
      expect(wheel).toBe(false)
    })
  })
})

test("the CSS, script and markup come from the app, not the harness", () => {
  const source = readFileSync(resolve(__dirname, "../../apps/mobile/scripts/web-shell-guards.js"), "utf8")
  expect(source).toContain("touch-action:pan-x pan-y")
  expect(source).toContain("max-width: 600px")
  expect(source).toContain("max-height: 500px")
  expect(PHONE_VIEWPORT_GUARD_CSS).toContain("@media (orientation:landscape)")
  expect(ZOOM_GUARD_SCRIPT).toContain("gesturestart")
})
