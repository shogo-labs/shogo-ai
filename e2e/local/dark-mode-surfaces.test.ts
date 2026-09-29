// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { readFileSync } from "fs"
import { resolve } from "path"
import { expect, test, type Locator, type Page, type Route } from "@playwright/test"

/**
 * Dark-mode regressions that shipped: the announcement modal rendering light
 * colours, the dock letting the transcript bleed through, and the queue error
 * icon rendering nothing. Pixel baselines would need per-OS goldens, so these
 * assert the properties that broke (opaque, dark surface; readable text;
 * icon drawn) and attach a screenshot of each surface for review.
 */

const API_BASE = process.env.E2E_API_URL || "http://localhost:8002"
const MIN_TEXT_CONTRAST = 4.5
const MAX_DARK_SURFACE_LUMINANCE = 0.2

test.use({ colorScheme: "dark" })

type Surface = { bg: [number, number, number]; alpha: number; text: [number, number, number] }

/**
 * The nearest ancestor of `text` (inclusive) that paints a background, and
 * the text colour itself.
 */
async function surfaceOf(text: Locator): Promise<Surface> {
  return text.evaluate((el) => {
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      const [r, g, b, a = "1"] = (m?.[1] ?? "0,0,0,0").split(",").map((s) => s.trim())
      return { rgb: [Number(r), Number(g), Number(b)] as [number, number, number], alpha: Number(a) }
    }
    const text = parse(getComputedStyle(el).color).rgb
    for (let node: Element | null = el; node; node = node.parentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor)
      if (bg.alpha > 0) return { bg: bg.rgb, alpha: bg.alpha, text }
    }
    return { bg: [255, 255, 255] as [number, number, number], alpha: 1, text }
  })
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function expectDarkReadable(name: string, s: Surface, { opaque }: { opaque: boolean }) {
  expect(luminance(s.bg), `${name} background rgb(${s.bg}) is not dark`).toBeLessThan(MAX_DARK_SURFACE_LUMINANCE)
  expect(contrast(s.text, s.bg), `${name} text rgb(${s.text}) on rgb(${s.bg})`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
  if (opaque) expect(s.alpha, `${name} background must be opaque`).toBe(1)
}

async function attach(page: Page, name: string, target: Locator) {
  await test.info().attach(`${name}-dark.png`, { body: await target.screenshot(), contentType: "image/png" })
}

async function localProjectId(page: Page): Promise<string> {
  return page.evaluate(async (apiBase) => {
    const listed = await fetch(`${apiBase}/api/projects?limit=1`, { credentials: "include" }).then((r) => r.json())
    if (listed?.items?.[0]?.id) return listed.items[0].id as string
    const ws = await fetch(`${apiBase}/api/workspaces?limit=1`, { credentials: "include" }).then((r) => r.json())
    const created = await fetch(`${apiBase}/api/projects`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `Dark mode E2E ${Date.now()}`,
        workspaceId: ws.items[0].id,
        tier: "starter",
        status: "draft",
        accessLevel: "anyone",
      }),
    }).then((r) => r.json())
    return created.data.id as string
  }, API_BASE)
}

test.describe("dark mode surfaces", () => {
  test("sidebar is dark with readable nav", async ({ page }) => {
    await page.goto("/")
    const sidebar = page.getByRole("navigation", { name: "App sidebar" })
    await sidebar.waitFor({ state: "visible", timeout: 30_000 })
    const chat = sidebar.getByRole("link", { name: "Chat", exact: true }).getByText("Chat", { exact: true })
    expectDarkReadable("sidebar", await surfaceOf(chat), { opaque: false })
    await attach(page, "sidebar", sidebar)
  })

  test("What's New modal is an opaque dark card", async ({ page }) => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, "../../apps/mobile/lib/whats-new/releases.generated.json"), "utf8"),
    ) as Array<{ version: string; announce?: boolean; title?: string }>
    const release = catalog.find((r) => r.announce)
    test.skip(!release, "no announced release in the catalog")

    // Must land inside the (app) group; the root index redirect drops the query.
    await page.goto(`/activity?whatsNew=${release!.version}`)
    const close = page.getByRole("button", { name: "Close What's New" })
    await close.waitFor({ state: "visible", timeout: 30_000 })
    const dismiss = page.getByRole("button", { name: "Dismiss What's New" })
    const card = close.locator("xpath=ancestor::*[.//*[@aria-label=\"Dismiss What's New\"]][1]")
    const heading = card.getByText(/\S/).first()
    expectDarkReadable("What's New modal", await surfaceOf(heading), { opaque: true })
    await expect(dismiss).toBeVisible()
    await attach(page, "whats-new", card)
  })

  test("queue dock is opaque and draws the failed-row icon", async ({ page }) => {
    const now = Date.now()
    const rows = [
      { id: "dark-q-1", userId: "e2e", position: 0, status: "pending", content: "queued prompt", parts: "[]", body: "{}", createdAt: now, updatedAt: now },
      {
        id: "dark-q-2",
        userId: "e2e",
        position: 1,
        status: "failed",
        content: "failed prompt",
        parts: "[]",
        body: "{}",
        error: "Upstream timed out",
        createdAt: now,
        updatedAt: now,
      },
    ]
    // The dock only shows rows for the open chat session, so stamp them with
    // whichever session the client asks for.
    await page.route("**/api/chat-queued-messages**", (route: Route) => {
      if (route.request().method() !== "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
      }
      const sessionId = new URL(route.request().url()).searchParams.get("sessionId")
      const items = rows.map((row) => ({ ...row, sessionId }))
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, items, total: items.length }),
      })
    })

    await page.goto("/")
    await page.getByRole("navigation", { name: "App sidebar" }).waitFor({ state: "visible", timeout: 30_000 })
    const projectId = await localProjectId(page)
    // The server queue is only read for an existing chat session.
    await page.evaluate(
      async ({ apiBase, projectId }) => {
        const res = await fetch(`${apiBase}/api/chat-sessions`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ inferredName: "Dark mode E2E", contextType: "project", contextId: projectId }),
        })
        if (!res.ok) throw new Error(`chat session create failed: ${res.status}`)
      },
      { apiBase: API_BASE, projectId },
    )
    await page.goto(`/projects/${projectId}`)

    const queued = page.getByText("queued prompt", { exact: true })
    await queued.waitFor({ state: "visible", timeout: 30_000 })
    expectDarkReadable("queue dock", await surfaceOf(queued), { opaque: true })

    const failedRow = page.getByLabel("Queued message").filter({ hasText: "failed prompt" })
    const icon = failedRow.locator("svg").first()
    await expect(icon).toBeVisible()
    const box = await icon.boundingBox()
    expect(box && box.width > 0 && box.height > 0, "failed-row icon has no size").toBeTruthy()
    expect(await icon.evaluate((svg) => svg.querySelectorAll("path, line, circle, polyline, polygon").length)).toBeGreaterThan(0)
    await expect(failedRow.getByText("Upstream timed out")).toBeVisible()

    await attach(page, "queue-dock", page.getByLabel("Queued message").first().locator("xpath=ancestor::*[contains(@class,'rounded-xl')][1]"))
  })
})
