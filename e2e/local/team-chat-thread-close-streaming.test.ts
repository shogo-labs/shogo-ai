// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A thread opened from a *running* agent (SHO-243) arrives as
 * `/c/<id>?thread=<root>&msg=<runningReplyId>` — see `openActiveChat` in
 * `lib/open-active-chat.ts`. The X closed the pane and it came back one frame
 * later, because `closeThread` cleared `thread` and left `msg`: the channel then
 * had a highlight it cannot show (the reply is a *thread* reply), and
 * `TimelinePane`'s seek fallback answered that by re-opening the thread.
 *
 * So these tests assert the pane stays closed — sampled every animation frame
 * for 2.5s after the press, which is the window the one-frame reappearance
 * shows through — and that a channel left pointing at a thread reply does not
 * open the thread on its own.
 *
 *   npx playwright test --config e2e/local/playwright.config.ts \
 *     team-chat-thread-close-streaming --project chromium --retries 0
 *
 * (add `E2E_LOCAL_START_STACK=1` to have Playwright boot the local stack.)
 */
import { mkdirSync, writeFileSync } from "fs"
import { dirname } from "path"
import { expect, test, type Page } from "@playwright/test"
import { activateTeamWorkspace, api, cleanupTeamNav, seedTeamNav, signIn, SCRIPT_PATH, type TeamNavSeed } from "./team-nav-seed"

/** The scripted agent's stream speed is global, so a test that needs the run open gets a slow one. */
function writeScript(seed: TeamNavSeed, delayMs: number, extra: Record<string, unknown[]>) {
  mkdirSync(dirname(SCRIPT_PATH), { recursive: true })
  writeFileSync(
    SCRIPT_PATH,
    JSON.stringify({
      delayMs,
      agents: {
        [seed.dmAgent]: [{ reply: seed.dmReply }],
        ...extra,
      },
    }),
  )
}

const closeButton = (page: Page) => page.getByLabel("Close thread")

/**
 * Records every frame in which the URL has `?thread=` again *after* it first
 * dropped it — the reappearance Russell saw, which a single assertion at the
 * moment of the press cannot catch.
 */
