// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phone web must not zoom, and must not stay in landscape (SHO-405).
 *
 * The rules that do this live in the web shell — `apps/mobile/app/+html.tsx`
 * renders `scripts/web-shell-guards.js` (CSS + pinch guard) — so this spec
 * serves that exact CSS and script to Chromium rather than the whole app: the
 * question is how a phone browser treats them, and that needs no session.
 *
 * Asserted, at a real phone viewport with touch emulated:
 * - pinch (two-finger `touchmove`, iOS `gesturestart`) and ctrl+wheel are
 *   cancelled, while a one-finger scroll is not;
 * - a focused input is at least 16px, so iOS never auto-zooms it;
 * - a landscape phone is covered by the rotate prompt;
 * and on a desktop viewport:
 * - the prompt is absent, the 16px rule and the pinch guard do not apply, so
 *   browser zoom keeps working.
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
  ZOOM_GUARD_SCRIPT,
} = require("../../apps/mobile/scripts/web-shell-guards.js") as {
  LANDSCAPE_OVERLAY_HTML: string
  LANDSCAPE_OVERLAY_ID: string
  PHONE_GUARD_STYLE_ID: string
  PHONE_VIEWPORT_GUARD_CSS: string
  ZOOM_GUARD_SCRIPT: string
}

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, shrink-to-fit=no, viewport-fit=cover" />
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

/** A phone: touch events on, coarse pointer, phone-sized viewport in the given orientation. */
async function withPhone(
  browser: Browser,
  viewport: { width: number; height: number },
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    viewport,
    screen: viewport,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  })
  try {
    const page = await context.newPage()
    await page.goto(pageUrl)
    await run(page)
  } finally {
    await context.close()
  }
}

test.describe("phone web can't zoom", () => {
  test("pinch and ctrl+wheel are cancelled, one-finger scroll is not", async ({ browser }) => {
    await withPhone(browser, { width: 412, height: 915 }, async (page) => {
      // Synthetic Touch objects need touch support, which `hasTouch` gives us.
      const result = await page.evaluate(() => {
        const touch = (id: number) => new Touch({ identifier: id, target: document.body, clientX: 10, clientY: 10 })
        const fire = (type: string, touches: Touch[]) =>
          document.body.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: touches, cancelable: true, bubbles: true }))

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

      expect(result.pinch).toBe(false)
      expect(result.gesture).toBe(true)
      expect(result.wheel).toBe(true)
      // Scrolling must keep working — the guard only blocks multi-touch.
      expect(result.scroll).toBe(true)
    })
  })

  test("double-tap zoom is off and a focused input is at least 16px", async ({ browser }) => {
    await withPhone(browser, { width: 412, height: 915 }, async (page) => {
      const styles = await page.evaluate(() => ({
        touchAction: getComputedStyle(document.documentElement).touchAction,
        input: getComputedStyle(document.getElementById("composer")!).fontSize,
        textarea: getComputedStyle(document.getElementById("note")!).fontSize,
        viewport: document.querySelector('meta[name="viewport"]')!.getAttribute("content"),
      }))

      expect(styles.touchAction).toBe("pan-x pan-y")
      expect(styles.input).toBe("16px")
      expect(styles.textarea).toBe("16px")
      expect(styles.viewport).toContain("user-scalable=no")
    })
  })
})

test.describe("landscape phones get the rotate prompt", () => {
  test("a landscape phone is covered by the prompt, a portrait phone is not", async ({ browser }) => {
    await withPhone(browser, { width: 915, height: 412 }, async (page) => {
      const overlay = page.locator(`#${OVERLAY_ID}`)
      await expect(overlay).toBeVisible()
      expect(await overlay.boundingBox()).toEqual({ x: 0, y: 0, width: 915, height: 412 })
      // It sits above the app, so nothing behind it can be tapped.
      expect(await overlay.evaluate((node) => getComputedStyle(node).zIndex)).toBe("2147483647")
    })

    await withPhone(browser, { width: 412, height: 915 }, async (page) => {
      await expect(page.locator(`#${OVERLAY_ID}`)).toBeHidden()
      await expect(page.locator("#app-text")).toBeVisible()
    })
  })
})

test.describe("desktop is untouched", () => {
  test("no prompt, no 16px override, browser zoom still works", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    try {
      const page = await context.newPage()
      await page.goto(pageUrl)

      await expect(page.locator(`#${OVERLAY_ID}`)).toBeHidden()
      expect(await page.locator("#composer").evaluate((node) => getComputedStyle(node).fontSize)).toBe("12px")

      const wheel = await page.evaluate(() => {
        const event = new WheelEvent("wheel", { ctrlKey: true, cancelable: true, bubbles: true })
        document.body.dispatchEvent(event)
        return event.defaultPrevented
      })
      expect(wheel).toBe(false)
    } finally {
      await context.close()
    }
  })
})

test("the sheet's guard CSS and script come from the app, not the harness", () => {
  const source = readFileSync(resolve(__dirname, "../../apps/mobile/scripts/web-shell-guards.js"), "utf8")
  expect(source).toContain("touch-action:pan-x pan-y")
  expect(source).toContain("pointer:coarse")
  expect(PHONE_VIEWPORT_GUARD_CSS).toContain("@media (orientation:landscape)")
  expect(ZOOM_GUARD_SCRIPT).toContain("gesturestart")
})
