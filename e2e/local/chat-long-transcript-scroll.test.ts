// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test, type Page } from "@playwright/test"
import { openTeamHome } from "./helpers"

/**
 * Long chats must still scroll and expand (SHO-359).
 *
 * SHO-354 (#1953) mounts only a window of turns in a long transcript. Its tests
 * were jsdom, which has no layout, no ResizeObserver timing and no scroll
 * anchoring — so nothing exercised the window in a browser. In Chromium the
 * window then fought the browser: scroll anchoring moved `scrollTop` for a
 * mount above the reader and the hook's own `real − estimate` correction moved
 * it again, so every window expansion threw the reader ("scrolling up and down
 * doesnt work in some chats", Russell, 2026-11-07) and a work group could not
 * be clicked open because the row moved out from under the click.
 *
 * These specs are the real-browser half of the card:
 *
 *  1. a 120-turn chat scrolls from the bottom to the first turn and back with
 *     the wheel, always in the direction it was turned;
 *  2. a window expansion never moves the row the reader is looking at;
 *  3. a WorkedFor group opens on the first click, in the tail turn and in a
 *     turn above the tail window, without moving the header it was clicked on;
 *  4. a chat of 30 turns or fewer is untouched (no spacer, nothing windowed).
 *
 *   npx playwright test --config e2e/local/playwright.config.ts chat-long-transcript-scroll
 */

test.use({ video: "off", trace: "off" })

/** Turns (user + assistant pairs) the long fixture chat holds. */
const TURN_COUNT = Number(process.env.E2E_LONG_CHAT_TURNS || 120)
/** Turns in the short fixture chat: below the 30-turn window, so never windowed. */
const SHORT_TURN_COUNT = 12
/** Turns SHO-354 keeps mounted at the tail. */
const TAIL_WINDOW = 30
const HEAD_MARKER = "long-chat-head-marker"
const TAIL_MARKER = "long-chat-tail-marker"
const ROW_MARKER = "long-chat-row"
/** A row may not move by more than this (px) across an expansion or a click. */
const JUMP_TOLERANCE = 2
/** One wheel notch of the scroll-up walk. */
const WHEEL_STEP = 1_200
/**
 * Chromium does not deliver `mouse.wheel(0, 1200)` as exactly 1200 px of
 * scroll — it normalises the delta, and the amount it lands on varies a little
 * between runs (1186.5 and 1205 observed). A row that keeps its place under the
 * reader moves by the wheel's distance, so the comparison needs a few percent
 * of slack. A second, unowned correction is orders of magnitude larger: it
 * moves the row by the whole expansion height, thousands of px.
 */
const WHEEL_TOLERANCE = Math.round(WHEEL_STEP * 0.04)
/**
 * Slack for `scrollTop` while pinned to the bottom of the transcript: the
 * container clamps against `maxScroll`, so a height-estimate correction of a
 * few px cannot move the reader's content even though `scrollTop` shifts.
 */
const BOTTOM_SCROLL_SLACK = 8
const CHAT_POST_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"
const STREAM_GLOB = "**/api/{projects,workspaces}/*/chat/*/stream*"
const MESSAGES_GLOB = "**/api/chat-messages**"

/**
 * The transcript's scroll container, found from a marker it renders: the
 * nearest ancestor that actually scrolls. The panel has no test id for it, and
 * a hard-coded class would break on the next layout change.
 */
const FIND_SCROLLER = `function (marker) {
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  var node = walker.nextNode()
  var anchor = null
  while (node) {
    if (node.textContent && node.textContent.indexOf(marker) !== -1) {
      anchor = node.parentElement
      break
    }
    node = walker.nextNode()
  }
  if (!anchor) return null
  var el = anchor
  while (el && el !== document.body) {
    var style = getComputedStyle(el)
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20) return el
    el = el.parentElement
  }
  return null
}`

function sseFrame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

