import { test, expect, type Page, type Route } from "@playwright/test"
import { openTeamHome } from "./helpers"

/**
 * SHO-365 / SHO-476 — a wheel over reply content must move the transcript.
 *
 * SHO-365 (#1972, Nov 8) fixed the original: Streamdown's table wrapper had
 * `overflow-x-auto overflow-y-auto` + `max-height: 300px`, turning a tall table
 * into a vertical scroller that ate wheel events. Its regression test only put
 * the wheel over a table cell, so every other content type was unguarded.
 *
 * This spec aims a real wheel at the deepest element carrying a probe string —
 * the `<p>`, `<h2>`, `<li>`, `<code>`, `<a>` or `<td>` a reader's mouse would
 * actually be over — and requires the transcript to move ≥ 50 px in the
 * gesture's direction, then still be there 500 ms later. The 500 ms re-read is
 * deliberate: a scroll that a turn-window correction or a streaming bottom-pin
 * immediately undoes is the same bug to the reader as one that never happened.
 *
 * History: the first version of this spec resolved its probe with
 * `document.querySelectorAll("*")` and took the first element whose
 * `textContent` contained the probe — which is `<html>`. The wheel was then
 * aimed at (40, viewport-centre), i.e. the gutter *outside* the transcript, so
 * four of its five cases failed on the branch and on `main` alike. `aimProbe`
 * below resolves the deepest text node and `aimProbe` fails loudly when the
 * point it computes is not inside the transcript, so that mistake cannot recur.
 */

test.setTimeout(300_000)

const CHAT_POST_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"
const MESSAGES_GLOB = "**/api/chat-messages**"

const PLAIN_PROBE = "WHEELPROBE plain paragraph"
const HEADING_PROBE = "WHEELPROBE heading"
const LIST_PROBE = "WHEELPROBE list item"
const INLINE_CODE_PROBE = "WHEELPROBEINLINE"
const LINK_PROBE = "WHEELPROBE link"
const STREAM_PROBE = "WHEELPROBE streamed reply"
const CODE_PROBE_MARKER = "WHEELPROBE"
const TABLE_PROBE = "WHEELPROBE the wheel is aimed at this table cell"

/** The composer text `openProject` types; the streaming mock keys off it. */
const PROJECT_PROMPT = "wheel probe"

/** Minimum travel the transcript must make, in px, for a two-notch wheel. */
const MIN_TRAVEL_PX = 50

function filler(count: number): string {
  return Array.from({ length: count }, (_, i) => `Filler paragraph ${i}.`).join("\n")
}

function plainReply(): string {
  return [filler(30), "", PLAIN_PROBE, "", filler(30)].join("\n")
}

function headingReply(): string {
  return [filler(30), "", `## ${HEADING_PROBE}`, "", filler(30)].join("\n")
}

function listReply(): string {
  const list = [`- ${LIST_PROBE}`, ...Array.from({ length: 29 }, (_, i) => `- list item ${i}`)].join("\n")
  return [filler(30), "", list, "", filler(30)].join("\n")
}

function inlineCodeReply(): string {
  return [filler(30), "", `Inline \`${INLINE_CODE_PROBE}\` code in a paragraph.`, "", filler(30)].join("\n")
}

function linkReply(): string {
  return [filler(30), "", `A [${LINK_PROBE}](https://example.com/target) in a paragraph.`, "", filler(30)].join("\n")
}

function codeBlockReply(): string {
  // 50-line code block: taller than the 400 px max-height → vertical scroller
  const codeLines = [
    `// ${CODE_PROBE_MARKER} code block line`,
    ...Array.from({ length: 49 }, (_, i) => `const x${i} = ${i};`),
  ].join("\n")
  return [filler(20), "", "```typescript", codeLines, "```", "", filler(20)].join("\n")
}

function tableReply(): string {
  const rows = Array.from(
    { length: 26 },
    (_, i) => `| row ${i} | ${i === 4 ? TABLE_PROBE : `value ${i}`} |`,
  )
  return [`## Table probe`, "", "| column | probe |", "| ------ | ----- |", ...rows].join("\n")
}

