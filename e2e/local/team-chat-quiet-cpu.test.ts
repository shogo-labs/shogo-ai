// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-600 quiet-CPU gate: the phone bundle must stay quiet when nothing is
 * happening.
 *
 * Two symptoms of the same "the iOS build freezes and heats up my phone"
 * report, measured at a Pixel 7 viewport with the CPU throttled 4× — roughly
 * how the phone feels after a few minutes of heat:
 *
 *  - **Home, idle (30 s)** — the buddy asks for ≤ 5 frames a second, and CPU
 *    busy stays ≤ 10 % of the wall clock. Used to be 120 rAF/s and 19.7 %; the
 *    rAF bound is the real signal, CPU carries headroom for a loaded runner.
 *  - **a channel, scrolling (30 s)** — no mounted message row and no markdown
 *    block re-renders, and ≤ 2 000 fibres/s. This one is a guard, not a
 *    before/after: with mounts excluded the pre-SHO-600 list already read ~850
 *    fibres/s and 0 row re-renders, so what it protects is that a scroll step
 *    never re-renders a row that is already on screen (the ~9 000 fibres/s and
 *    ~15 commits/s that prompted the card counted first mounts through a
 *    virtualizer, and part C's `Intl` win is Hermes self-time this cannot see).
 *
 * The numbers come from CDP's `Performance.getMetrics` plus an init script that
 * counts frames and React work by the component that did it (a stand-in for the
 * DevTools hook, which the production bundle omits). Only fibres that already
 * had an `alternate` count as re-renders: a virtualized list mounting a row as
 * it scrolls in is the list working, not the regression this is for.
 *
 * Both tests assert the screen really is there before they measure. A session
 * that fell back to "Couldn't sign in to Shogo on this machine" draws nothing,
 * which also satisfies "≤ 3 % CPU" — an empty page is exactly how the first
 * version of this gate passed (QA round 1).
 *
 * CDP is Chromium-only, so this runs on the `pixel-7` project and skips on
 * WebKit. The per-delta budget is not here, because CI cannot stage a message
 * that is streaming right now; it is asserted deterministically in
 * apps/mobile/components/team-chat/__tests__/sho600-delta-renders.rtl.test.tsx.
 *
 * CI: .github/workflows/e2e-phone.yml (`E2E (phone: Pixel 7)`).
 * Locally:
 *   E2E_LOCAL_START_STACK=1 npx playwright test \
 *     --config e2e/local/playwright.config.ts --project=pixel-7 team-chat-quiet-cpu
 */
import { expect, test, type CDPSession, type ElementHandle, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { activateTeamWorkspace, api, signInByApi } from "./team-nav-seed"

/**
 * Budgets.
 *
 * The rAF bound is the machine-independent signal for this regression — the
 * buddy asked for 120 a second, and it now asks for ~3 — so it stays tight.
 * CPU-busy flaps with whatever else shares the runner: the same head reads
 * 0.9 % on an idle Mac and 5.6 % in CI, while the unfixed buddy read 17.9 %
 * there and 19.7 % on Planner's machine. 10 % separates those two worlds
 * without turning a busy runner into a red gate.
 */
const IDLE_CPU_BUSY_MAX = 10
const IDLE_RAF_PER_SECOND_MAX = 5
const SCROLL_FIBRES_PER_SECOND_MAX = 2_000

const IDLE_WINDOW_MS = 30_000
const SCROLL_STEPS = 300
const SCROLL_STEP_MS = 100
const SEEDED_MESSAGES = 60

/**
 * Counts frames and React work and files each one under the component that did
 * it. Installed before the app loads, so it sees the very first commit.
 */
const INIT_SCRIPT = `
(() => {
  const counts = { raf: 0, rafBySite: {}, commits: 0, renders: [], markdown: [] }
  window.__sho600 = counts

  const site = () => {
    const stack = new Error().stack || ''
    const line = stack.split('\\n').find((l) => l.includes('at ')) || ''
    return line.replace(/^\\s*at\\s*/, '').split(' (')[0].slice(0, 80)
  }

  const raf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (callback) => {
    counts.raf += 1
    const key = site()
    counts.rafBySite[key] = (counts.rafBySite[key] || 0) + 1
    return raf(callback)
  }

  // memo()/forwardRef() wrap the component in an object; its name is on the
  // inner function.
  const nameOf = (type) => {
    if (!type) return null
    if (typeof type === 'function') return type.displayName || type.name || null
    if (typeof type === 'object') {
      return type.displayName || nameOf(type.type) || nameOf(type.render) || null
    }
    return null
  }

  const hook = {
    renderers: new Map(),
    supportsFiber: true,
    inject(renderer) { hook.renderers.set(1, renderer); return 1 },
    onCommitFiberRoot(_id, root) {
      counts.commits += 1
      const walk = (fiber) => {
        if (!fiber) return
        // Performed work on a fiber that already had an alternate is a
        // re-render of a mounted component. Its first mount is not: a
        // virtualized list mounting a row as it scrolls in is the list
        // working, not the regression measured here.
        const reRendered = (fiber.flags & 1) === 1 && fiber.alternate != null
        if (reRendered) {
          const name = nameOf(fiber.type)
          if (name) {
            counts.renders.push(name)
            if (name === 'MarkdownText' || name === 'ChatMarkdown') {
              const props = fiber.memoizedProps || {}
              counts.markdown.push((props.message && props.message.id) || null)
            }
          }
        }
        walk(fiber.child)
        walk(fiber.sibling)
      }
      walk(root.current)
    },
    onCommitFiberUnmount() {},
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook
})();
`

type Counts = {
  raf: number
  rafBySite: Record<string, number>
  commits: number
  renders: string[]
  markdown: Array<string | null>
}

interface Seed {
  workspaceId: string
  channelId: string
  marker: string
}

async function readCounts(page: Page): Promise<Counts> {
  return page.evaluate(() => (window as unknown as { __sho600: Counts }).__sho600)
}

async function resetCounts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const counts = (window as unknown as { __sho600: Counts }).__sho600
    counts.raf = 0
    counts.rafBySite = {}
    counts.commits = 0
    counts.renders = []
    counts.markdown = []
  })
}