function completedTurn(messageId: string, text: string): string {
  return [
    sseFrame({ type: "start", messageId }),
    sseFrame({ type: "start-step" }),
    sseFrame({ type: "text-start", id: `${messageId}-t` }),
    sseFrame({ type: "text-delta", id: `${messageId}-t`, delta: text }),
    sseFrame({ type: "text-end", id: `${messageId}-t` }),
    sseFrame({ type: "finish-step" }),
    sseFrame({ type: "finish" }),
  ].join("")
}

/**
 * An assistant turn with a *closed* work group (two tool calls folded behind
 * "Worked · …") and a body much taller than the 280 px a collapsed turn is
 * charged. Mixed heights are the point: an estimate that is wrong in both
 * directions is what one correction has to absorb.
 */
function assistantParts(index: number): unknown[] {
  const lines = Array.from(
    { length: 14 },
    (_, line) => `- ${ROW_MARKER} ${index} line ${line} with **bold** and \`code\` text`,
  ).join("\n")
  return [
    {
      type: "dynamic-tool",
      toolCallId: `call-${index}-a`,
      toolName: "read_file",
      state: "output-available",
      input: { path: `src/file-${index}.ts` },
      output: `contents of src/file-${index}.ts`,
    },
    {
      type: "dynamic-tool",
      toolCallId: `call-${index}-b`,
      toolName: "edit_file",
      state: "output-available",
      input: { path: `src/file-${index}.ts` },
      output: `edited src/file-${index}.ts`,
    },
    { type: "text", text: `### Reply ${index}\n\n${lines}` },
  ]
}

function savedRow(
  id: string,
  role: "user" | "assistant",
  parts: unknown[],
  createdAt: number,
): Record<string, unknown> {
  const text = parts.map((part) => (part as { text?: string }).text ?? "").join("\n")
  return {
    id,
    sessionId: "",
    role,
    content: text,
    parts: JSON.stringify(parts),
    createdAt,
    updatedAt: createdAt,
  }
}

/** The fixture: short user turns, tall assistant turns with work groups. */
function chatRows(turns: number): Array<Record<string, unknown>> {
  const base = Date.now() - turns * 120_000
  const rows: Array<Record<string, unknown>> = []
  for (let index = 0; index < turns; index++) {
    const head = index === 0 ? `${HEAD_MARKER} ` : ""
    const tail = index === turns - 1 ? `\n\n${TAIL_MARKER}` : ""
    const parts = assistantParts(index)
    if (tail) parts.push({ type: "text", text: `Reply ${index}${tail}` })
    rows.push(
      savedRow(`u${index}`, "user", [{ type: "text", text: `${head}question ${index}` }], base + index * 120_000),
      savedRow(`a${index}`, "assistant", parts, base + index * 120_000 + 30_000),
    )
  }
  return rows
}

interface LongChatState {
  rows: Array<Record<string, unknown>>
  sessionId: string | null
}

/**
 * Serve the project chat's history from the fixture and its (idle) turn
 * endpoints, so the panel mounts a real long transcript.
 */
async function installLongChat(page: Page, turns: number): Promise<LongChatState> {
  const state: LongChatState = { rows: chatRows(turns), sessionId: null }
  await page.addInitScript(`window.__e2eFindScroller = ${FIND_SCROLLER}`)

  await page.route(CHAT_POST_GLOB, async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    state.sessionId =
      state.sessionId ?? route.request().headers()["x-chat-session-id"] ?? null
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: completedTurn("msg_bootstrap", "Bootstrap done."),
    })
  })

  await page.route(TURN_GLOB, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "completed" }),
    })
  })

  await page.route(STREAM_GLOB, async (route) => {
    await route.fulfill({ status: 204, body: "" })
  })

  await page.route(MESSAGES_GLOB, async (route) => {
    const request = route.request()
    if (request.method() !== "GET") return route.continue()
    const url = new URL(request.url())
    const sessionId =
      state.sessionId ?? url.searchParams.get("sessionId") ?? "session-under-test"
    const rows = state.rows.map((row) => ({ ...row, sessionId }))

    if (url.pathname.endsWith("/changes")) {
      const newest = rows.reduce(
        (cursor, row) => Math.max(cursor, Number(row.updatedAt)),
        0,
      )
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          items: [],
          total: rows.length,
          cursor: new Date(newest).toISOString(),
          reset: false,
        }),
      })
      return
    }

    // One page holds the whole fixture: the window is what keeps the mount
    // bounded, not the paging.
    const newestFirst = [...rows].sort(
      (a, b) => Number(b.createdAt) - Number(a.createdAt),
    )
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, items: newestFirst, total: rows.length }),
    })
  })

  return state
}

