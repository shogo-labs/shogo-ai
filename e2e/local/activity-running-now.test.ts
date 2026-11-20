// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-425 — what a "Running now" row says about the run behind it, end to end.
 *
 * Russell's screenshot: six rows in #shogo-dev, every one titled
 * `#shogo-dev: @agent …`, every second line `Shogo Dev N · An agent is re…`,
 * the same robot icon, no card, no time, no stop — so two runs of one agent
 * were indistinguishable and the list was unreadable.
 *
 * The rows are the `active-chats` poll, so this spec answers that poll itself
 * and asserts what the screen does with the answer:
 *   1. AC3/AC6 — a card thread reads as `SHO-421 · <title>`, a channel reply as
 *      its message with the `@agent` wake tag gone, and a legacy stored name
 *      cleaned rather than printed.
 *   2. AC4 — two runs of one agent are adjacent, newest first, and each row
 *      says who · where · how long.
 *   3. AC5 — stop is one click that does not open the chat behind the row, and
 *      a viewer (`canStop: false`) is offered no stop at all.
 *   4. AC3 — the companion Activity screen names its runs the same way and no
 *      longer prints "An agent is responding…".
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test \
 *     --config e2e/local/playwright.config.ts activity-running-now --project chromium
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import { openTeamHome } from './helpers'
import { signIn } from './team-nav-seed'

test.setTimeout(240_000)

/** One row of the `/active-chats` answer, as the server returns it. */
type Run = {
  chatSessionId: string
  turnId: string
  sessionName: string
  startedAt: string
  agentName?: string
  card?: { key: string; title: string } | null
  canStop?: boolean
  messageId?: string | null
  projectId?: string | null
  projectName?: string | null
  conversationId?: string | null
  conversationName?: string | null
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

/**
 * Three runs: two of one agent (a card thread and a channel reply whose stored
 * name is still the old `#channel: @agent …` shape) plus a second agent, so the
 * spec can prove both "same agent sits together" and "each row is its own run".
 */
function runs(canStop = true): Run[] {
  return [
    {
      chatSessionId: 'chat-card',
      turnId: 'turn-card',
      sessionName: '#shogo-dev: fix SHO-421 on your branch',
      startedAt: minutesAgo(5),
      agentName: 'Shogo Dev 3',
      card: { key: 'SHO-421', title: 'Boot standalone without PROJECT_ID' },
      canStop,
      messageId: 'msg-card',
      projectId: 'project-dev-3',
      projectName: 'Shogo Dev 3',
      conversationId: 'conv-shogo-dev',
      conversationName: 'shogo-dev',
    },
    {
      chatSessionId: 'chat-channel',
      turnId: 'turn-channel',
      sessionName: '#shogo-dev: @agent fix SHO-421 on your branch',
      startedAt: minutesAgo(2),
      agentName: 'Shogo Dev 3',
      canStop,
      messageId: 'msg-channel',
      projectId: 'project-dev-3',
      projectName: 'Shogo Dev 3',
      conversationId: 'conv-shogo-dev',
      conversationName: 'shogo-dev',
    },
    {
      chatSessionId: 'chat-review',
      turnId: 'turn-review',
      sessionName: '#shogo-dev: @agent review PR 2061',
      startedAt: minutesAgo(1),
      agentName: 'Shogo QA',
      canStop,
      messageId: 'msg-review',
      projectId: 'project-qa',
      projectName: 'Shogo QA',
      conversationId: 'conv-shogo-qa',
      conversationName: 'shogo-qa',
    },
  ]
}

/** Answer the activity poll with the rows this spec decides are running. */
async function mockActiveChats(page: Page, chats: Run[]): Promise<void> {
  await page.route('**/api/workspaces/*/active-chats**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ chats }),
    })
  })
}

/**
 * The stop controls in DOM order. Each carries `Stop <title>` as its label, so
 * reading them proves the row order, the title and that every row has a stop
 * in one pass.
 */
async function stopLabels(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="stop-"]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label') ?? ''))
}