/** The streamed reply: long enough that the transcript has room to move. */
function streamedReply(): string {
  return [STREAM_PROBE, ...Array.from({ length: 160 }, (_, i) => `token${i}`)].join(" ")
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

/**
 * Patch `window.fetch` so the chat POST really streams — a `route.fulfill` SSE
 * body arrives in one chunk, which cannot stand in for a reply that is still
 * arriving. The stream stays open until the spec sets `__sho476Release`, so the
 * wheel can be aimed at a live reply and the "did the bottom-pin undo it?"
 * question can actually be asked.
 */
async function installStreaming(page: Page) {
  await page.addInitScript(
    ({ leadText, frameMs }) => {
      const originalFetch = window.fetch.bind(window)
      const encoder = new TextEncoder()
      const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`

      const respond = (text: string) => {
        const frames: string[] = [
          frame({ type: "start", messageId: "msg_stream" }),
          frame({ type: "start-step" }),
          frame({ type: "text-start", id: "msg_stream-t" }),
        ]
        text.split(" ").forEach((word, index) => {
          frames.push(
            frame({ type: "text-delta", id: "msg_stream-t", delta: index === 0 ? word : ` ${word}` }),
          )
        })
        return new Response(
          new ReadableStream({
            start(controller) {
              let index = 0
              const timer = setInterval(() => {
                if (index < frames.length) {
                  controller.enqueue(encoder.encode(frames[index]))
                  index += 1
                  return
                }
                // Hold the turn open: the reply is still streaming.
                if (!(window as any).__sho476Release) return
                clearInterval(timer)
                try {
                  controller.close()
                } catch {
                  // the page cancelled the stream
                }
              }, frameMs)
            },
            cancel() {
              // Stopped by the page.
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
          },
        )
      }

      const patched = (input: any, init?: RequestInit): Promise<Response> => {
        const rawUrl =
          typeof input === "string" ? input : input instanceof Request ? input.url : String(input)
        const url = new URL(rawUrl, window.location.href)
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
        const chatPost = /^\/api\/(projects|workspaces)\/[^/]+\/chat$/
        if (method === "POST" && chatPost.test(url.pathname)) {
          const body = typeof init?.body === "string" ? init.body : ""
          if (body.includes(leadText)) return Promise.resolve(respond(leadText))
        }
        return originalFetch(input, init)
      }
      window.fetch = patched as typeof window.fetch
    },
    { leadText: PROJECT_PROMPT, frameMs: 40 },
  )
}

/** Page-side: the transcript's own scroll container. */
const TRANSCRIPT = `(() => {
  const all = Array.from(document.querySelectorAll("div"))
  return all.find((el) => getComputedStyle(el).overflowY === "auto" && el.scrollHeight - el.clientHeight > 100) || null
})()`

async function transcriptTop(page: Page, label: string): Promise<number> {
  const top = (await page.evaluate(TRANSCRIPT + "?.scrollTop ?? null")) as number | null
  if (top === null) throw new Error(`${label}: no transcript scroll container found`)
  return top
}

/**
 * The point a reader's pointer sits on when it is over `probe`: the centre of
 * the deepest element that carries the probe in its own text.
 *
 * Resolving via `document.querySelectorAll("*")` finds `<html>` first (its
 * `textContent` contains the whole page) and would aim the wheel at the gutter,
 * so this walks text nodes instead. It also asserts that
 * `document.elementFromPoint` at the chosen point really lands inside the
 * transcript — a probe that resolves outside it can only ever measure the
 * gutter, never the bug.
 */
async function aimProbe(page: Page, probe: string, label: string): Promise<{ x: number; y: number }> {
  const aimed = await page.evaluate(
    ({ text }) => {
      const all = Array.from(document.querySelectorAll("div"))
      const scroller =
        all.find(
          (el) => getComputedStyle(el).overflowY === "auto" && el.scrollHeight - el.clientHeight > 100,
        ) ?? null
      if (!scroller) return { error: "no transcript scroll container" }

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let node: Node | null = null
      while ((node = walker.nextNode())) {
        if ((node.textContent ?? "").includes(text)) break
        node = null
      }
      const element = node?.parentElement ?? null
      if (!element) return { error: `probe text not found: ${text}` }

      element.scrollIntoView({ block: "center" })
      const rect = element.getBoundingClientRect()
      const x = rect.left + Math.min(rect.width / 2, 40)
      const y = rect.top + rect.height / 2
      const hit = document.elementFromPoint(x, y)
      return {
        x,
        y,
        tag: element.tagName,
        inTranscript: !!hit && scroller.contains(hit),
        hitTag: hit?.tagName ?? null,
      }
    },
    { text: probe },
  )

  if ("error" in aimed) throw new Error(`${label}: ${aimed.error}`)
  if (!aimed.inTranscript) {
    throw new Error(
      `${label}: wheel would land on <${aimed.hitTag}> at (${Math.round(aimed.x)}, ${Math.round(
        aimed.y,
      )}), outside the transcript — the probe resolved to <${aimed.tag}>`,
    )
  }
  return { x: aimed.x, y: aimed.y }
}

async function openProject(page: Page) {
  const composer = page
    .getByTestId("home-composer-input")
    .or(page.getByRole("textbox", { name: "Describe the agent you want to build" }))
  await composer.click()
  await composer.fill(PROJECT_PROMPT)
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 60_000 })
}

/**
 * Core assertion: from the probe, the transcript moves ≥ MIN_TRAVEL_PX up and
 * ≥ MIN_TRAVEL_PX back down, and each new position survives 500 ms.
 */
async function assertBothDirections(page: Page, probe: string, label: string) {
  const point = await aimProbe(page, probe, label)
  await page.waitForTimeout(200)
  await page.mouse.move(point.x, point.y)

  const before = await transcriptTop(page, label)

  // UP
  await page.mouse.wheel(0, -100)
  await page.waitForTimeout(500)
  const afterUp = await transcriptTop(page, label)
  console.log(`${label} UP: before=${before} after=${afterUp} moved=${afterUp - before}`)
  expect(afterUp - before, `${label}: wheel up must move the transcript ≥${MIN_TRAVEL_PX} px`).toBeLessThanOrEqual(
    -MIN_TRAVEL_PX,
  )

  // DOWN
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(500)
  const afterDown = await transcriptTop(page, label)
  console.log(`${label} DOWN: afterUp=${afterUp} afterDown=${afterDown} moved=${afterDown - afterUp}`)
  expect(
    afterDown - afterUp,
    `${label}: wheel down must move the transcript ≥${MIN_TRAVEL_PX} px`,
  ).toBeGreaterThanOrEqual(MIN_TRAVEL_PX)
}

/** One spec shape for every static content type. */
function wheelCase(name: string, probe: string, reply: () => string) {
  test(`a wheel over ${name} scrolls the transcript`, async ({ page }) => {
    await install(page, reply())
    await openTeamHome(page)
    await openProject(page)
    await expect(page.getByText(probe, { exact: false }).first()).toBeVisible({ timeout: 150_000 })
    await assertBothDirections(page, probe, name.replace(/\s+/g, "-"))
  })
}

// ─── static content types ───────────────────────────────────────────────────

wheelCase("plain paragraph text", PLAIN_PROBE, plainReply)
wheelCase("a heading", HEADING_PROBE, headingReply)
wheelCase("a list item", LIST_PROBE, listReply)
wheelCase("inline code", INLINE_CODE_PROBE, inlineCodeReply)
wheelCase("a link", LINK_PROBE, linkReply)

// ─── a tall fenced code block ───────────────────────────────────────────────

/**
 * Holds the code block's own scroller at one of its edges and returns the point
 * the pointer should sit under.
 *
 * Mid-travel is not a usable starting state: the row re-renders whenever the
 * transcript scrolls, which recreates the node with `scrollTop = 0`. CI
 * measured exactly that — `CODE SCROLL { before: 316, after: 100 }`: the
 * mid-travel offset was gone by the time the wheel landed, and the notch went
 * to a fresh node — so an assertion on mid-travel tests the re-render, not the
 * wheel. An edge survives the re-render and is also the position where the
 * block has nothing left to scroll, i.e. where the gesture has to reach the
 * transcript.
 */
async function aimCodeBlockEdge(
  page: Page,
  edge: "top" | "bottom",
): Promise<{ x: number; y: number }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const aimed = (await page.evaluate((where) => {
      const body = document.querySelector('[data-streamdown="code-block-body"]') as HTMLElement | null
      if (!body) return null
      body.scrollIntoView({ block: "center" })
      body.scrollTop = where === "top" ? 0 : body.scrollHeight
      const rect = body.getBoundingClientRect()
      const range = body.scrollHeight - body.clientHeight
      const atEdge = where === "top" ? body.scrollTop <= 0 : body.scrollTop >= range - 2
      return { x: rect.left + Math.min(rect.width / 2, 40), y: rect.top + rect.height / 2, atEdge }
    }, edge)) as { x: number; y: number; atEdge: boolean } | null

    if (aimed?.atEdge) {
      // Let a pending re-render land, then confirm the edge held.
      await page.waitForTimeout(150)
      const held = (await page.evaluate((where) => {
        const body = document.querySelector('[data-streamdown="code-block-body"]') as HTMLElement | null
        if (!body) return false
        const range = body.scrollHeight - body.clientHeight
        return where === "top" ? body.scrollTop <= 0 : body.scrollTop >= range - 2
      }, edge)) as boolean
      if (held) return { x: aimed.x, y: aimed.y }
    }
    await page.waitForTimeout(150)
  }
  throw new Error(`code-block-body could not be held at its ${edge} edge`)
}

test("a wheel over a tall fenced code block reaches the transcript at either edge", async ({ page }) => {
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

  // Up, from the block's top edge: the block cannot take the gesture, so the
  // transcript must. Done first, while the transcript sits at its bottom (the
  // newest reply) and therefore has room above it.
  const top = await aimCodeBlockEdge(page, "top")
  await page.mouse.move(top.x, top.y)
  const beforeUp = await transcriptTop(page, "code-top-edge")
  expect(beforeUp, "code-top-edge: the transcript needs room above it for this case").toBeGreaterThan(0)
  await page.mouse.wheel(0, -100)
  await page.waitForTimeout(500)
  const afterUp = await transcriptTop(page, "code-top-edge")
  console.log("CODE TOP EDGE", { beforeUp, afterUp })
  expect(
    beforeUp - afterUp,
    "wheel up at the code block's top edge must scroll the transcript",
  ).toBeGreaterThanOrEqual(MIN_TRAVEL_PX)

  // Down, from its bottom edge.
  const bottom = await aimCodeBlockEdge(page, "bottom")
  await page.mouse.move(bottom.x, bottom.y)
  const beforeDown = await transcriptTop(page, "code-bottom-edge")
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(500)
  const afterDown = await transcriptTop(page, "code-bottom-edge")
  console.log("CODE BOTTOM EDGE", { beforeDown, afterDown })
  expect(
    afterDown - beforeDown,
    "wheel down at the code block's bottom edge must scroll the transcript",
  ).toBeGreaterThanOrEqual(MIN_TRAVEL_PX)
})

// ─── the SHO-365 table guard ────────────────────────────────────────────────

test("a wheel over a tall table cell scrolls the transcript (SHO-365 regression guard)", async ({ page }) => {
  await install(page, tableReply())
  await openTeamHome(page)
  await openProject(page)
  await expect(page.getByText("WHEELPROBE", { exact: false }).first()).toBeVisible({ timeout: 150_000 })

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
  expect(["hidden", "clip"]).toContain(box.overflowY)
  expect(box.maxHeight).toBe("none")

  await assertBothDirections(page, TABLE_PROBE, "table-cell")
})

// ─── a reply that is still streaming ────────────────────────────────────────

test("a wheel over a reply that is still streaming scrolls the transcript and is not undone by the next token", async ({
  page,
}) => {
  await install(page, streamedReply())
  await installStreaming(page)
  await openTeamHome(page)
  await openProject(page)

  // The reply is up and still arriving: release is deliberately unset.
  await expect(page.getByText(STREAM_PROBE, { exact: false }).first()).toBeVisible({ timeout: 150_000 })

  const point = await aimProbe(page, STREAM_PROBE, "streaming")
  await page.mouse.move(point.x, point.y)

  const before = await transcriptTop(page, "streaming")
  await page.mouse.wheel(0, -100)

  // Read once the wheel has had time to land, and again a full second later
  // while tokens keep arriving: a bottom-pin that re-engages would drag the
  // transcript back to the end between the two reads.
  await page.waitForTimeout(500)
  const afterUp = await transcriptTop(page, "streaming")
  await page.waitForTimeout(1_000)
  const settled = await transcriptTop(page, "streaming")
  console.log("STREAMING UP", { before, afterUp, settled, moved: afterUp - before, drift: settled - afterUp })

  expect(afterUp - before, "wheel up during a stream must move the transcript").toBeLessThanOrEqual(-MIN_TRAVEL_PX)
  expect(
    settled - afterUp,
    "the stream must not re-pin the transcript to the bottom after a user wheel up",
  ).not.toBeGreaterThan(2)

  await page.evaluate(() => ((window as any).__sho476Release = true))
})
