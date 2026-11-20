// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A wheel over plain reply **text** in team chat must move the timeline.
 *
 * `team-chat-table-scroll.test.ts` (SHO-162) drives a real wheel over a table
 * cell, which is the one content type SHO-365 was written for. Nothing ever
 * wheeled over an ordinary paragraph in team chat, which is the surface Russell
 * actually writes in — so this spec asks the plain-text question on both team
 * surfaces, and records *why* a gesture failed rather than only that it did.
 *
 * Team chat is not project chat: its timeline is an inverted `FlatList`, so
 * RN-web attaches `invertedWheelEventHandler`, which reads `deltaY`, measures
 * scrollability on `ev.target` (the `<p>` under the pointer) and always calls
 * `preventDefault`. `lib/nested-wheel-passthrough.ts` sits in the capture phase
 * above it. Neither exists in project chat's plain `ScrollView`.
 *
 *   npx playwright test --config e2e/local/playwright.config.ts \
 *     team-chat-wheel-over-text --project chromium --retries 0
 *
 * (add `E2E_LOCAL_START_STACK=1` to have Playwright boot the local stack.)
 */
import { expect, test, type Page } from "@playwright/test"
import { api, signIn, teamWorkspaceId } from "./team-nav-seed"
import { writeActiveWorkspaceSelection } from "./helpers"

let seeder: Page
let workspaceId: string
let channelId: string
let threadRootId: string
let suffix: string
let probe: string

/** Replies in the thread, so the pane has somewhere to scroll. */
const REPLIES = 26

/**
 * Top-level messages in the channel. Twelve short rows fit inside a 720px
 * viewport with room to spare, so the timeline had no scroll range at all and
 * the wheel had nothing to move — each row carries paragraph height as well.
 */
const TIMELINE_MESSAGES = 30

interface Ancestor {
  tag: string
  overflowY: string
  range: number
}

interface Sample {
  x: number
  y: number
  hit: string | null
  /** The hit element is the probe's own element or a descendant of it. */
  onText: boolean
}

interface ProbeReport {
  tag: string
  width: number
  height: number
  samples: Sample[]
  /** Scrolling ancestors between the probe and the document, innermost first. */
  ancestors: Ancestor[]
  /**
   * The nearest vertical scroller the browser would move, with the two facts
   * that decide which way a wheel should carry it: RN-web inverts a chat list
   * with `transform: scaleY(-1)`, so in an inverted list `deltaY > 0` (wheel
   * toward the user) *decreases* `scrollTop` — the opposite of a plain one.
   */
  scroller: {
    tag: string
    scrollTop: number
    range: number
    transform: string
    flexDirection: string
    inverted: boolean
  } | null
}

/**
 * Everything needed to say why a wheel over this text did or did not move the
 * timeline: what is actually painted at points inside the paragraph, which
 * ancestors scroll, and which one the browser would take.
 */