/** How much of the wall clock the main thread spent doing tasks, in percent. */
async function cpuBusyPercent(cdp: CDPSession, measure: () => Promise<void>): Promise<number> {
  await cdp.send("Performance.enable")
  const before = await cdp.send("Performance.getMetrics")
  const startedAt = Date.now()
  await measure()
  const after = await cdp.send("Performance.getMetrics")
  const read = (result: { metrics: Array<{ name: string; value: number }> }, name: string) =>
    result.metrics.find((metric) => metric.name === name)?.value ?? 0
  const busy = (read(after, "TaskDuration") - read(before, "TaskDuration")) * 1000
  const elapsed = Date.now() - startedAt
  return elapsed > 0 ? (busy / elapsed) * 100 : 0
}

async function throttle(cdp: CDPSession, rate = 4): Promise<void> {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate })
}

/**
 * Home, proven to be Home: the composer, the header buddy, and no sign-in
 * failure anywhere on the page. This is the companion Home at `/`, which is
 * where the animated header avatar lives — the team Home at `/home` has no
 * buddy, so measuring there would say nothing about the SHO-600 symptom.
 */
async function openHome(page: Page): Promise<void> {
  await page.goto("/")
  // The header buddy itself: its poke button only exists once the avatar's
  // canvas/WebView has mounted, which is the thing being measured.
  await expect(
    page.getByRole("button", { name: "Shogo workspace avatar. Press to poke." }).first(),
    "the header buddy never mounted — the readings below would be a blank screen",
  ).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole("textbox", { name: "Chat message input" }).first(), "Home has no composer").toBeVisible({
    timeout: 60_000,
  })
  await expect(
    page.getByText("Couldn't sign in to Shogo on this machine"),
    "the session fell back to the sign-in failure screen",
  ).toHaveCount(0)
}

/** The list's own scroll box, found by shape rather than position. */
async function findScroller(page: Page): Promise<ElementHandle<Element>> {
  const list = page.getByTestId("team-message-list").first()
  await expect(list, "the channel never painted its message list").toBeVisible({ timeout: 120_000 })
  const handle = await list.evaluateHandle((node) => {
    const isScrollable = (el: Element | null): el is HTMLElement => {
      if (!el) return false
      const style = getComputedStyle(el)
      return el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(style.overflowY || style.overflow)
    }
    const candidates: Element[] = [node, ...Array.from(node.querySelectorAll("*"))]
    for (let el = node.parentElement; el; el = el.parentElement) candidates.push(el)
    return candidates.find(isScrollable) ?? null
  })
  const scroller = handle.asElement()
  if (!scroller) throw new Error("the channel has no scrollable message list")
  return scroller as ElementHandle<Element>
}

