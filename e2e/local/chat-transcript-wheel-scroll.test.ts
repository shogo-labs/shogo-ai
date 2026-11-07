import { test, expect, type Page, type Route } from "@playwright/test"
import { openTeamHome } from "./helpers"

/**
 * SHO-365 — a wheel aimed at reply content must move the transcript.
 *
 * Measured in Chromium: a box with vertical overflow *around* the text under the
 * pointer takes the gesture for itself and the transcript moves 0 px for a −100
 * notch, while the same box anywhere else in the reply leaves the transcript
 * scrolling normally. So no box inside a reply may be a vertical scroll
 * container.
 *
 * Streamdown asks its table wrapper for `overflow-x-auto overflow-y-auto`. In
 * our Tailwind build those utilities produce no CSS (computed `overflow-y` is
 * `visible`), but a single generated rule would turn the wrapper into exactly
 * the box above, so the vertical axis is clipped explicitly and this spec holds
 * it there. The height is forced short here to prove the wheel still reaches the
 * transcript with the pointer over a table cell.
 */

test.setTimeout(300_000)

const CHAT_POST_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"
const MESSAGES_GLOB = "**/api/chat-messages**"

const CELL_TEXT = "CELLPROBE the wheel is aimed at this table cell"

const REPLY = [
  `## Table probe`,
  ``,
  `| column | probe |`,
  `| ------ | ----- |`,
  `| a | ${CELL_TEXT} |`,
  `| b | second row |`,
  `| c | third row |`,
].join("\n")

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

test("a wheel over a table cell scrolls the transcript", async ({ page }) => {
  await install(page)
  await openTeamHome(page)
  const composer = page
    .getByTestId("home-composer-input")
    .or(page.getByRole("textbox", { name: "Describe the agent you want to build" }))
  await composer.click()
  await composer.fill("table wheel probe")
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 60_000 })
  await expect(page.getByText("CELLPROBE", { exact: false }).first()).toBeVisible({ timeout: 150_000 })

  const wrapper = await page.evaluate(() => {
    const cell = [...document.querySelectorAll('[data-streamdown="table-cell"]')].find((el) =>
      (el.textContent || "").includes("CELLPROBE"),
    ) as HTMLElement | undefined
    const box = cell?.closest('[data-streamdown="table-wrapper"]') as HTMLElement | null
    if (!box) return null
    const style = getComputedStyle(box)
    return {
      overflowY: style.overflowY,
      range: box.scrollHeight - box.clientHeight,
      height: box.clientHeight,
      content: box.scrollHeight,
    }
  })
  expect(wrapper, "Streamdown renders a table wrapper").toBeTruthy()
  console.log("WRAPPER", JSON.stringify(wrapper))

  // The wrapper is never a vertical scroller, whatever overflow it holds.
  expect(wrapper!.overflowY).toBe("clip")

  // Force the couple of pixels of vertical overflow that make it one.
  const point = await page.evaluate(() => {
    const cell = [...document.querySelectorAll('[data-streamdown="table-cell"]')].find((el) =>
      (el.textContent || "").includes("CELLPROBE"),
    ) as HTMLElement
    const box = cell.closest('[data-streamdown="table-wrapper"]') as HTMLElement
    box.style.height = `${Math.max(12, box.scrollHeight - 3)}px`
    cell.scrollIntoView({ block: "center" })
    const r = cell.getBoundingClientRect()
    return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2, range: box.scrollHeight - box.clientHeight }
  })
  console.log("RANGE", point.range)
  await page.waitForTimeout(300)

  const before = (await page.evaluate(SCROLLER + "?.scrollTop ?? null")) as number
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(0, -100)
  await page.waitForTimeout(400)
  const after = (await page.evaluate(SCROLLER + "?.scrollTop ?? null")) as number

  console.log("WHEEL", JSON.stringify({ before, after, moved: after - before }))
  expect(after - before).toBeLessThanOrEqual(-90)
})
