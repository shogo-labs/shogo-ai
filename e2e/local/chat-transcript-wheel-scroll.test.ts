import { test, expect, type Page, type Route } from "@playwright/test"
import { openTeamHome } from "./helpers"

/**
 * SHO-365 / SHO-476 — a wheel over reply content must move the transcript.
 *
 * SHO-365 (#1972, Nov 8) fixed the original: Streamdown's table wrapper had
 * `overflow-x-auto overflow-y-auto` + `max-height: 300px`, turning a tall table
 * into a vertical scroller that ate wheel events. Its regression test only put
 * the wheel over a table cell, so the code-block-body regression slipped through.
 *
 * SHO-476 regression: `global.css` gives every fenced code block
 * `max-height: 400px; overflow-y: auto`.  A code block taller than that is a
 * vertical scroller.  `attachNestedWheelPassthrough` is now also wired into the
 * project-chat ScrollView; it hands wheel gestures to the nearest nested scroller
 * that can still move, and falls through to the transcript when no such element
 * exists or is at its edge.
 *
 * This spec is parametrised over the content types from the card: plain text,
 * heading, list item, fenced code block (the new SHO-476 case), and the
 * existing tall table cell.  Each asserts the transcript moves ≥ 50 px in
 * both directions and that the movement holds after 500 ms.
 *
 * Red on v2.6.0 for the code-block cases; green with the fix.
 */

test.setTimeout(300_000)

const CHAT_POST_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"
const MESSAGES_GLOB = "**/api/chat-messages**"

const PLAIN_PROBE = "WHEELPROBE plain paragraph"
const HEADING_PROBE = "WHEELPROBE heading"
const LIST_PROBE = "WHEELPROBE list item"
const CODE_PROBE_MARKER = "WHEELPROBE"
const TABLE_PROBE = "WHEELPROBE the wheel is aimed at this table cell"

function plainReply(): string {
  const filler = Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i}.`).join("\n")
  return [filler, "", PLAIN_PROBE, "", filler].join("\n")
}

function headingReply(): string {
  const filler = Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i}.`).join("\n")
  return [filler, "", `## ${HEADING_PROBE}`, "", filler].join("\n")
}

function listReply(): string {
  const filler = Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i}.`).join("\n")
  const list = [`- ${LIST_PROBE}`, ...Array.from({ length: 29 }, (_, i) => `- list item ${i}`)].join("\n")
  return [filler, "", list, "", filler].join("\n")
}

function codeBlockReply(): string {
  const filler = Array.from({ length: 20 }, (_, i) => `Filler paragraph ${i}.`).join("\n")
  // 50-line code block: taller than the 400 px max-height → vertical scroller
  const codeLines = [
    `// ${CODE_PROBE_MARKER} code block line`,
    ...Array.from({ length: 49 }, (_, i) => `const x${i} = ${i};`),
  ].join("\n")
  return [filler, "", "```typescript", codeLines, "```", "", filler].join("\n")
}

function tableReply(): string {
  const rows = Array.from(
    { length: 26 },
    (_, i) => `| row ${i} | ${i === 4 ? TABLE_PROBE : `value ${i}`} |`,
  )
  return [`## Table probe`, "", "| column | probe |", "| ------ | ----- |", ...rows].join("\n")
}

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

async function install(page: Page, assistantText: string) {
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
      rows.push(
        row(`a${i}`, "assistant", i === 39 ? assistantText : `reply ${i} with a couple of lines of body text.`, base + i * 20_000 + 5_000),
      )
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, items: rows.sort((a, b) => b.createdAt - a.createdAt), total: rows.length }),
    })
  })
}

/** The transcript scroll container: first div with overflow-y:auto and ≥ 100 px of range. */
const SCROLLER = `(() => {
  const all = Array.from(document.querySelectorAll("div"))
  return all.find((el) => getComputedStyle(el).overflowY === "auto" && el.scrollHeight - el.clientHeight > 100) || null
})()`