/** A channel of our own with enough messages to scroll for 30 seconds. */
async function seedChannel(page: Page): Promise<Seed> {
  const suffix = Date.now().toString(36)
  const workspaces = await api(page, "GET", "/api/workspaces")
  const items = (workspaces.json?.items ?? workspaces.json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
  const workspaceId = items.find((item) => item.kind !== "personal")?.id
  if (!workspaceId) throw new Error(`local stack has no team workspace: ${JSON.stringify(workspaces.json)}`)

  const created = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, {
    name: `quiet-cpu-${suffix}`,
    kind: "public",
  })
  const channelId = created.json?.conversation?.id
  if (!channelId) throw new Error(`channel create failed: ${JSON.stringify(created.json)}`)

  const marker = `quiet-cpu ${suffix}`
  for (let i = 0; i < SEEDED_MESSAGES; i += 1) {
    await api(page, "POST", `/api/conversations/${channelId}/messages`, { text: `${marker} message ${i}` })
  }
  return { workspaceId, channelId, marker }
}

test.describe("SHO-600: the phone bundle stays quiet", () => {
  test.describe.configure({ mode: "serial" })

  let seed: Seed
  let seeder: Page

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(600_000)
    const context = await browser.newContext()
    seeder = await context.newPage()
    await signInByApi(seeder)
    seed = await seedChannel(seeder)
  })

  test.afterAll(async () => {
    // Deleting the channel takes its messages with it, so the stack the next
    // spec inherits holds nothing this one created.
    if (seeder) {
      if (seed) await seeder.request.delete(`${LOCAL_API_BASE}/api/conversations/${seed.channelId}`).catch(() => {})
      await seeder.context().close()
    }
  })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(INIT_SCRIPT)
    await signInByApi(page)
  })

  test("Home draws almost nothing while it sits idle", async ({ page, context, browserName }) => {
    test.skip(browserName !== "chromium", "the CPU/GPU profiler below needs CDP, which WebKit does not expose")
    test.setTimeout(300_000)

    await openHome(page)
    // The buddy's entrance is a real animation; let it settle before measuring.
    await page.waitForTimeout(5_000)

    const cdp = await context.newCDPSession(page)
    await throttle(cdp)
    await resetCounts(page)

    const busy = await cpuBusyPercent(cdp, () => page.waitForTimeout(IDLE_WINDOW_MS))
    const counts = await readCounts(page)
    const perSecond = counts.raf / (IDLE_WINDOW_MS / 1000)
    console.log(`[quiet-cpu] Home idle: ${busy.toFixed(1)}% CPU busy, ${perSecond.toFixed(1)} frames/s`)

    expect(busy, `Home idle CPU busy ${busy.toFixed(1)}%`).toBeLessThanOrEqual(IDLE_CPU_BUSY_MAX)
    expect(perSecond, `Home idle ${perSecond.toFixed(1)} frames/s`).toBeLessThanOrEqual(IDLE_RAF_PER_SECOND_MAX)
  })

  test("scrolling a channel does not re-render what is already on screen", async ({ page, context, browserName }) => {
    test.skip(browserName !== "chromium", "the CPU/GPU profiler below needs CDP, which WebKit does not expose")
    test.setTimeout(300_000)

    await activateTeamWorkspace(page, seed.workspaceId)
    await page.goto(`/c/${seed.channelId}`)
    await expect(
      page.getByText(`${seed.marker} message ${SEEDED_MESSAGES - 1}`),
      "the channel never painted its seeded messages",
    ).toBeVisible({ timeout: 120_000 })
    await page.waitForTimeout(5_000)

    const scroller = await findScroller(page)
    const cdp = await context.newCDPSession(page)
    await throttle(cdp)
    await resetCounts(page)

    // A step every ~100 ms, which is what `scrollEventThrottle` reports on
    // device, walking the transcript for the length of the idle window.
    for (let step = 0; step < SCROLL_STEPS; step += 1) {
      await scroller.evaluate((element) => {
        element.scrollTop += 120
      })
      await page.waitForTimeout(SCROLL_STEP_MS)
    }

    const counts = await readCounts(page)
    const elapsed = (SCROLL_STEPS * SCROLL_STEP_MS) / 1000
    const rowRenders = counts.renders.filter((name) => name === "MessageRowImpl").length
    const fibresPerSecond = counts.renders.length / elapsed
    console.log(
      `[quiet-cpu] channel scroll: ${rowRenders} row re-renders, ${counts.markdown.length} markdown re-renders, ` +
        `${fibresPerSecond.toFixed(0)} fibres/s over ${elapsed.toFixed(0)}s`,
    )

    expect(rowRenders, `${rowRenders} mounted message rows re-rendered while scrolling`).toBe(0)
    expect(counts.markdown.length, `${counts.markdown.length} markdown blocks re-rendered while scrolling`).toBe(0)
    expect(
      fibresPerSecond,
      `${fibresPerSecond.toFixed(0)} fibres re-rendered per second while scrolling`,
    ).toBeLessThanOrEqual(SCROLL_FIBRES_PER_SECOND_MAX)
  })
})
