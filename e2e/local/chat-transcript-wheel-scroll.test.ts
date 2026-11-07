import { test, expect, type Page, type Route } from "@playwright/test"
import { openTeamHome } from "./helpers"

test.setTimeout(300_000)

const CHAT_POST_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"
const MESSAGES_GLOB = "**/api/chat-messages**"

const PARA = "EXACTPROBE paragraph text that the wheel is aimed at."

const REPLY = [
  `### Exact probe`,
  ``,
  PARA,
  ``,
  "```ts",
  "const value = 1",
  "```",
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
        body: JSON.stringify({ ok: true, items: [], total: 30, cursor: new Date().toISOString(), reset: false }),
      })
    }
    const base = Date.now() - 400_000
    const rows = []
    for (let i = 0; i < 30; i++) {
      rows.push(row(`u${i}`, "user", `question ${i} about the thing`, base + i * 20_000))
      rows.push(row(`a${i}`, "assistant", i === 29 ? REPLY : `reply ${i} with a couple of lines of body text.`, base + i * 20_000 + 5_000))
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

test("one wheel notch moves the transcript once", async ({ page }) => {
  await install(page)
  await openTeamHome(page)
  const composer = page
    .getByTestId("home-composer-input")
    .or(page.getByRole("textbox", { name: "Describe the agent you want to build" }))
  await composer.click()
  await composer.fill("exact probe")
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 60_000 })
  await expect(page.getByText("EXACTPROBE", { exact: false }).first()).toBeVisible({ timeout: 150_000 })

  const point = await page.evaluate((marker) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      if (node.textContent && node.textContent.includes(marker)) {
        const el = node.parentElement as HTMLElement
        el.scrollIntoView({ block: "center" })
        const r = el.getBoundingClientRect()
        return { x: r.x + Math.min(r.width / 2, 50), y: r.y + r.height / 2 }
      }
      node = walker.nextNode()
    }
    return null
  }, PARA)
  expect(point).toBeTruthy()
  await page.waitForTimeout(400)

  const readings: number[] = []
  const read = () => page.evaluate(SCROLLER + "?.scrollTop ?? null") as Promise<number>

  readings.push(await read())
  await page.mouse.move(point!.x, point!.y)
  await page.mouse.wheel(0, -100)
  await page.waitForTimeout(300)
  readings.push(await read())
  await page.mouse.wheel(0, -100)
  await page.waitForTimeout(300)
  readings.push(await read())

  const first = readings[1] - readings[0]
  const second = readings[2] - readings[1]
  console.log("EXACT", JSON.stringify({ readings, first, second }))
  // Never more than the notch: a doubled scroll would read -200.
  expect(first).toBeLessThanOrEqual(-90)
  expect(first).toBeGreaterThanOrEqual(-110)
  expect(second).toBeLessThanOrEqual(-90)
  expect(second).toBeGreaterThanOrEqual(-110)
})