async function scrollerRect(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await page.evaluate((marker) => {
    const el = (window as any).__e2eFindScroller(marker) as HTMLElement | null
    if (!el) return null
    const box = el.getBoundingClientRect()
    return { x: box.left, y: box.top, width: box.width, height: box.height }
  }, TAIL_MARKER)
  if (!rect) throw new Error("the transcript has no scroll container")
  return rect
}

async function scrollTop(page: Page): Promise<number> {
  return page.evaluate(
    (marker) => {
      const el = (window as any).__e2eFindScroller(marker) as HTMLElement | null
      return el ? el.scrollTop : -1
    },
    TAIL_MARKER,
  )
}

async function scrollMetrics(page: Page) {
  return page.evaluate(
    (marker) => {
      const el = (window as any).__e2eFindScroller(marker) as HTMLElement | null
      return el ? { top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight } : null
    },
    TAIL_MARKER,
  )
}

/** Wheel over the transcript, as a person does — not `scrollTop = n`. */
async function wheel(page: Page, deltaY: number, times = 1, settleMs = 60): Promise<void> {
  const box = await scrollerRect(page)
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 240))
  for (let index = 0; index < times; index++) {
    await page.mouse.wheel(0, deltaY)
    await page.waitForTimeout(settleMs)
  }
}

/** Every mounted turn row, in transcript order. */
async function mountedRows(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="turn-row-"]')).map(
      (node) => node.getAttribute("data-testid")!,
    ),
  )
}

/**
 * The mounted row nearest the middle of the transcript's visible area, with its
 * on-screen y. The row a reader's eye is on: if a window expansion is
 * corrected properly, this stays put (minus the wheel that caused it).
 */
async function anchorRow(page: Page): Promise<{ id: string; top: number } | null> {
  return page.evaluate((marker) => {
    const scroller = (window as any).__e2eFindScroller(marker) as HTMLElement | null
    if (!scroller) return null
    const viewport = scroller.getBoundingClientRect()
    const middle = viewport.top + viewport.height / 2
    let best: { id: string; top: number; distance: number } | null = null
    for (const node of Array.from(
      document.querySelectorAll('[data-testid^="turn-row-"]'),
    ) as HTMLElement[]) {
      const rect = node.getBoundingClientRect()
      if (rect.bottom < viewport.top || rect.top > viewport.bottom) continue
      const distance = Math.abs(rect.top - middle)
      if (!best || distance < best.distance) {
        best = { id: node.getAttribute("data-testid")!, top: rect.top, distance }
      }
    }
    return best ? { id: best.id, top: best.top } : null
  }, TAIL_MARKER)
}

async function rowTop(page: Page, id: string): Promise<number | null> {
  return page.evaluate((testId) => {
    const node = document.querySelector(`[data-testid="${testId}"]`)
    return node ? node.getBoundingClientRect().top : null
  }, id)
}

/**
 * Put the transcript at its newest turn and wait for it to stay there: the
 * newest windows mount and measure for a few frames, which moves the end of
 * the content.
 */
async function settleAtBottom(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const metrics = await scrollMetrics(page)
    if (!metrics) throw new Error("the transcript has no scroll container")
    if (metrics.top >= metrics.height - metrics.viewport - 2) {
      await page.waitForTimeout(400)
      const again = await scrollMetrics(page)
      if (again && again.top >= again.height - again.viewport - 2) return
    }
    await page.evaluate((marker) => {
      const el = (window as any).__e2eFindScroller(marker) as HTMLElement | null
      if (el) el.scrollTop = el.scrollHeight
    }, TAIL_MARKER)
    await page.waitForTimeout(300)
  }
  throw new Error("the transcript never settled at its newest turn")
}