/**
 * Make the team workspace active. A stack that only has the seeded personal
 * workspace cannot show the team Activity screen at all, so the two team cases
 * skip rather than fail on data the spec does not own.
 */
async function enterTeamWorkspace(page: Page): Promise<boolean> {
  await signIn(page)
  return openTeamHome(page).then(
    () => true,
    () => false,
  )
}

test.describe('Running now rows (local mode)', () => {
  test('a card run, a channel run and a second agent each read as themselves', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const team = await enterTeamWorkspace(page)
    test.skip(!team, 'local test environment has no team workspace')

    const chats = runs()
    await mockActiveChats(page, chats)
    /** Any `…/stop` the row fires; a stop must never navigate instead. */
    const stops: string[] = []
    await page.route('**/stop**', async (route: Route) => {
      stops.push(route.request().url())
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })

    await page.goto('/activity')
    await expect(page.getByText('Running now', { exact: false }).first()).toBeVisible({ timeout: 30_000 })

    // AC4 + AC3: one agent's runs together, newest first, card first line for a
    // card thread and the cleaned command for a channel reply.
    await expect
      .poll(async () => stopLabels(page), { timeout: 30_000 })
      .toEqual([
        'Stop fix SHO-421 on your branch',
        'Stop SHO-421 · Boot standalone without PROJECT_ID',
        'Stop review PR 2061',
      ])

    // The stored `#channel: @agent …` string must not survive anywhere on the row.
    await expect(page.getByText('#shogo-dev: @agent')).toHaveCount(0)
    await expect(page.getByText(/@agent/)).toHaveCount(0)

    // AC3 second line: who · where · how long, one per run.
    await expect(page.getByText(/Shogo Dev 3 · #shogo-dev · \d+m/)).toHaveCount(2)
    await expect(page.getByText(/Shogo QA · #shogo-qa · \d+m/)).toHaveCount(1)

    // AC5: stop is one click, and it does not open the chat behind the row.
    await page.locator('[data-testid="stop-chat-channel"]').click()
    await expect.poll(() => stops.length, { timeout: 15_000 }).toBe(1)
    await expect(page).toHaveURL(/\/activity/)
  })

  test('a viewer is offered no stop at all', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const team = await enterTeamWorkspace(page)
    test.skip(!team, 'local test environment has no team workspace')

    await mockActiveChats(page, runs(false))
    await page.goto('/activity')
    await expect(page.getByText('Running now', { exact: false }).first()).toBeVisible({ timeout: 30_000 })

    // The runs are still listed — only the control is gone.
    await expect(page.getByText('SHO-421 · Boot standalone without PROJECT_ID')).toBeVisible()
    await expect(page.locator('[data-testid^="stop-"]')).toHaveCount(0)
  })

  test('the companion Activity screen names its runs and drops the filler line', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signIn(page)

    // Local mode opens the personal workspace, whose Activity screen reads
    // `GET /workspaces/:id/activity` instead of the `active-chats` poll.
    const startedAt = minutesAgo(3)
    await page.route('**/api/workspaces/*/activity**', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          activity: [{
            type: 'chat_turn',
            id: 'chat-personal:turn-personal',
            chatSessionId: 'chat-personal',
            turnId: 'turn-personal',
            sessionName: '#shogo-dev: @agent fix SHO-421 on your branch',
            startedAt,
            createdAt: startedAt,
            agentName: 'Shogo Dev 3',
            projectId: 'project-dev-3',
            projectName: 'Shogo Dev 3',
            projectHidden: false,
            conversationId: 'conv-shogo-dev',
            conversationName: 'shogo-dev',
            messageId: 'msg-personal',
            canStop: true,
          }],
        }),
      })
    })

    await page.goto('/activity')
    await expect(page.getByText('Happening now')).toBeVisible({ timeout: 30_000 })

    await expect(page.getByText('fix SHO-421 on your branch')).toBeVisible()
    await expect(page.getByText(/Shogo Dev 3 · #shogo-dev · \d+m/)).toBeVisible()
    await expect(page.getByText(/An agent is responding/)).toHaveCount(0)
    await expect(page.locator('[data-testid="stop-chat-personal"]')).toBeVisible()
  })
})