async function watchForReopen(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    w.__reopens = [] as Array<{ ms: number; url: string }>
    const start = performance.now()
    let closed = false
    const sample = () => {
      const hasThread = location.search.includes("thread=")
      if (!hasThread) closed = true
      else if (closed) w.__reopens.push({ ms: Math.round(performance.now() - start), url: location.href })
      if (performance.now() - start < 2_500) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
}

test.describe("Team chat thread pane: closing a thread opened from a running agent", () => {
  test.describe.configure({ mode: "serial" })

  let seed: TeamNavSeed
  let seeder: Page
  let rootId: string
  let settledReplyId: string

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext()
    seeder = await context.newPage()
    await signIn(seeder)
    seed = await seedTeamNav(seeder)

    const rootText = `close-thread root ${seed.suffix}`
    await api(seeder, "POST", `/api/conversations/${seed.channelId}/messages`, { text: rootText })
    const list = await api(seeder, "GET", `/api/conversations/${seed.channelId}/messages`)
    rootId = (list.json?.messages ?? []).find((m: any) => !m.threadRootId && m.text === rootText)?.id
    expect(rootId, "seeded thread root message").toBeTruthy()

    // A thread reply that is already settled, for the "channel left pointing at a
    // thread reply" case: it needs no agent run, so no shard can outlive it.
    const secondRootText = `close-thread second root ${seed.suffix}`
    await api(seeder, "POST", `/api/conversations/${seed.channelId}/messages`, { text: secondRootText })
    const withSecond = await api(seeder, "GET", `/api/conversations/${seed.channelId}/messages`)
    const secondRootId = (withSecond.json?.messages ?? []).find(
      (m: any) => !m.threadRootId && m.text === secondRootText,
    )?.id
    expect(secondRootId, "seeded second thread root").toBeTruthy()
    const settledText = `settled thread reply ${seed.suffix}`
    await api(seeder, "POST", `/api/conversations/${seed.channelId}/messages`, {
      text: settledText,
      threadRootId: secondRootId,
    })
    const secondThread = await api(seeder, "GET", `/api/conversations/${seed.channelId}/messages?threadRootId=${secondRootId}`)
    settledReplyId = (secondThread.json?.messages ?? []).find((m: any) => m.text === settledText)?.id
    expect(settledReplyId, "seeded settled thread reply").toBeTruthy()
  })

  test.afterAll(async () => {
    writeScript(seed, 100, {})
    await cleanupTeamNav(seeder, seed)
    await seeder.context().close()
  })

  test.beforeEach(async ({ page }) => {
    await signIn(page)
    await activateTeamWorkspace(page, seed.workspaceId)
    await page.setViewportSize({ width: 1280, height: 720 })
  })

  /**
   * Starts a reply in the thread that is still streaming when the test presses
   * the X, and returns that reply's id — the `msg` of a running-agent link.
   */
  async function startStreamingReply(): Promise<string> {
    const reply = `Reading the build logs now: three flakes, all from the same checkout timeout (${seed.suffix}).`
    // The scripted runner emits two chunks with `delayMs` before each, so a run
    // lasts about 2 × delayMs. It has to outlive a slow shard's page load, or the
    // run is done by the time the thread renders and the dock row never appears.
    writeScript(seed, 60_000, { [seed.idleAgent]: [{ reply }] })
    const mention = `<@a:p:${seed.idleAgentProjectId}> read the build logs`
    await api(seeder, "POST", `/api/conversations/${seed.channelId}/messages`, { text: mention, threadRootId: rootId })

    let replyId: string | undefined
    await expect
      .poll(
        async () => {
          const thread = await api(seeder, "GET", `/api/conversations/${seed.channelId}/messages?threadRootId=${rootId}`)
          const running = (thread.json?.messages ?? []).find(
            (m: any) => m.authorAgent?.name === seed.idleAgent && m.agentStatus === "running",
          )
          replyId = running?.id
          return Boolean(running)
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toBe(true)
    return replyId!
  }

  /** The run is the point of the link: if it ended, the press is no longer the case under test. */
  async function expectStillRunning(replyId: string) {
    await expect
      .poll(
        async () => {
          const thread = await api(seeder, "GET", `/api/conversations/${seed.channelId}/messages?threadRootId=${rootId}`)
          return (thread.json?.messages ?? []).find((m: any) => m.id === replyId)?.agentStatus
        },
        { message: "the scripted run ended before the press", timeout: 5_000, intervals: [250] },
      )
      .toBe("running")
  }

  test("the X closes it and the pane stays closed", async ({ page }) => {
    test.setTimeout(180_000)
    const replyId = await startStreamingReply()

    // Exactly the link a running agent's "running now" card opens.
    await page.goto(`/c/${seed.channelId}?thread=${rootId}&msg=${replyId}`)
    await expect(closeButton(page)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByLabel(`Jump to ${seed.idleAgent}'s reply`)).toBeVisible({ timeout: 30_000 })

    await expectStillRunning(replyId)
    await watchForReopen(page)
    await closeButton(page).click()

    await page.waitForTimeout(2_600)
    const reopens = await page.evaluate(() => (window as any).__reopens)
    expect(reopens, `thread= came back at ${JSON.stringify(reopens)}`).toEqual([])
    await expect(page).not.toHaveURL(/thread=/)
    await expect(closeButton(page)).toHaveCount(0)
  })

  test("a card-history link opens the thread, and its X keeps it closed", async ({ page }) => {
    test.setTimeout(180_000)

    // A card-history link points at a thread reply with no `thread` (`CardPane.tsx:517`).
    // The channel cannot show a thread reply, so the seek fallback opens its thread.
    await page.goto(`/c/${seed.channelId}?msg=${settledReplyId}`)
    await expect(closeButton(page)).toBeVisible({ timeout: 60_000 })
    await expect(page).toHaveURL(/thread=/)

    await watchForReopen(page)
    await closeButton(page).click()

    await page.waitForTimeout(2_600)
    const reopens = await page.evaluate(() => (window as any).__reopens)
    expect(reopens, `thread= came back at ${JSON.stringify(reopens)}`).toEqual([])
    await expect(page).not.toHaveURL(/thread=/)
    await expect(closeButton(page)).toHaveCount(0)
  })
})
