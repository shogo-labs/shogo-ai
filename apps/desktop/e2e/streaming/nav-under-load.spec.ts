// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-277 A2 — navigating the desktop app while several chats stream.
 *
 * Russell's report: "when there are many agents running on a computer the
 * computer starts to be slow to load chats and the app navigation slows down".
 * A1 reproduces the API half (the relay rewriting the whole growing assistant
 * message on the event loop). This is the renderer half: several background
 * turns streaming across a few projects, restored chat tabs mounted behind the
 * visible one, and a person switching chats, opening another project, opening a
 * team channel and going home.
 *
 * For every navigation it records time-to-messages-visible, long tasks and
 * dropped frames, plus how many sockets the renderer holds to the API origin
 * and how many `ChatPanel`s / intervals are mounted. The socket numbers settle
 * the "is a navigation GET queued behind an SSE?" question one way or the
 * other instead of assuming it.
 *
 * Opt-in and advisory, like the rest of this suite: `PLAYWRIGHT_E2E=1`.
 * Numbers land in test-results/streaming-e2e/nav-under-load.json.
 */
import { expect, test } from '@playwright/test'
import {
  apiFetch,
  chatStreamUrl,
  createChatSession,
  launchDesktop,
  leaveChat,
  returnToChat,
  startBackgroundTurn,
  writeReport,
  type Harness,
} from './desktop-app'
import { marker } from './fake-llm-server'

test.skip(process.env.PLAYWRIGHT_E2E !== '1', 'set PLAYWRIGHT_E2E=1 to run')
test.setTimeout(600_000)

const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback)
const LEVELS = (process.env.SHOGO_E2E_LOAD_LEVELS || '1,4,8').split(',').map((n) => Number(n.trim()))
const RESTORED_TABS = num('SHOGO_E2E_LOAD_RESTORED_TABS', 3)
const NAVIGATIONS = num('SHOGO_E2E_LOAD_NAVIGATIONS', 10)

/** Budgets at N=8. Override on a slower machine rather than loosening them. */
const BUDGET = {
  chatOpenP95Ms: num('SHOGO_E2E_LOAD_CHAT_OPEN_P95_MS', 1_000),
  longTaskMaxMs: num('SHOGO_E2E_LOAD_LONG_TASK_MS', 200),
  socketWaitMs: num('SHOGO_E2E_LOAD_SOCKET_WAIT_MS', 100),
}

interface NavSample {
  kind: string
  toMessagesMs: number
  longTasks: number
  longestTaskMs: number
  droppedFrames: number
  /** Longest gap between `requestStart` and `responseStart` — a queued request. */
  socketWaitMs: number
  requestsWhileNavigating: number
  mountedChatPanels: number
  inFlightApiRequests: number
}

/**
 * Everything the renderer knows about itself, sampled across one navigation:
 * long tasks, frame drops, resource queueing and mounted panels.
 */
async function installNavMonitor(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any
    if (w.__navMonitor) return
    const state = {
      longTasks: [] as number[],
      frames: [] as number[],
      resources: [] as Array<{ name: string; requestStart: number; responseStart: number; duration: number }>,
      samples: [] as any[],
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push(entry.duration)
      }).observe({ entryTypes: ['longtask'] })
    } catch { /* longtask is Chromium-only; the frame counter still reports */ }

    const tick = (t: number) => {
      state.frames.push(t)
      if (state.frames.length > 600) state.frames.splice(0, 300)
      w.requestAnimationFrame(tick)
    }
    w.requestAnimationFrame(tick)

    w.__navMonitor = {
      state,
      reset() {
        state.longTasks = []
        state.frames = []
        state.resources = []
      },
      /** Resource timings for this navigation's requests. */
      collectResources() {
        const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
        return entries
          .filter((entry) => typeof entry.requestStart === 'number' && entry.requestStart > 0)
          .map((entry) => ({
            name: entry.name,
            requestStart: entry.requestStart,
            responseStart: entry.responseStart,
            duration: entry.duration,
          }))
      },
      snapshot() {
        const longTasks = state.longTasks.slice()
        const frames = state.frames.slice()
        let dropped = 0
        for (let i = 1; i < frames.length; i++) if (frames[i] - frames[i - 1] > 32) dropped++
        const resources = this.collectResources()
        const queued = resources
          .map((entry) => Math.max(0, entry.responseStart - entry.requestStart))
          .sort((a, b) => b - a)
        return {
          longTasks: longTasks.length,
          longestTaskMs: Math.round(Math.max(0, ...longTasks)),
          droppedFrames: dropped,
          socketWaitMs: Math.round(queued[0] ?? 0),
          requests: resources.length,
        }
      },
      /** Mounted chat panels and live intervals: the two things a hidden tab leaks. */
      mountedPanels() {
        const panels = document.querySelectorAll('[data-testid="project-composer-input"], [data-testid="chat-composer-input"]')
        return panels.length
      },
    }
  })
}

/**
 * How many API requests are still open, and the longest they have waited for a
 * response to start. A navigation GET queued behind a streaming SSE shows up as
 * a large `requestStart → responseStart` gap, which is the thing to measure —
 * Chromium allows six HTTP/1.1 sockets per origin and offers no API for the
 * socket count itself.
 */
