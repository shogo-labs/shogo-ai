// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Update available" must never cover the preview (SHO-357).
 *
 * The real `packages/agent-runtime/static/canvas-bridge.js` runs in Chromium
 * against a small harness this spec serves itself:
 *
 *  - `/app` is a stand-in user app (a header, content, and a fixed bottom nav)
 *    with the bridge injected, and `/agent/canvas/stream` is a real SSE
 *    endpoint the spec pokes — so the rebuild path is the shipped one:
 *    `init` then `reload` on the event stream.
 *  - `/host` is a host that lays the bar out ABOVE the iframe in normal flow,
 *    exactly like `CanvasWebView`'s `canvas-update-bar` row: it acks
 *    `canvas-host { updateBar: true }` on `canvas-ready` and shows its own row
 *    when the bridge posts `canvas-update-available`.
 *
 * Covered here: AC1 (bar above the preview, nothing covered, no pill at the
 * bottom), AC2 (Refresh reloads the current route and clears; × dismisses
 * without reloading; a later rebuild shows it again), AC3 (no host → the
 * in-document fallback is a slim full-width top bar, not the bottom pill), and
 * AC4 (exactly one bar, host or document, never both).
 */
import { expect, test, type Page } from "@playwright/test"
import { createServer, type Server, type ServerResponse } from "node:http"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { AddressInfo } from "node:net"

const BRIDGE_SOURCE = readFileSync(
  resolve(__dirname, "../../packages/agent-runtime/static/canvas-bridge.js"),
  "utf8",
)

/** The rename that started the card: a bottom pill with a glow. */
const OLD_PILL_BOTTOM = /bottom:\s*16px/

const APP_PAGE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body { margin: 0; height: 100%; font-family: -apple-system, sans-serif; }
      #app-header { height: 64px; background: #101828; color: #fff; font: 600 16px/64px sans-serif; padding-left: 16px; }
      #app-content { padding: 16px; color: #333; }
      #app-bottom-nav {
        position: fixed; bottom: 0; left: 0; right: 0; height: 56px;
        display: flex; align-items: center; justify-content: space-around;
        background: #f2f4f7; border-top: 1px solid #d0d5dd;
        font: 500 12px/56px sans-serif;
      }
      #app-bottom-nav button { height: 32px; }
    </style>
  </head>
  <body>
    <div id="app-header">My App</div>
    <div id="app-content"><p id="app-marker">project content</p></div>
    <nav id="app-bottom-nav"><button id="nav-home">Home</button><button id="nav-settings">Settings</button></nav>
    <script src="/bridge.js"></script>
  </body>
</html>`

const HOST_PAGE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; height: 100%; }
      body { display: flex; flex-direction: column; }
      /* Mirrors CanvasWebView's canvas-update-bar: a normal-flow row, so the
         preview is pushed down instead of covered. */
      #host-update-bar {
        display: none; flex: none; position: relative;
        align-items: center; justify-content: center;
        background: rgb(226, 121, 39); color: #fff;
        font: 500 12px/28px -apple-system, sans-serif; min-height: 28px;
      }
      #host-update-bar[data-visible="true"] { display: flex; }
      #host-update-bar .refresh { margin-left: 8px; background: rgba(255,255,255,0.2); color: #fff; border: 0; border-radius: 4px; padding: 3px 8px; font-weight: 600; }
      #host-update-bar .dismiss { position: absolute; right: 4px; top: 0; bottom: 0; background: transparent; border: 0; color: #fff; padding: 0 8px; }
      #preview { flex: 1; width: 100%; border: 0; display: block; }
    </style>
  </head>
  <body>
    <div id="host-update-bar" data-testid="canvas-update-bar" data-visible="false">
      <span>Update available</span>
      <button class="refresh" id="host-refresh">Refresh</button>
      <button class="dismiss" id="host-dismiss" aria-label="Dismiss">×</button>
    </div>
    <iframe id="preview" title="preview" src="/app"></iframe>
    <script>
      var bar = document.getElementById('host-update-bar')
      var frame = document.getElementById('preview')
      window.addEventListener('message', function (event) {
        var msg = event.data
        if (!msg || typeof msg !== 'object') return
        if (msg.type === 'canvas-ready') {
          // Exactly what CanvasIframe sends on canvas-ready.
          frame.contentWindow.postMessage({ type: 'canvas-host', updateBar: true }, '*')
        } else if (msg.type === 'canvas-update-available') {
          bar.setAttribute('data-visible', 'true')
        }
      })
      document.getElementById('host-refresh').onclick = function () {
        bar.setAttribute('data-visible', 'false')
        frame.contentWindow.postMessage({ type: 'canvas-reload' }, '*')
      }
      document.getElementById('host-dismiss').onclick = function () {
        bar.setAttribute('data-visible', 'false')
      }
    </script>
  </body>
</html>`