const probeReport = (page: Page, text: string) =>
  page.evaluate((needle): ProbeReport | { error: string } => {
    const desc = (el: Element | null) =>
      el
        ? `${el.tagName.toLowerCase()}${
            el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/)[0] : ""
          }`
        : ""

    // The deepest element carrying the probe in its own text — never <html>,
    // whose textContent contains the whole document.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node: Node | null = null
    while ((node = walker.nextNode())) {
      if ((node.textContent ?? "").includes(needle)) break
      node = null
    }
    const element = node?.parentElement ?? null
    if (!element) return { error: `probe not found: ${needle}` }

    element.scrollIntoView({ block: "center" })
    const rect = element.getBoundingClientRect()

    const samples: Sample[] = []
    for (let ty = 0.2; ty <= 0.81; ty += 0.2) {
      for (let tx = 0.2; tx <= 0.81; tx += 0.2) {
        const x = rect.left + rect.width * tx
        const y = rect.top + rect.height * ty
        if (x < 4 || y < 4 || x > window.innerWidth - 4 || y > window.innerHeight - 4) continue
        const hit = document.elementFromPoint(x, y)
        samples.push({
          x: Math.round(x),
          y: Math.round(y),
          hit: desc(hit),
          onText: !!hit && (hit === element || element.contains(hit)),
        })
      }
    }

    const ancestors: Ancestor[] = []
    let scroller: ProbeReport["scroller"] = null
    let current: HTMLElement | null = element as HTMLElement
    while (current) {
      const style = getComputedStyle(current)
      const range = current.scrollHeight - current.clientHeight
      if (style.overflowY !== "visible" || range > 0) {
        ancestors.push({ tag: desc(current) ?? "", overflowY: style.overflowY, range })
      }
      if (!scroller && (style.overflowY === "auto" || style.overflowY === "scroll") && range > 1) {
        // `scaleY(-1)` (matrix d < 0) is how RN-web flips a chat list: the
        // newest message sits at scrollTop 0, so a wheel down lowers scrollTop.
        const flipped = /matrix\(([^)]+)\)/.exec(style.transform)?.[1].split(",").map(Number)[3] === -1
        scroller = {
          tag: desc(current) ?? "",
          scrollTop: current.scrollTop,
          range,
          transform: style.transform,
          flexDirection: style.flexDirection,
          inverted: flipped || style.flexDirection === "column-reverse",
        }
      }
      current = current.parentElement
    }

    return {
      tag: desc(element) ?? "",
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      samples,
      ancestors,
      scroller,
    }
  }, text)

/**
 * Log every wheel event the document sees, in the capture phase, and re-read
 * `defaultPrevented` after dispatch: a listener that swallows the gesture (as
 * RN-web's inverted handler does) is invisible from `scrollTop` alone.
 */
const installWheelLog = (page: Page) =>
  page.evaluate(() => {
    ;(window as any).__wheelLog = []
    document.addEventListener(
      "wheel",
      (event) => {
        const entry: any = {
          target: (event.target as Element | null)?.tagName ?? null,
          dy: event.deltaY,
          dx: event.deltaX,
          preventedAtCapture: event.defaultPrevented,
        }
        ;(window as any).__wheelLog.push(entry)
        // The interesting value is the one after every listener has run.
        setTimeout(() => {
          entry.prevented = event.defaultPrevented
        }, 0)
      },
      { capture: true, passive: true },
    )
  })

const drainWheelLog = (page: Page) =>
  page.evaluate(() => {
    const log = (window as any).__wheelLog ?? []
    ;(window as any).__wheelLog = []
    return log
  })

/**
 * Scroll metrics of the timeline that owns the probe's paragraph.
 *
 * Resolves the probe the same way `pointOverText` does — the deepest text node
 * carrying it — so the element measured and the element wheeled over can never
 * disagree (a `getByText(probe).first()` locator can match a different node than
 * the DOM walk does, which would compare two different panes).
 */
const probeTimeline = (page: Page, text: string) =>
  page.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node: Node | null = null
    while ((node = walker.nextNode())) {
      if ((node.textContent ?? "").includes(needle)) break
      node = null
    }
    const element = node?.parentElement ?? null
    if (!element) return null
    let current: HTMLElement | null = element
    while (current) {
      const style = getComputedStyle(current)
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        current.scrollHeight > current.clientHeight + 1
      ) {
        return {
          scrollTop: current.scrollTop,
          scrollHeight: current.scrollHeight,
          clientHeight: current.clientHeight,
        }
      }
      current = current.parentElement
    }
    return null
  }, text)