async function openProject(page: Page) {
  const composer = page
    .getByTestId("home-composer-input")
    .or(page.getByRole("textbox", { name: "Describe the agent you want to build" }))
  await composer.click()
  await composer.fill("wheel probe")
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 60_000 })
}

/**
 * Core assertion: the transcript moves ≥ 50 px up AND down from the probe
 * element, and the position holds after 500 ms.
 */
async function assertBothDirections(page: Page, probe: string, label: string) {
  const point = await page.evaluate((sel) => {
    const node = Array.from(document.querySelectorAll("*")).find(
      (el) => (el.textContent ?? "").includes(sel),
    ) as HTMLElement | undefined
    if (!node) return null
    node.scrollIntoView({ block: "center" })
    const r = node.getBoundingClientRect()
    return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 }
  }, probe)
  if (!point) throw new Error(`${label}: probe element not found in DOM`)

  await page.waitForTimeout(200)
  await page.mouse.move(point.x, point.y)

  const before = (await page.evaluate(SCROLLER + "?.scrollTop ?? null")) as number | null
  if (before === null) throw new Error(`${label}: no transcript scroll container found`)

  // UP
  await page.mouse.wheel(0, -100)
  await page.waitForTimeout(500)
  const afterUp = (await page.evaluate(SCROLLER + "?.scrollTop ?? null")) as number
  console.log(`${label} UP: before=${before} after=${afterUp} moved=${afterUp - before}`)
  expect(afterUp - before, `${label}: wheel up must move transcript ≥50 px up`).toBeLessThanOrEqual(-50)

  // DOWN (restore then continue)
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(500)
  const afterDown = (await page.evaluate(SCROLLER + "?.scrollTop ?? null")) as number
  console.log(`${label} DOWN: afterUp=${afterUp} afterDown=${afterDown} moved=${afterDown - afterUp}`)
  expect(afterDown - afterUp, `${label}: wheel down must move transcript ≥50 px down`).toBeGreaterThanOrEqual(50)
}

// ─── individual specs ────────────────────────────────────────────────────────

test("a wheel over plain paragraph text scrolls the transcript", async ({ page }) => {
  await install(page, plainReply())
  await openTeamHome(page)
  await openProject(page)
  await expect(page.getByText(PLAIN_PROBE, { exact: false }).first()).toBeVisible({ timeout: 150_000 })
  await assertBothDirections(page, PLAIN_PROBE, "plain-text")
})

test("a wheel over a heading scrolls the transcript", async ({ page }) => {
  await install(page, headingReply())
  await openTeamHome(page)
  await openProject(page)
  await expect(page.getByText(HEADING_PROBE, { exact: false }).first()).toBeVisible({ timeout: 150_000 })
  await assertBothDirections(page, HEADING_PROBE, "heading")
})

test("a wheel over a list item scrolls the transcript", async ({ page }) => {
  await install(page, listReply())
  await openTeamHome(page)
  await openProject(page)
  await expect(page.getByText(LIST_PROBE, { exact: false }).first()).toBeVisible({ timeout: 150_000 })
  await assertBothDirections(page, LIST_PROBE, "list-item")
})

