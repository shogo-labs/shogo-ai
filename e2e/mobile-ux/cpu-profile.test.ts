// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-600 CPU gate: the phone bundle must stay quiet when nothing is happening.
 *
 * What this asserts, at iPhone 15 Pro size with the CPU throttled 4×:
 *
 *  - **Home, idle (30 s)** — CPU busy ≤ 3 % and the buddy asks for ≤ 5 frames a
 *    second. It used to burn 19.7 % and 120 rAF/s drawing a header avatar that
 *    nothing was changing.
 *  - **#shogo-dev, scrolling (30 s)** — no message row and no markdown block
 *    re-renders, and fibres re-rendered per second stay under 2 000. It used to
 *    be ~9 000 fibres/s and ~15 commits/s.
 *  - **#shogo-dev, one agent streaming** — with `E2E_STREAM_MESSAGE_ID` set to a
 *    message that is running right now, each `agent.delta` frame costs ≤ 1
 *    commit, 0 `ChatInput`/`Composer` renders, and markdown re-renders only for
 *    that row.
 *
 * The profile comes from the CDP sampling profiler and `Performance.getMetrics`,
 * plus an init script that counts frames and React work by the component that
 * did it (a stand-in for the DevTools hook, which the production bundle omits).
 *
 * Required env:
 *   E2E_TARGET_URL        — the running app (default http://localhost:8081)
 *   E2E_WORKSPACE_ID      — a team workspace the signed-in session can read
 *   E2E_CHANNEL_ID        — a channel with at least 60 messages to scroll
 *   E2E_STREAM_MESSAGE_ID — optional: a message that is streaming right now,
 *                           for the per-delta budget
 *
 * Run:
 *   E2E_WORKSPACE_ID=… E2E_CHANNEL_ID=… \
 *     npx playwright test --config e2e/mobile-ux/playwright.config.ts cpu-profile
 */

import { expect, test, type CDPSession, type Page } from '@playwright/test'

const workspaceId = process.env.E2E_WORKSPACE_ID
const channelId = process.env.E2E_CHANNEL_ID
const streamMessageId = process.env.E2E_STREAM_MESSAGE_ID

/** Budgets. Each one is a row of the SHO-600 table. */
const IDLE_CPU_BUSY_MAX = 3
const IDLE_RAF_PER_SECOND_MAX = 5
const SCROLL_FIBRES_PER_SECOND_MAX = 2_000
const DELTA_COMMITS_MAX = 1

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
  // Keep the app's socket so the streaming test can replay a delta frame.
  const RealWebSocket = window.WebSocket
  if (RealWebSocket) {
    window.WebSocket = new Proxy(RealWebSocket, {
      construct(target, args) {
        const socket = new target(...args)
        window.__sho600Socket = socket
        return socket
      },
    })
  }

  const raf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (callback) => {
    counts.raf += 1
    const key = site()
    counts.rafBySite[key] = (counts.rafBySite[key] || 0) + 1
    return raf(callback)
  }

  // A minimal DevTools hook: commit counting plus a walk for the fibres that
  // actually re-rendered, tagged with their message id where they have one.
  const hook = {
    renderers: new Map(),
    supportsFiber: true,
    inject(renderer) { hook.renderers.set(1, renderer); return 1 },
    onCommitFiberRoot(_id, root) {
      counts.commits += 1
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
      const walk = (fiber) => {
        if (!fiber) return
        const performed = (fiber.flags & 1) === 1
        if (performed) {
          const name = nameOf(fiber.type)
          const props = fiber.memoizedProps || {}
          const messageId = props.message && props.message.id
          if (name) {
            counts.renders.push(name)
            if (name === 'MarkdownText' || name === 'ChatMarkdownImpl') {
              counts.markdown.push(messageId || null)
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
  await cdp.send('Performance.enable')
  const before = await cdp.send('Performance.getMetrics')
  const startedAt = Date.now()
  await measure()
  const after = await cdp.send('Performance.getMetrics')
  const read = (result: { metrics: Array<{ name: string; value: number }> }, name: string) =>
    result.metrics.find((metric) => metric.name === name)?.value ?? 0
  const busy = (read(after, 'TaskDuration') - read(before, 'TaskDuration')) * 1000
  const elapsed = Date.now() - startedAt
  return elapsed > 0 ? (busy / elapsed) * 100 : 0
}

async function throttle(cdp: CDPSession, rate = 4): Promise<void> {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate })
}

/** Four times slower, as the phone feels after a few minutes of heat. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(INIT_SCRIPT)
})

test.describe('SHO-600: the phone bundle stays quiet', () => {
  test('Home draws almost nothing while it sits idle', async ({ page, context }) => {
    test.skip(!workspaceId, 'Set E2E_WORKSPACE_ID to a team workspace the session can read')
    const cdp = await context.newCDPSession(page)
    await throttle(cdp)

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // Let the buddy settle (its entrance is a real animation).
    await page.waitForTimeout(5_000)

    await resetCounts(page)
    const busy = await cpuBusyPercent(cdp, () => page.waitForTimeout(30_000))
    const counts = await readCounts(page)

    expect(busy, `Home idle CPU busy ${busy.toFixed(1)}%`).toBeLessThanOrEqual(IDLE_CPU_BUSY_MAX)
    const perSecond = counts.raf / 30
    expect(perSecond, `Home idle ${perSecond.toFixed(1)} frames/s`).toBeLessThanOrEqual(
      IDLE_RAF_PER_SECOND_MAX,
    )
  })

  test('scrolling a channel re-renders no message', async ({ page, context }) => {
    test.skip(!workspaceId || !channelId, 'Set E2E_WORKSPACE_ID and E2E_CHANNEL_ID')
    const cdp = await context.newCDPSession(page)
    await throttle(cdp)

    await page.goto(`/c/${channelId}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(5_000)

    await resetCounts(page)
    const scroller = page.getByTestId('team-message-list').first()
    await scroller.evaluate(async (element) => {
      element.scrollTop = 0
    })
    // 30 s of real scrolling: a step every ~100 ms, which is what
    // `scrollEventThrottle` reports on device.
    for (let step = 0; step < 300; step += 1) {
      await scroller.evaluate((element) => {
        element.scrollTop += 120
      })
      await page.waitForTimeout(100)
    }
    const counts = await readCounts(page)

    // Rows whose props did not change must not render, and neither must their
    // markdown.
    const rowRenders = counts.renders.filter((name) => name === 'MessageRowImpl').length
    expect(rowRenders, `${rowRenders} message rows re-rendered while scrolling`).toBe(0)
    expect(counts.markdown.length, `${counts.markdown.length} markdown blocks re-rendered while scrolling`).toBe(0)

    const fibresPerSecond = counts.renders.length / 30
    expect(
      fibresPerSecond,
      `${fibresPerSecond.toFixed(0)} fibres re-rendered per second while scrolling`,
    ).toBeLessThanOrEqual(SCROLL_FIBRES_PER_SECOND_MAX)
  })

  test('one agent delta costs one commit and leaves the composer alone', async ({ page, context }) => {
    test.skip(
      !workspaceId || !channelId || !streamMessageId,
      'Set E2E_STREAM_MESSAGE_ID to a message that is streaming right now',
    )
    const cdp = await context.newCDPSession(page)
    await throttle(cdp)

    await page.goto(`/c/${channelId}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(5_000)

    // The app's own socket: replay a delta frame as the server would send it.
    await resetCounts(page)
    const frames = 10
    for (let i = 0; i < frames; i += 1) {
      await page.evaluate(async (messageId) => {
        const socket = (window as unknown as { __sho600Socket?: WebSocket }).__sho600Socket
        if (!socket) throw new Error('no socket captured')
        const frame = { type: 'agent.delta', messageId, text: `chunk ${Math.random()}`, seq: 0 }
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }, streamMessageId)
    }
    const counts = await readCounts(page)

    expect(counts.commits / frames, `${counts.commits} commits for ${frames} deltas`).toBeLessThanOrEqual(
      DELTA_COMMITS_MAX,
    )
    const composerRenders = counts.renders.filter(
      (name) => name === 'ChatInputImpl' || name === 'ComposerImpl' || name === 'Composer',
    ).length
    expect(composerRenders, `${composerRenders} composer renders for ${frames} deltas`).toBe(0)
    const otherRows = counts.markdown.filter((id) => id && id !== streamMessageId).length
    expect(otherRows, `${otherRows} other rows' markdown re-rendered`).toBe(0)
  })
})
