// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-602 — what a phone polls while an agent runs somewhere else.
 *
 * `active-chats` and `agent-tasks` were asked every 5 s for the whole length of
 * any turn in the workspace, on whatever screen the person was on: ~720
 * requests/hour/user with the radio awake. The fast cadence is now scoped to
 * the chat on screen (5 s), a turn elsewhere gets a 60 s safety net and its
 * edges off the realtime connection, and an idle screen asks every 30 s.
 *
 * This spec measures the requests a real page makes. The clock is faked, so a
 * five-minute window costs a second: the answers are fulfilled locally, so no
 * turn is really started, and nothing here depends on an agent replying.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test \
 *     --config e2e/local/playwright.config.ts sho-602-idle-poll-cadence --project chromium
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import { openTeamHome } from './helpers'
import { signIn } from './team-nav-seed'

test.setTimeout(240_000)

/** The one turn this spec reports: a chat of the person's that is not on screen. */
const RUNNING_CHAT = {
  chatSessionId: 'chat-elsewhere',
  turnId: 'turn-elsewhere',
  sessionName: 'Elsewhere',
  isPrimary: false,
  projectId: null,
  projectName: null,
  projectHidden: false,
  startedAt: new Date('2026-11-27T08:00:00.000Z').toISOString(),
}

interface Calls {
  activeChats: number
  agentTasks: number
}

/**
 * Answer both workspace-activity endpoints locally and count what was asked.
 * `running` is what `active-chats` reports for the whole window.
 */
async function countActivity(page: Page, running: boolean): Promise<Calls> {
  const calls: Calls = { activeChats: 0, agentTasks: 0 }
  await page.route('**/api/workspaces/*/active-chats', async (route: Route) => {
    calls.activeChats += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ chats: running ? [RUNNING_CHAT] : [] }),
    })
  })
  await page.route('**/api/agent-tasks*', async (route: Route) => {
    calls.agentTasks += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [] }),
    })
  })
  return calls
}

/** The five minutes the card's budgets are stated over. */
const WINDOW_MS = 5 * 60_000

test.describe('SHO-602 workspace activity polling', () => {
  test('nothing running: five minutes on Home costs one ask a minute per endpoint', async ({ page }) => {
    // Fake the clock before the app boots: the window below is five minutes of
    // timers, and the answers are the only thing that has to be real.
    await page.clock.install()
    await signIn(page)
    const calls = await countActivity(page, false)
    await openTeamHome(page)

    // Let the mount poll land before the window starts.
    await expect.poll(() => calls.activeChats, { timeout: 20_000 }).toBeGreaterThan(0)
    const from = { ...calls }

    await page.clock.fastForward(WINDOW_MS)
    await page.waitForTimeout(50)

    // AC3: <= 20 requests across the workspace endpoints in five minutes, and
    // nothing polled faster than 15 s (10 in 300 s is one a 30 s).
    expect(calls.activeChats - from.activeChats).toBeLessThanOrEqual(10)
    expect(calls.agentTasks - from.agentTasks).toBeLessThanOrEqual(10)
  })

  test('a turn running in a chat off screen: five minutes costs six asks, not sixty', async ({ page }) => {
    // Fake the clock before the app boots: the window below is five minutes of
    // timers, and the answers are the only thing that has to be real.
    await page.clock.install()
    await signIn(page)
    const calls = await countActivity(page, true)
    await openTeamHome(page)

    await expect.poll(() => calls.activeChats, { timeout: 20_000 }).toBeGreaterThan(0)
    const from = { ...calls }

    await page.clock.fastForward(WINDOW_MS)
    await page.waitForTimeout(50)

    // AC1: <= 6 on each endpoint (5 at a 60 s cadence), against ~60 before.
    expect(calls.activeChats - from.activeChats).toBeLessThanOrEqual(6)
    expect(calls.agentTasks - from.agentTasks).toBeLessThanOrEqual(6)
  })
})