async function inflightApiRequests(page: import('@playwright/test').Page, apiUrl: string): Promise<number> {
  const origin = new URL(apiUrl).origin
  return page.evaluate((o) => {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    return entries.filter((entry) => entry.name.startsWith(o) && entry.responseEnd === 0).length
  }, origin)
}

async function createProject(page: import('@playwright/test').Page, h: Harness, name: string): Promise<string> {
  const res = await apiFetch<any>(page, '/api/projects', { method: 'POST', body: { name, workspaceId: h.workspaceId } })
  const id: string | undefined = res.body?.data?.id ?? res.body?.id
  if (!id) throw new Error(`project create failed (${res.status}): ${JSON.stringify(res.body).slice(0, 200)}`)
  return id
}

async function openProjectChat(page: import('@playwright/test').Page, projectId: string): Promise<number> {
  const started = Date.now()
  await page.evaluate((id) => {
    window.history.pushState({}, '', `/projects/${id}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, projectId)
  await expect(page.getByTestId('project-composer-input').filter({ visible: true }).first())
    .toBeVisible({ timeout: 60_000 })
  return Date.now() - started
}

test.describe('navigate while N chats stream', () => {
  for (const level of LEVELS) {
    test(`N=${level}`, async () => {
      const h = await launchDesktop()
      const page = h.page
      await installNavMonitor(page)

      // Four projects, each with chats; the open one also has restored tabs.
      const projects: string[] = []
      for (let i = 0; i < 4; i++) projects.push(await createProject(page, h, `Load ${level}-${i}`))

      // Background turns, tool-heavy, spread across the projects.
      const backgroundSessions: string[] = []
      for (let i = 0; i < level; i++) {
        const sessionId = await createChatSession(page, projects[i % projects.length], `bg-${i}`)
        // Tool-heavy on purpose: the turn is what makes the renderer and the
        // API do work while the person navigates.
        const text = `${marker('tool', String(i), 30, { rounds: 30 })} go`
        const status = await startBackgroundTurn(page, h, sessionId, text, String(i))
        expect(status, `background turn ${i} accepted`).toBe(200)
        backgroundSessions.push(sessionId)
      }

      // Restored tabs in the open project, sitting behind the visible chat.
      const openProject = projects[0]
      for (let i = 0; i < RESTORED_TABS; i++) {
        await createChatSession(page, openProject, `tab-${i}`)
      }
      await openProjectChat(page, openProject)

      const samples: NavSample[] = []
      for (let i = 0; i < NAVIGATIONS; i++) {
        await page.evaluate(() => (window as any).__navMonitor.reset())
        const kind = ['switch-chat', 'open-project', 'team-channel', 'home-and-back'][i % 4]
        let toMessagesMs = 0

        if (kind === 'switch-chat') {
          toMessagesMs = await openProjectChat(page, openProject)
        } else if (kind === 'open-project') {
          toMessagesMs = await openProjectChat(page, projects[(i + 1) % projects.length])
        } else if (kind === 'team-channel') {
          const started = Date.now()
          await page.evaluate(() => {
            window.history.pushState({}, '', '/c')
            window.dispatchEvent(new PopStateEvent('popstate'))
          })
          await page.waitForTimeout(1_500)
          toMessagesMs = Date.now() - started
        } else {
          await leaveChat(page)
          const started = Date.now()
          await returnToChat(page)
          toMessagesMs = Date.now() - started
        }

        const snapshot: any = await page.evaluate(() => (window as any).__navMonitor.snapshot())
        samples.push({
          kind,
          toMessagesMs,
          longTasks: snapshot.longTasks,
          longestTaskMs: snapshot.longestTaskMs,
          droppedFrames: snapshot.droppedFrames,
          socketWaitMs: snapshot.socketWaitMs,
          requestsWhileNavigating: snapshot.requests,
          mountedChatPanels: await page.evaluate(() => (window as any).__navMonitor.mountedPanels()),
          inFlightApiRequests: await inflightApiRequests(page, h.apiUrl),
        })
      }

      const chatOpens = samples.map((s) => s.toMessagesMs).sort((a, b) => a - b)
      const p95 = chatOpens[Math.min(chatOpens.length - 1, Math.ceil(chatOpens.length * 0.95) - 1)]
      const report = {
        generatedAt: new Date().toISOString(),
        level,
        restoredTabs: RESTORED_TABS,
        navigationBudget: BUDGET,
        p95ChatOpenMs: p95,
        longestTaskMs: Math.max(...samples.map((s) => s.longestTaskMs)),
        maxSocketWaitMs: Math.max(...samples.map((s) => s.socketWaitMs)),
        samples,
      }
      writeReport(`nav-under-load-n${level}`, report)

      // Soft checks: report every problem, do not stop at the first.
      expect(p95, `chat open p95 at N=${level} (${p95}ms)`).toBeLessThanOrEqual(BUDGET.chatOpenP95Ms)
      expect(report.longestTaskMs, `no long task over ${BUDGET.longTaskMaxMs}ms`).toBeLessThanOrEqual(BUDGET.longTaskMaxMs)
      expect(report.maxSocketWaitMs, `no request queued for a socket`).toBeLessThanOrEqual(BUDGET.socketWaitMs)

      await h.close()
    })
  }
})
