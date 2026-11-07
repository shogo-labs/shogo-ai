import { test, expect, type Page, type Route } from "@playwright/test"
import { openTeamHome } from "./helpers"

/**
 * SHO-365 — a wheel over reply content must move the transcript.
 *
 * Streamdown gives its table box `overflow-x-auto overflow-y-auto` and an inline
 * `max-height: 300px`. A table longer than that becomes a vertical scroller of
 * its own, and a wheel aimed at any cell is spent inside it: the transcript does
 * not move while the pointer is over the table, while the same gesture over the
 * gutter scrolls the chat. Measured in Chromium on `main` at this size, the
 * transcript moved 0 px for a −100 notch.
 *
 * The table below is deliberately taller than the cap, so the spec is red on
 * `main` and green once the box stops capping and clipping itself.
 */

test.setTimeout(300_000)

const CHAT_POST_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"
const MESSAGES_GLOB = "**/api/chat-messages**"

const CELL_TEXT = "CELLPROBE the wheel is aimed at this table cell"

const TABLE_ROWS = Array.from(
  { length: 26 },
  (_, i) => `| row ${i} | ${i === 4 ? CELL_TEXT : `value ${i}`} |`,
)

const REPLY = [`## Table probe`, ``, `| column | probe |`, `| ------ | ----- |`, ...TABLE_ROWS].join("\n")

function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
}

function row(id: string, role: string, text: string, createdAt: number) {
  return {
    id,
    sessionId: "",
    role,
    content: text,
    parts: JSON.stringify([{ type: "text", text }]),
    createdAt,
    updatedAt: createdAt,
  }
}

async function install(page: Page) {
  await page.route(CHAT_POST_GLOB, async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        { type: "start", messageId: "msg_boot" },
        { type: "start-step" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Bootstrap done." },
        { type: "text-end", id: "t1" },
        { type: "finish-step" },
        { type: "finish" },
      ]),
    })
  })
  await page.route(TURN_GLOB, async (route: Route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "idle" }) })
  })
  await page.route(MESSAGES_GLOB, async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue()
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/changes")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, items: [], total: 40, cursor: new Date().toISOString(), reset: false }),
      })
    }
    const base = Date.now() - 400_000
    const rows = []
    for (let i = 0; i < 40; i++) {
      rows.push(row(`u${i}`, "user", `question ${i} about the thing`, base + i * 20_000))
      rows.push(row(`a${i}`, "assistant", i === 39 ? REPLY : `reply ${i} with a couple of lines of body text.`, base + i * 20_000 + 5_000))
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, items: rows.sort((a, b) => b.createdAt - a.createdAt), total: rows.length }),
    })
  })
}

const SCROLLER = `(() => {
  const all = Array.from(document.querySelectorAll('div'))
  return all.find((el) => getComputedStyle(el).overflowY === 'auto' && el.scrollHeight - el.clientHeight > 100) || null
})()`

test("a wheel over a tall table cell scrolls the transcript", async ({ page }) => {
  await install(page)
  await openTeamHome(page)
  const composer = page
    .getByTestId("home-composer-input")
    .or(page.getByRole("textbox", { name: "Describe the agent you want to build" }))
  await composer.click()
  await composer.fill("tall table wheel probe")
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 60_000 })
  await expect(page.getByText("CELLPROBE", { exact: false }).first()).toBeVisible({ timeout: 150_000 })

  const point = await page.evaluate(() => {
    const cell = [...document.querySelectorAll('[data-streamdown="table-cell"]')].find((el) =>
      (el.textContent || "").includes("CELLPROBE"),
    ) as HTMLElement
    cell.scrollIntoView({ block: "center" })
    const r = cell.getBoundingClientRect()
    return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 }
  })
  await page.waitForTimeout(300)

  const box = await page.evaluate(() => {
    const cell = [...document.querySelectorAll('[data-streamdown="table-cell"]')].find((el) =>
      (el.textContent || "").includes("CELLPROBE"),
    ) as HTMLElement
    const outer = cell.closest('[data-streamdown="table-wrapper"]') as HTMLElement
    const wrapper = outer.firstElementChild as HTMLElement
    const style = getComputedStyle(wrapper)
    return {
      overflowY: style.overflowY,
      maxHeight: style.maxHeight,
      height: wrapper.clientHeight,
      content: wrapper.scrollHeight,
      range: wrapper.scrollHeight - wrapper.clientHeight,
    }
  })
  console.log("TABLEBOX", JSON.stringify(box))

  const before = (await page.evaluate(SCROLLER + "?.scrollTop ?? null")) as number
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(0, -100)
  await page.waitForTimeout(400)
  const after = (await page.evaluate(SCROLLER + "?.scrollTop ?? null")) as number

  console.log("WHEEL", JSON.stringify({ before, after, moved: after - before }))

  // The table box renders the whole table instead of scrolling inside itself.
  // (`clip` on the vertical axis computes to `hidden` next to `overflow-x: auto`;
  // neither is user-scrollable, which is the point.)
  expect(["hidden", "clip"]).toContain(box.overflowY)
  expect(box.maxHeight).toBe("none")
  // The gesture reached the transcript instead of dying inside the table box.
  expect(after - before).toBeLessThanOrEqual(-90)
})