test.describe('Running now peek card (SHO-466)', () => {
  test('hovering a row shows the peek card with trigger text', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const team = await enterTeamWorkspace(page)
    test.skip(!team, 'local test environment has no team workspace')

    const chats = runs()
    await mockActiveChats(page, chats)
    // Mock the peek endpoint
    const peekCalled: string[] = []
    await page.route('**/api/workspaces/*/active-chats/*/peek**', async (route) => {
      peekCalled.push(route.request().url())
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chatSessionId: 'chat-card',
          turnId: 'turn-card',
          title: 'SHO-466 hover test run',
          agentName: 'Shogo Dev 3',
          startedAt: minutesAgo(5),
          where: { kind: 'public', conversationId: 'conv-shogo-dev', conversationName: 'shogo-dev', threadRootId: 'root-1' },
          card: { key: 'SHO-466', title: 'Hover peek', column: 'In Development' },
          trigger: { authorName: 'Russell', authorType: 'user', text: 'SHO-466 is yours: implement the peek hover', createdAt: minutesAgo(5) },
          reply: { text: 'Working on it, checking the service layer…', updatedAt: minutesAgo(1) },
          hidden: false,
        }),
      })
    })

    await page.goto('/activity')
    await expect(page.getByText('Running now', { exact: false }).first()).toBeVisible({ timeout: 30_000 })

    // No peek call before hover
    expect(peekCalled).toHaveLength(0)

    // Hover the first running row
    const firstRow = page.locator('[data-testid^="running-avatar-"]').first()
    await firstRow.hover()

    // After ~400 ms the card should appear
    await expect(page.locator('[data-testid="run-peek-card"]')).toBeVisible({ timeout: 5_000 })

    // Card content
    await expect(page.locator('[data-testid="run-peek-card"]')).toContainText('SHO-466 hover test run')
    await expect(page.locator('[data-testid="run-peek-card"]')).toContainText('Russell')
    await expect(page.locator('[data-testid="run-peek-card"]')).toContainText('SHO-466 is yours: implement the peek hover')
    await expect(page.locator('[data-testid="run-peek-card"]')).toContainText('Working on it')

    // Peek was called
    expect(peekCalled.length).toBeGreaterThan(0)
  })

  test('private row shows "Private conversation" and no message text', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const team = await enterTeamWorkspace(page)
    test.skip(!team, 'local test environment has no team workspace')

    const chats = runs()
    await mockActiveChats(page, chats)
    await page.route('**/api/workspaces/*/active-chats/*/peek**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chatSessionId: 'chat-card',
          turnId: 'turn-card',
          title: 'Private run',
          agentName: 'Shogo Dev 3',
          startedAt: minutesAgo(5),
          where: { kind: 'private', conversationId: 'conv-private', conversationName: null, threadRootId: null },
          card: null,
          trigger: null,
          reply: null,
          hidden: true,
        }),
      })
    })

    await page.goto('/activity')
    await expect(page.getByText('Running now', { exact: false }).first()).toBeVisible({ timeout: 30_000 })

    const firstRow = page.locator('[data-testid^="running-avatar-"]').first()
    await firstRow.hover()
    await expect(page.locator('[data-testid="run-peek-card"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('[data-testid="run-peek-card"]')).toContainText('Private conversation')
    await expect(page.locator('[data-testid="run-peek-card"]')).not.toContainText('Woke by')
  })

  test('no peek request fires without hover', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const team = await enterTeamWorkspace(page)
    test.skip(!team, 'local test environment has no team workspace')

    await mockActiveChats(page, runs())
    const peeked: string[] = []
    await page.route('**/api/workspaces/*/active-chats/*/peek**', async (route) => {
      peeked.push(route.request().url())
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })

    await page.goto('/activity')
    await expect(page.getByText('Running now', { exact: false }).first()).toBeVisible({ timeout: 30_000 })
    // Wait a full poll cycle — no peek should have fired
    await page.waitForTimeout(6_000)
    expect(peeked).toHaveLength(0)
  })
})