interface Harness {
  server: Server
  origin: string
  /** Resume every open `/agent/canvas/stream` response with a `reload` event. */
  reload: () => number
  /** How many times `/app` has been served (a reload of the preview). */
  appLoads: () => number
  /** How many SSE listeners are attached (the bridge has connected). */
  openStreams: () => number
  close: () => Promise<void>
}

function startHarness(): Promise<Harness> {
  const streams = new Set<ServerResponse>()
  let appLoads = 0

  const server = createServer((req, res) => {
    const url = req.url ?? "/"
    if (url.startsWith("/bridge.js")) {
      res.writeHead(200, { "content-type": "text/javascript" }).end(BRIDGE_SOURCE)
      return
    }
    if (url === "/agent/canvas/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      res.write(`data: ${JSON.stringify({ type: "init" })}\n\n`)
      streams.add(res)
      req.on("close", () => streams.delete(res))
      return
    }
    if (url === "/app-loads") {
      res.writeHead(200, { "content-type": "text/plain" }).end(String(appLoads))
      return
    }
    if (url.startsWith("/app")) {
      appLoads += 1
      res.writeHead(200, { "content-type": "text/html" }).end(APP_PAGE)
      return
    }
    if (url.startsWith("/host")) {
      res.writeHead(200, { "content-type": "text/html" }).end(HOST_PAGE)
      return
    }
    res.writeHead(404).end("not found")
  })

  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolveStart({
        server,
        origin: `http://127.0.0.1:${port}`,
        reload: () => {
          for (const stream of streams) {
            stream.write(`data: ${JSON.stringify({ type: "reload" })}\n\n`)
          }
          return streams.size
        },
        appLoads: () => appLoads,
        openStreams: () => streams.size,
        close: () =>
          new Promise<void>((done) => {
            for (const stream of streams) stream.end()
            server.closeAllConnections?.()
            server.close(() => done())
          }),
      })
    })
  })
}

/**
 * The bridge only acts on `reload` after it has seen `init`, and the
 * EventSource connects after the document has loaded. Waiting on the stream
 * itself is the only honest signal, so the server exposes how many SSE clients
 * are attached.
 */
async function waitForStream(page: Page, harness: Harness) {
  await expect.poll(() => harness.openStreams()).toBeGreaterThan(0)
  await page.waitForFunction("document.readyState === 'complete'")
}

test.describe("canvas update bar — a host draws it above the preview", () => {
  let harness: Harness
  test.beforeEach(async () => {
    harness = await startHarness()
  })
  test.afterEach(async () => {
    await harness.close()
  })

  test("a rebuild raises the host bar above the preview and nothing is covered", async ({ page }) => {
    await page.goto(`${harness.origin}/host`)
    const frame = page.frameLocator("#preview")
    await expect(frame.locator("#app-bottom-nav")).toBeVisible()
    await expect
      .poll(async () => (await page.locator("#preview").boundingBox())?.y)
      .toBe(0)

    await waitForStream(page, harness)
    expect(harness.reload()).toBeGreaterThan(0)

    const bar = page.locator("#host-update-bar")
    await expect(bar).toHaveAttribute("data-visible", "true")

    // Host row is above the iframe: the preview starts below it, nothing covered.
    const barBox = (await bar.boundingBox())!
    const frameBox = (await page.locator("#preview").boundingBox())!
    expect(frameBox.y).toBeGreaterThanOrEqual(barBox.height - 1)
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(frameBox.y + 1)
    expect(barBox.width).toBe((await page.viewportSize())!.width)

    // AC4: the document drew nothing — exactly one bar, the host's.
    expect(await frame.locator("#__shogo-update-toast").count()).toBe(0)

    // The app's own bottom nav is still fully clickable, not covered by a pill.
    const navCovered = await page.frameLocator("#preview").locator("#nav-home").evaluate((el) => {
      const box = el.getBoundingClientRect()
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return top === el || el.contains(top as Node) ? null : (top as HTMLElement).id
    })
    expect(navCovered).toBeNull()
  })

  test("Refresh reloads the current route and clears; × dismisses without reloading; the next rebuild returns", async ({
    page,
  }) => {
    await page.goto(`${harness.origin}/host/route?tab=settings#section-2`)
    const frame = page.frameLocator("#preview")
    await expect(frame.locator("#app-bottom-nav")).toBeVisible()
    await waitForStream(page, harness)

    const loadsBefore = harness.appLoads()
    harness.reload()
    const bar = page.locator("#host-update-bar")
    await expect(bar).toHaveAttribute("data-visible", "true")

    // × hides the bar and does not reload.
    await page.locator("#host-dismiss").click()
    await expect(bar).toHaveAttribute("data-visible", "false")
    await expect(frame.locator("#app-bottom-nav")).toBeVisible()
    expect(await frame.locator("#app-marker").count()).toBe(1)
    expect(harness.appLoads()).toBe(loadsBefore)

    // The next rebuild raises it again.
    harness.reload()
    await expect(bar).toHaveAttribute("data-visible", "true")

    // Refresh reloads the preview on the page's current route and clears.
    await page.locator("#host-refresh").click()
    await expect(bar).toHaveAttribute("data-visible", "false")
    await expect.poll(() => harness.appLoads()).toBeGreaterThan(loadsBefore)
    await expect(frame.locator("#app-bottom-nav")).toBeVisible()
    await expect(frame.locator("#app-marker")).toBeVisible()
  })
})

