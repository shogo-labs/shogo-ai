// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo must not rewrite the app's layout at phone width (SHO-371 part D,
 * absorbing SHO-378).
 *
 * `canvas-bridge.js` used to inject `!important` rules at <=767px that collapsed
 * every `grid-cols-2…6` to one column, un-truncated `.truncate`, rewrote
 * `[role=tablist]` and turned `flex h-screen` shells into columns. Agents then
 * fought CSS they never wrote, and a deliberate 2-up stat row rendered wrong.
 *
 * The real bridge runs in Chromium against a harness this spec serves itself.
 * The page carries the CSS a Tailwind project would ship (`.grid-cols-2`,
 * `.grid-cols-1`, `sm:grid-cols-2`, `.truncate`, a `flex h-screen` shell with a
 * `w-64` sidebar), so what is asserted is the *app's* layout surviving the
 * bridge — not a stylesheet the test wrote to make itself pass.
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

/** The subset of Tailwind's utilities the assertions read. */
const APP_PAGE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body { margin: 0; font-family: -apple-system, sans-serif; }
      .grid { display: grid; }
      .grid-cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }
      .grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      @media (min-width: 640px) {
        .sm\\:grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .flex { display: flex; }
      .h-screen { height: 100vh; }
      .w-64 { width: 16rem; flex: none; }
      .flex-1 { flex: 1 1 0%; }
    </style>
  </head>
  <body>
    <div id="two-up" class="grid grid-cols-2"><span>a</span><span>b</span></div>
    <div id="responsive" class="grid grid-cols-1 sm:grid-cols-2"><span>a</span><span>b</span></div>
    <div id="three-up" class="grid grid-cols-3"><span>a</span><span>b</span><span>c</span></div>
    <div id="truncated" class="truncate" style="width: 80px">a very long label that must stay on one line</div>
    <div id="shell" class="flex h-screen">
      <aside id="sidebar" class="w-64">nav</aside>
      <main class="flex-1">content</main>
    </div>
    <script src="/bridge.js"></script>
  </body>
</html>`

interface Harness {
  server: Server
  origin: string
  close: () => Promise<void>
}

function startHarness(): Promise<Harness> {
  const streams = new Set<ServerResponse>()

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
    if (url.startsWith("/app")) {
      res.writeHead(200, { "content-type": "text/html" }).end(APP_PAGE)
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

/** Track count of a computed `grid-template-columns` value. */
async function gridTracks(page: Page, selector: string): Promise<number> {
  const value = await page.$eval(selector, (el) => getComputedStyle(el).gridTemplateColumns)
  return value.trim().split(/\s+/).filter(Boolean).length
}

test.describe("canvas bridge leaves the app's layout alone at 390px", () => {
  let harness: Harness

  test.beforeAll(async () => {
    harness = await startHarness()
  })

  test.afterAll(async () => {
    await harness?.close()
  })

  test("injects no !important style and does not collapse the app's grids", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${harness.origin}/app`)
    await page.waitForFunction("document.readyState === 'complete'")
    // The bridge injects its (now tiny) stylesheet on load.
    await page.waitForFunction(
      "!!document.getElementById('__shogo-canvas-responsive')",
    )

    // 1. Nothing Shogo injected carries `!important`.
    const injected = await page.evaluate(() => {
      const style = document.getElementById("__shogo-canvas-responsive")
      return style ? style.textContent ?? "" : ""
    })
    expect(injected).not.toContain("!important")
    expect(injected).not.toContain("grid-cols")
    expect(injected).not.toContain("truncate")
    expect(injected).not.toContain("tablist")

    // 2. `grid grid-cols-2` renders 2 columns — a 2-up stat row stays 2-up.
    expect(await gridTracks(page, "#two-up")).toBe(2)

    // 3. `grid-cols-1 sm:grid-cols-2` renders 1 column at 390px.
    expect(await gridTracks(page, "#responsive")).toBe(1)

    // 4. A bare `grid-cols-3` stays 3 columns: the app authored it, the bridge
    //    does not "fix" it. `read_lints` warns about it at write time instead.
    expect(await gridTracks(page, "#three-up")).toBe(3)

    // 5. `.truncate` stays truncated.
    const truncate = await page.$eval("#truncated", (el) => {
      const s = getComputedStyle(el)
      return { whiteSpace: s.whiteSpace, textOverflow: s.textOverflow, overflow: s.overflowX }
    })
    expect(truncate.whiteSpace).toBe("nowrap")
    expect(truncate.textOverflow).toBe("ellipsis")
    expect(truncate.overflow).toBe("hidden")

    // 6. The `flex h-screen` shell keeps its row direction and the sidebar its
    //    fixed width — the bridge no longer turns it into a column.
    const shell = await page.$eval("#shell", (el) => getComputedStyle(el).flexDirection)
    expect(shell).toBe("row")
    const sidebarWidth = await page.$eval("#sidebar", (el) => el.getBoundingClientRect().width)
    expect(Math.round(sidebarWidth)).toBe(256)
  })
})