test("a wheel over a tall fenced code block scrolls it at mid-travel and the transcript at the edge", async ({ page }) => {
  await install(page, codeBlockReply())
  await openTeamHome(page)
  await openProject(page)
  await expect(page.getByText(CODE_PROBE_MARKER, { exact: false }).first()).toBeVisible({ timeout: 150_000 })

  // The code-block-body must be a capped vertical scroller.
  const codeBox = await page.evaluate(() => {
    const body = document.querySelector('[data-streamdown="code-block-body"]') as HTMLElement | null
    if (!body) return null
    const style = getComputedStyle(body)
    return { overflowY: style.overflowY, maxHeight: style.maxHeight, range: body.scrollHeight - body.clientHeight }
  })
  console.log("CODEBOX", JSON.stringify(codeBox))
  expect(codeBox?.overflowY, "code-block-body must be overflow-y: auto").toBe("auto")
  expect(Number(codeBox?.range ?? 0), "code block must overflow its cap").toBeGreaterThan(10)

  // Mid-travel: the code block itself should scroll.
  const codePoint = await page.evaluate(() => {
    const body = document.querySelector('[data-streamdown="code-block-body"]') as HTMLElement | null
    if (!body) return null
    body.scrollTop = Math.floor((body.scrollHeight - body.clientHeight) / 2)
    const r = body.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (!codePoint) throw new Error("code-block-body not found")
  await page.mouse.move(codePoint.x, codePoint.y)
  const codeScrollBefore = (await page.evaluate(
    () => (document.querySelector('[data-streamdown="code-block-body"]') as HTMLElement)?.scrollTop ?? -1,
  )) as number
  await page.mouse.wheel(0, 100)
  await page.waitForTimeout(300)
  const codeScrollAfter = (await page.evaluate(
    () => (document.querySelector('[data-streamdown="code-block-body"]') as HTMLElement)?.scrollTop ?? -1,
  )) as number
  console.log("CODE SCROLL", { codeScrollBefore, codeScrollAfter })
  expect(codeScrollAfter - codeScrollBefore, "wheel mid-travel must scroll the code block").toBeGreaterThan(10)

  // At the bottom edge: transcript should scroll.
  await page.evaluate(() => {
    const body = document.querySelector('[data-streamdown="code-block-body"]') as HTMLElement | null
    if (body) body.scrollTop = body.scrollHeight
  })
  const transcriptBefore = (await page.evaluate(SCROLLER + "?.scrollTop ?? null")) as number | null
  if (transcriptBefore === null) throw new Error("no transcript scroller for code-at-edge check")
  await page.mouse.move(codePoint.x, codePoint.y)
  await page.mouse.wheel(0, 100)
  await page.waitForTimeout(500)
  const transcriptAfter = (await page.evaluate(SCROLLER + "?.scrollTop ?? null")) as number
  console.log("TRANSCRIPT AT EDGE", { transcriptBefore, transcriptAfter })
  expect(transcriptAfter - transcriptBefore, "wheel at code block bottom edge must scroll transcript").toBeGreaterThanOrEqual(50)
})

test("a wheel over a tall table cell scrolls the transcript (SHO-365 regression guard)", async ({ page }) => {
  await install(page, tableReply())
  await openTeamHome(page)
  const composer = page
    .getByTestId("home-composer-input")
    .or(page.getByRole("textbox", { name: "Describe the agent you want to build" }))
  await composer.click()
  await composer.fill("tall table wheel probe")
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 60_000 })
  await expect(page.getByText("WHEELPROBE", { exact: false }).first()).toBeVisible({ timeout: 150_000 })

  const point = await page.evaluate(() => {
    const cell = Array.from(document.querySelectorAll('[data-streamdown="table-cell"]')).find((el) =>
      (el.textContent || "").includes("WHEELPROBE"),
    ) as HTMLElement
    cell.scrollIntoView({ block: "center" })
    const r = cell.getBoundingClientRect()
    return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 }
  })
  await page.waitForTimeout(300)

  const box = await page.evaluate(() => {
    const cell = Array.from(document.querySelectorAll('[data-streamdown="table-cell"]')).find((el) =>
      (el.textContent || "").includes("WHEELPROBE"),
    ) as HTMLElement
    const outer = cell.closest('[data-streamdown="table-wrapper"]') as HTMLElement
    const wrapper = outer.firstElementChild as HTMLElement
    const style = getComputedStyle(wrapper)
    return { overflowY: style.overflowY, maxHeight: style.maxHeight }
  })
  console.log("TABLEBOX", JSON.stringify(box))

  const before = (await page.evaluate(SCROLLER + "?.scrollTop ?? null")) as number
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(0, -100)
  await page.waitForTimeout(400)
  const after = (await page.evaluate(SCROLLER + "?.scrollTop ?? null")) as number
  console.log("WHEEL TABLE", { before, after, moved: after - before })

  expect(["hidden", "clip"]).toContain(box.overflowY)
  expect(box.maxHeight).toBe("none")
  expect(after - before).toBeLessThanOrEqual(-90)
})