test.describe("canvas update bar — standalone preview tab (no host)", () => {
  let harness: Harness
  test.beforeEach(async () => {
    harness = await startHarness()
  })
  test.afterEach(async () => {
    await harness.close()
  })

  test("the fallback is a slim full-width bar pinned to the top, not a bottom pill", async ({ page }) => {
    await page.goto(`${harness.origin}/app/some/route?tab=1`)
    await waitForStream(page, harness)

    harness.reload()
    const toast = page.locator("#__shogo-update-toast")
    await expect(toast).toHaveCount(1)

    const box = (await toast.boundingBox())!
    expect(box.y).toBe(0)
    expect(Math.round(box.width)).toBe((await page.viewportSize())!.width)
    expect(box.height).toBeLessThan(40)

    const styles = await toast.evaluate((el) => {
      const css = getComputedStyle(el)
      return {
        background: css.backgroundColor,
        position: css.position,
        borderRadius: css.borderRadius,
        animation: css.animationName,
        animationIterationCount: css.animationIterationCount,
        bottom: css.bottom,
        boxShadow: css.boxShadow,
      }
    })
    expect(styles.position).toBe("fixed")
    expect(styles.background).toBe("rgb(226, 121, 39)")
    expect(styles.borderRadius).toBe("0px")
    // The glow, the rotating conic border and the pulse are gone.
    expect(styles.animationIterationCount).toBe("1")
    expect(styles.animation).toBe("__shogo-bar-fade-in")
    expect(styles.boxShadow).not.toMatch(/oklch/)
    // The old bottom pill's rule is gone from the shipped bridge, too.
    expect(OLD_PILL_BOTTOM.test(BRIDGE_SOURCE)).toBe(false)

    await expect(toast.getByText("Update available")).toBeVisible()
    await expect(toast.getByRole("button", { name: "Refresh" })).toBeVisible()
    await expect(toast.getByRole("button", { name: "Dismiss" })).toBeVisible()
  })

  test("× dismisses without reloading and Refresh reloads the current route", async ({ page }) => {
    await page.goto(`${harness.origin}/app/some/route?tab=1`)
    await waitForStream(page, harness)
    const toast = page.locator("#__shogo-update-toast")

    const loadsBefore = harness.appLoads()
    harness.reload()
    await expect(toast).toHaveCount(1)

    await toast.getByRole("button", { name: "Dismiss" }).click()
    await expect(toast).toHaveCount(0)
    expect(harness.appLoads()).toBe(loadsBefore)

    // A second rebuild shows it again (the dedup is per mounted bar).
    harness.reload()
    await expect(toast).toHaveCount(1)
    expect(await toast.count()).toBe(1)

    await Promise.all([page.waitForNavigation(), toast.getByRole("button", { name: "Refresh" }).click()])
    expect(page.url()).toBe(`${harness.origin}/app/some/route?tab=1`)
    await expect(page.locator("#app-bottom-nav")).toBeVisible()
    await expect(page.locator("#__shogo-update-toast")).toHaveCount(0)
  })

  test("a host that acks after the rebuild takes the bar over instead of stacking a second one", async ({ page }) => {
    await page.goto(`${harness.origin}/app/late/ack`)
    await waitForStream(page, harness)

    harness.reload()
    await expect(page.locator("#__shogo-update-toast")).toHaveCount(1)

    // The native WebView's injection lands after the document, so its ack can
    // arrive late. The document bar must go away.
    await page.evaluate(() => {
      window.postMessage({ type: "canvas-host", updateBar: true }, "*")
    })
    await expect(page.locator("#__shogo-update-toast")).toHaveCount(0)
  })
})