/** A viewport point actually painted over the probe's own text. */
async function pointOverText(page: Page, text: string): Promise<{ x: number; y: number }> {
  const point = await page.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node: Node | null = null
    while ((node = walker.nextNode())) {
      if ((node.textContent ?? "").includes(needle)) break
      node = null
    }
    const element = node?.parentElement ?? null
    if (!element) return null
    element.scrollIntoView({ block: "center" })
    const rect = element.getBoundingClientRect()
    for (let ty = 0.2; ty <= 0.81; ty += 0.2) {
      for (let tx = 0.2; tx <= 0.81; tx += 0.2) {
        const x = rect.left + rect.width * tx
        const y = rect.top + rect.height * ty
        if (x < 4 || y < 4 || x > window.innerWidth - 4 || y > window.innerHeight - 4) continue
        const hit = document.elementFromPoint(x, y)
        if (hit && (hit === element || element.contains(hit))) return { x, y }
      }
    }
    return null
  }, text)

  if (!point) throw new Error(`no painted point over the probe text: ${text}`)
  return point
}

/**
 * Wheel over the probe and report before / after / +500 ms, the browser's
 * defaultPrevented, and the timeline's own metrics.
 */
async function wheelOverText(page: Page, text: string, deltaY: number, label: string) {
  const metrics = await probeTimeline(page, text)
  if (!metrics) throw new Error(`${label}: no scrolling ancestor for the probe`)

  const point = await pointOverText(page, text)
  await page.mouse.move(point.x, point.y)
  await drainWheelLog(page)

  const before = metrics.scrollTop
  await page.mouse.wheel(0, deltaY)
  await page.waitForTimeout(500)
  const after = (await probeTimeline(page, text))!.scrollTop
  await page.waitForTimeout(500)
  const settled = (await probeTimeline(page, text))!.scrollTop
  const wheelLog = await drainWheelLog(page)

  console.log(
    `[${label}] dy=${deltaY} point=(${Math.round(point.x)},${Math.round(point.y)})`,
    JSON.stringify({ before, after, settled, moved: after - before, drift: settled - after, wheelLog }),
  )
  return { before, after, settled, wheelLog: wheelLog as any[] }
}

/**
 * A wheel of `deltaY` must carry the timeline at least `min` pixels *the way
 * that wheel points*. Which way that is depends on inversion: a plain scroller
 * raises `scrollTop` for `deltaY > 0`, an inverted chat list lowers it. Reading
 * the sign off the DOM keeps the assertion honest on both — and a wrong sign is
 * itself a bug (the wheel moving the list backwards), so a bare `Math.abs`
 * would hide it.
 */
function expectWheelMoved(
  label: string,
  sample: { before: number; after: number; settled: number },
  deltaY: number,
  inverted: boolean,
  min = 40,
) {
  const expected = Math.sign(deltaY) * (inverted ? -1 : 1)
  const moved = (sample.after - sample.before) * expected
  console.log(
    `[${label}] inverted=${inverted} moved=${sample.after - sample.before} ` +
      `in-wheel-direction=${moved} drift=${sample.settled - sample.after}`,
  )
  expect(moved, `${label}: a wheel of ${deltaY} over reply text must move the timeline`).toBeGreaterThan(min)
  expect(
    Math.abs(sample.settled - sample.after),
    `${label}: the timeline must stay where the wheel put it (no snap-back after 500 ms)`,
  ).toBeLessThanOrEqual(2)
}