/**
 * Bring a "Worked" header that belongs to a turn mounted *above* the tail
 * window into view, and mark it for the click.
 *
 * It scrolls the transcript the way the scrollbar does rather than letting
 * Playwright scroll the element into view, because that scroll would be the
 * very thing the assertions measure. Repeats until the header is sitting in
 * the middle of the viewport, since the window can mount or drop turns while
 * the position settles.
 */
async function pickVisibleWorkedAboveTail(page: Page, tailWindow = TAIL_WINDOW): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await page.evaluate(
      ({ marker, tailWindow }) => {
        const scroller = (window as any).__e2eFindScroller(marker) as HTMLElement | null
        if (!scroller) return "no-scroller"
        const viewport = scroller.getBoundingClientRect()
        const rows = Array.from(
          document.querySelectorAll('[data-testid^="turn-row-"]'),
        ) as HTMLElement[]
        const aboveTail = Math.max(0, rows.length - tailWindow)
        if (aboveTail === 0) return `no-window:${rows.length}rows`

        // The header nearest where we want it, not the oldest one: chasing the
        // oldest row scrolls the window out from under it every attempt.
        const desiredTop = viewport.top + Math.min(200, viewport.height / 3)
        let best: { header: HTMLElement; rect: DOMRect } | null = null
        let headers = 0
        for (let index = 0; index < aboveTail; index++) {
          const buttons = Array.from(
            rows[index].querySelectorAll('[role="button"]'),
          ) as HTMLElement[]
          for (const button of buttons) {
            if (!(button.textContent || "").trim().startsWith("Worked")) continue
            headers++
            const rect = button.getBoundingClientRect()
            if (!best || Math.abs(rect.top - desiredTop) < Math.abs(best.rect.top - desiredTop)) {
              best = { header: button, rect }
            }
          }
        }
        if (!best) return `no-header:${headers}headers/${aboveTail}rows`

        const delta = best.rect.top - desiredTop
        if (Math.abs(delta) <= 2) {
          document
            .querySelectorAll("[data-e2e-pick]")
            .forEach((node) => node.removeAttribute("data-e2e-pick"))
          best.header.setAttribute("data-e2e-pick", "1")
          return "picked"
        }
        // Bounded steps: a header mounted far above the viewport must be walked
        // into place, or the window mounts a whole page and the position jumps.
        const step = Math.max(-600, Math.min(600, delta))
        scroller.scrollTop += step
        return `scroll:${Math.round(delta)}`
      },
      { marker: TAIL_MARKER, tailWindow },
    )
    if (result === "picked") return result
    if (result.startsWith("no-")) return result
    await page.waitForTimeout(300)
  }
  return "gave-up"
}

/**
 * Height of the turn row that owns the picked header. Used to prove the click
 * actually opened the group — a header that stays put because nothing happened
 * would pass the position assertion for the wrong reason.
 */
async function pickedRowHeight(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const header = document.querySelector('[data-e2e-pick="1"]') as HTMLElement | null
    if (!header) return null
    const row = header.closest('[data-testid^="turn-row-"]') as HTMLElement | null
    return row ? row.getBoundingClientRect().height : null
  })
}

async function openLongChat(page: Page, turns = TURN_COUNT): Promise<LongChatState> {
  const state = await installLongChat(page, turns)
  await openTeamHome(page)
  const home = page
    .getByTestId("home-composer-input")
    .or(page.getByRole("textbox", { name: "Describe the agent you want to build" }))
  await home.click()
  await home.fill(`Build a long-transcript E2E project (${turns} turns)`)
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 60_000 })
  // The transcript paints the mocked history; the newest turn is the tail.
  await expect(page.getByText(TAIL_MARKER, { exact: false }).first()).toBeVisible({
    timeout: 90_000,
  })
  await settleAtBottom(page)
  return state
}