test.describe("a wheel over plain reply text moves the team-chat timeline", () => {
  test.describe.configure({ mode: "serial" })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    const context = await browser.newContext()
    seeder = await context.newPage()
    await signIn(seeder)
    suffix = Date.now().toString(36)
    probe = `textprobe${suffix}`
    workspaceId = await teamWorkspaceId(seeder)

    const created = await api(seeder, "POST", `/api/workspaces/${workspaceId}/conversations`, {
      name: `wheel-text-${suffix}`,
      kind: "public",
    })
    channelId = created.json?.conversation?.id
    expect(channelId, `channel create: ${JSON.stringify(created.json)}`).toBeTruthy()

    const rootText = `thread root ${suffix}`
    await api(seeder, "POST", `/api/conversations/${channelId}/messages`, { text: rootText })
    const listed = await api(seeder, "GET", `/api/conversations/${channelId}/messages`)
    threadRootId = (listed.json?.messages ?? []).find((m: any) => !m.threadRootId && m.text === rootText)?.id
    expect(threadRootId, "seeded thread root message").toBeTruthy()

    // Plain paragraphs only: no table, no code block, nothing that scrolls on
    // its own. Any failure here is the timeline itself.
    for (let i = 1; i <= REPLIES; i += 1) {
      const text =
        i === Math.floor(REPLIES / 2)
          ? `${probe} this reply is ordinary prose.\n\n${Array.from({ length: 12 }, (_, line) => `Filler line ${line} of the probe reply ${suffix}.`).join("\n\n")}`
          : `reply ${i} of ${REPLIES} in the plain-text thread ${suffix}.\n\n${Array.from({ length: 6 }, (_, line) => `Body line ${line} of reply ${i}.`).join("\n\n")}`
      await api(seeder, "POST", `/api/conversations/${channelId}/messages`, { text, threadRootId })
    }
    await api(seeder, "POST", `/api/conversations/${channelId}/messages`, {
      text: `latest-${suffix}\n\n${Array.from({ length: 8 }, (_, line) => `Closing line ${line}.`).join("\n\n")}`,
      threadRootId,
    })
    // A thread-free message so the channel timeline is taller than its pane.
    for (let i = 0; i < TIMELINE_MESSAGES; i += 1) {
      const text =
        i === Math.floor(TIMELINE_MESSAGES / 2)
          ? `channel-${probe} top-level prose for the timeline.\n\n${Array.from({ length: 10 }, (_, line) => `Timeline filler ${line} of the probe message ${suffix}.`).join("\n\n")}`
          : `channel message ${i} of ${TIMELINE_MESSAGES} for ${suffix}.\n\n${Array.from({ length: 6 }, (_, line) => `Body line ${line} of channel message ${i}.`).join("\n\n")}`
      await api(seeder, "POST", `/api/conversations/${channelId}/messages`, { text })
    }
  })

  test.afterAll(async () => {
    if (channelId) await seeder?.request.delete(`${apiPath(`/api/conversations/${channelId}`)}`).catch(() => {})
    await seeder?.context().close()
  })

  test.beforeEach(async ({ page }) => {
    await signIn(page)
    await page.addInitScript(writeActiveWorkspaceSelection, [workspaceId, "team"] as const)
    await page.setViewportSize({ width: 1280, height: 720 })
  })

  test("thread side pane: a wheel over reply text scrolls it", async ({ page }) => {
    await page.goto(`/c/${channelId}?thread=${threadRootId}`)
    await expect(page.getByText(probe, { exact: false })).toBeVisible({ timeout: 60_000 })

    await installWheelLog(page)
    const report = await probeReport(page, probe)
    console.log("THREAD PROBE", JSON.stringify(report, null, 1))
    const inverted = !!report.scroller?.inverted

    const up = await wheelOverText(page, probe, -120, "thread-up")
    expectWheelMoved("thread-up", up, -120, inverted)

    const down = await wheelOverText(page, probe, 900, "thread-down")
    expectWheelMoved("thread-down", down, 900, inverted)
  })

  test("channel timeline: a wheel over reply text scrolls it", async ({ page }) => {
    await page.goto(`/c/${channelId}`)
    const timelineProbe = `channel-${probe}`
    await expect(page.getByText(timelineProbe, { exact: false })).toBeVisible({ timeout: 60_000 })

    await installWheelLog(page)
    const report = await probeReport(page, timelineProbe)
    console.log("TIMELINE PROBE", JSON.stringify(report, null, 1))
    const inverted = !!report.scroller?.inverted

    const up = await wheelOverText(page, timelineProbe, -120, "timeline-up")
    expectWheelMoved("timeline-up", up, -120, inverted)

    const down = await wheelOverText(page, timelineProbe, 900, "timeline-down")
    expectWheelMoved("timeline-down", down, 900, inverted)
  })
})

/** `api()` prefixes LOCAL_API_BASE; `page.request.delete` wants a full URL. */
function apiPath(path: string): string {
  return `${process.env.E2E_API_URL || "http://localhost:8002"}${path}`
}