test.describe("a long chat scrolls like a short one", () => {
  test("120 turns: the wheel goes to the first turn and back, always in the direction it was turned", async ({
    page,
  }) => {
    test.setTimeout(300_000)
    await openLongChat(page)

    expect(
      await scrollTop(page),
      "the long chat opens scrolled to its newest turn",
    ).toBeGreaterThan(0)
    // Only a window of turns is mounted, as SHO-354 requires (opening the chat
    // can mount a page or two before it settles at the bottom).
    expect((await mountedRows(page)).length).toBeLessThanOrEqual(TAIL_WINDOW + 40)

    // Up through history.
    for (let attempt = 0; attempt < 60; attempt++) {
      const before = await scrollTop(page)
      if (before <= JUMP_TOLERANCE) break
      const anchor = await anchorRow(page)
      const mountedBefore = (await mountedRows(page)).length
      await wheel(page, -WHEEL_STEP, 1, 200)
      const after = await scrollTop(page)
      const mountedAfter = (await mountedRows(page)).length
      if (mountedAfter > mountedBefore && anchor) {
        // A page of history mounted above the reader. `scrollTop` legitimately
        // *increases* here — the correction keeps the same content on screen —
        // so the invariant is that the row under the reader moved by the wheel's
        // distance and no more. A second, unowned correction (the browser's
        // anchoring, or a gap counted twice) shows up as a much larger move.
        const top = await rowTop(page, anchor.id)
        if (top !== null) {
          expect(
            Math.abs(top - anchor.top - WHEEL_STEP),
            `an expansion moved the row under the reader ${top - anchor.top}px for a ${WHEEL_STEP}px wheel step`,
          ).toBeLessThanOrEqual(WHEEL_TOLERANCE)
        }
      } else {
        expect(after, "wheeling up moved the transcript down").toBeLessThanOrEqual(
          before + JUMP_TOLERANCE,
        )
      }
    }

    expect(await scrollTop(page), "the transcript never reached the first turn").toBeLessThanOrEqual(
      JUMP_TOLERANCE,
    )
    await expect(
      page.getByText(HEAD_MARKER, { exact: false }).first(),
      "the first turn is not on screen at the top of the history",
    ).toBeVisible()
    // Reaching the top expanded the window, but only as far as needed.
    expect((await mountedRows(page)).length).toBeGreaterThan(TAIL_WINDOW)

    // And back down.
    for (let attempt = 0; attempt < 80; attempt++) {
      const before = await scrollTop(page)
      await wheel(page, WHEEL_STEP, 1, 200)
      const after = await scrollTop(page)
      expect(after, "wheeling down moved the transcript up").toBeGreaterThanOrEqual(
        before - JUMP_TOLERANCE,
      )
      const metrics = await scrollMetrics(page)
      if (
        metrics &&
        after >= metrics.height - metrics.viewport - JUMP_TOLERANCE &&
        after === before
      ) {
        break
      }
    }

    // Back at the end, the window shrinks to the tail again (SHO-354).
    await expect
      .poll(async () => (await mountedRows(page)).length, {
        timeout: 15_000,
        message: "the window did not shrink back to the tail at the bottom",
      })
      .toBeLessThanOrEqual(TAIL_WINDOW + 1)
    await expect(page.getByText(TAIL_MARKER, { exact: false }).first()).toBeVisible()
  })

  test("a window expansion does not move the row the reader is looking at", async ({ page }) => {
    test.setTimeout(300_000)
    await openLongChat(page)

    let sawExpansion = false
    let worst = 0

    // Wheel up in small steps until one of them mounts a new page; measure the
    // row in the middle of the screen across that step. Scrolling alone must
    // move it by exactly the wheel's distance — a second, unowned correction
    // (the browser's scroll anchoring, or a correction that counts the row gaps
    // wrong) shows up as a larger or smaller move.
    for (let attempt = 0; attempt < 60 && !sawExpansion; attempt++) {
      const anchor = await anchorRow(page)
      if (!anchor) break
      const mountedBefore = await mountedRows(page)

      await wheel(page, -600, 1, 220)

      const mountedAfter = await mountedRows(page)
      const top = await rowTop(page, anchor.id)
      if (top === null) continue
      const moved = top - anchor.top

      // A page of history mounted: the window slides, so the count can stay the
      // same while the rows themselves change.
      const mountedNew = mountedAfter.some((id) => !mountedBefore.includes(id))
      if (mountedNew) {
        sawExpansion = true
        // One more couple of frames for the newly mounted turns to measure.
        await page.waitForTimeout(400)
        const settled = await rowTop(page, anchor.id)
        if (settled !== null) {
          worst = Math.abs(settled - anchor.top - 600)
          expect(
            worst,
            `the row under the reader moved ${settled - anchor.top}px for a 600px wheel step`,
          ).toBeLessThanOrEqual(JUMP_TOLERANCE + 6)
        }
        break
      }
      expect(
        Math.abs(moved - 600),
        `a plain wheel step moved the row ${moved}px`,
      ).toBeLessThanOrEqual(JUMP_TOLERANCE + 6)
    }

    expect(sawExpansion, "scrolling never mounted a new page of history").toBe(true)
  })

  test("a work group opens on the first click, in the tail turn and above the tail window", async ({
    page,
  }) => {
    test.setTimeout(300_000)
    await openLongChat(page)

    // --- in the tail turn ---
    const tailHeader = page.getByRole("button", { name: /Worked/ }).last()
    await expect(tailHeader).toBeVisible({ timeout: 20_000 })
    const before = (await tailHeader.boundingBox())!
    const topBefore = await scrollTop(page)

    await tailHeader.click()
    // The body is the expanded work log; a collapsed group renders none. Its
    // height animates for 500 ms, so measure once it has settled.
    await expect(page.locator('[data-testid="collapsible-plain-body"]').last()).toBeVisible({
      timeout: 10_000,
    })
    await page.waitForTimeout(700)

    const after = (await tailHeader.boundingBox())!
    const topAfter = await scrollTop(page)
    console.log(
      `[sho-359] tail group: headerY ${before.y.toFixed(1)} -> ${after.y.toFixed(1)}, ` +
        `scrollTop ${topBefore} -> ${topAfter}`,
    )
    expect(
      Math.abs(after.y - before.y),
      `the clicked header moved ${after.y - before.y}px when its group opened`,
    ).toBeLessThanOrEqual(JUMP_TOLERANCE)
    // At the bottom the container clamps against maxScroll, so a few px of
    // height-estimate correction is not a jump; the header staying put is the
    // requirement this asserts. Mid-transcript the tolerance stays tight.
    expect(
      Math.abs(topAfter - topBefore),
      "opening a work group scrolled the transcript",
    ).toBeLessThanOrEqual(BOTTOM_SCROLL_SLACK)

    // Collapsing it again puts the row back exactly where it was.
    await tailHeader.click()
    await page.waitForTimeout(700)
    const collapsed = (await tailHeader.boundingBox())!
    expect(Math.abs(collapsed.y - before.y)).toBeLessThanOrEqual(JUMP_TOLERANCE)

    // --- in a turn above the tail window ---
    // Wheel up until the window actually mounts a page of history: how far that
    // is depends on how tall the turns above happen to be, so a fixed number of
    // steps is a coin flip.
    let mountedAbove = 0
    for (let attempt = 0; attempt < 20; attempt++) {
      mountedAbove = (await mountedRows(page)).length
      if (mountedAbove > TAIL_WINDOW) break
      await wheel(page, -WHEEL_STEP, 1, 250)
    }
    expect(
      mountedAbove,
      "scrolling up never mounted a turn above the tail window",
    ).toBeGreaterThan(TAIL_WINDOW)

    // A group that is on screen and belongs to a turn older than the tail
    // window — clicking it must not move what the reader is looking at.
    let pick = "not-run"
    for (let attempt = 0; attempt < 30 && pick !== "picked"; attempt++) {
      pick = await pickVisibleWorkedAboveTail(page)
      if (pick !== "picked") await page.waitForTimeout(300)
    }
    console.log(`[sho-359] above-tail pick: ${pick}`)
    expect(pick, `no expanded-work header above the tail window could be picked (${pick})`).toBe("picked")
    const aboveHeader = page.locator('[data-e2e-pick="1"]')
    const aboveBefore = (await aboveHeader.boundingBox())!
    const aboveTop = await scrollTop(page)
    const rowsBefore = (await mountedRows(page)).length
    const rowHeightBefore = await pickedRowHeight(page)

    // Click at the header's own coordinates rather than `locator.click()`:
    // Playwright's click scrolls the element into view first, and that scroll
    // is exactly what this assertion measures (SHO-359).
    await page.mouse.click(
      aboveBefore.x + aboveBefore.width / 2,
      aboveBefore.y + aboveBefore.height / 2,
    )
    await expect(
      page.locator('[data-testid="collapsible-plain-body"]').first(),
    ).toBeVisible({ timeout: 10_000 })

    const samples: string[] = []
    for (const delay of [0, 150, 400, 700]) {
      if (delay) await page.waitForTimeout(delay)
      const box = await aboveHeader.boundingBox()
      samples.push(
        `+${delay}ms y=${box ? box.y.toFixed(1) : "?"} top=${await scrollTop(page)} rows=${(await mountedRows(page)).length}`,
      )
    }

    const aboveAfter = (await aboveHeader.boundingBox())!
    const rowHeightAfter = await pickedRowHeight(page)
    console.log(
      `[sho-359] above-tail group: headerY ${aboveBefore.y.toFixed(1)} -> ${aboveAfter.y.toFixed(1)}, ` +
        `scrollTop ${aboveTop} -> ${await scrollTop(page)}, rows ${rowsBefore} -> ${(await mountedRows(page)).length}, ` +
        `rowHeight ${rowHeightBefore} -> ${rowHeightAfter} | ${samples.join(" ; ")}`,
    )
    // The click must have opened the group, or the position assertion below
    // would pass because nothing happened at all.
    expect(rowHeightBefore, "the picked row had no height").not.toBeNull()
    expect(
      rowHeightAfter! - rowHeightBefore!,
      "clicking the work group did not open it",
    ).toBeGreaterThan(20)
    expect(
      Math.abs(aboveAfter.y - aboveBefore.y),
      `an expanded group above the tail window moved its header ${aboveAfter.y - aboveBefore.y}px`,
    ).toBeLessThanOrEqual(JUMP_TOLERANCE)
    expect(
      Math.abs((await scrollTop(page)) - aboveTop),
      "expanding a group above the tail window scrolled the transcript",
    ).toBeLessThanOrEqual(JUMP_TOLERANCE)
  })

  test("a chat of 30 turns or fewer is untouched", async ({ page }) => {
    test.setTimeout(240_000)
    await openLongChat(page, SHORT_TURN_COUNT)

    // Nothing is collapsed: every turn is mounted and there is no spacer.
    const rows = await mountedRows(page)
    expect(rows.length).toBeGreaterThanOrEqual(SHORT_TURN_COUNT)
    expect(rows.length).toBeLessThanOrEqual(SHORT_TURN_COUNT + 2)
    expect(await page.locator('[data-testid="turn-window-spacer"]').count()).toBe(0)

    // And it scrolls to the first turn like it always did.
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await scrollTop(page)) <= JUMP_TOLERANCE) break
      await wheel(page, -WHEEL_STEP, 1, 150)
    }
    expect(await scrollTop(page)).toBeLessThanOrEqual(JUMP_TOLERANCE)
    await expect(page.getByText(HEAD_MARKER, { exact: false }).first()).toBeVisible()
  })
})
