// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test, type Page } from "./fixtures"
import {
  AGENT_STOP_SELECTOR,
  assertChatHealthy,
  homeComposerInput,
  makeTestUser,
  signUpAndOnboard,
  type TestUser,
} from "./helpers"

/**
 * A running workspace chat survives a full page load (SHO-300).
 *
 * SHO-287 fixed the in-app case (My work → Back, a new chat → Back): the chat
 * comes back with Stop and keeps streaming. Every *full* load was still broken,
 * on staging and production alike — a second tab, F5, or Back after one showed
 * an empty "Start Chatting" chat, while the first tab had the whole turn. The
 * root redirect at `/` dropped `?chatSessionId=`, so the landing minted a fresh
 * empty chat and replaced the URL with it.
 *
 * A mocked transcript cannot see that: every session answers identically, so
 * the empty chat the landing opened looked like the chat in the URL (that is
 * how the old F5 test passed with the bug intact). Each case here runs a REAL
 * turn — a shell loop printing 40 numbered lines, one a second — against real
 * saved history, and asserts the URL keeps its id, no sessions are created, the
 * chat shows the turn in progress (Stop), and it keeps streaming to the last
 * line.
 *
 * Run: E2E_TARGET_URL=... npx playwright test --config e2e/playwright.config.ts chat-reload-live-turn
 */

const LINES = 40
/** Start of the prompt, so the reopened chat can be checked for the ask itself. */
const PROMPT_SNIPPET = "Use the exec tool to run exactly this command"

async function ensureAuthenticated(page: Page, user: TestUser): Promise<void> {
  await page.goto("/home")
  const home = page.getByText("What are we building", { exact: false }).first()
  const signUpTab = page.getByRole("tab", { name: "Sign Up" })
  await Promise.race([
    home.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
    signUpTab.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
  ])
  if (await home.isVisible().catch(() => false)) return
  await signUpAndOnboard(page, user)
}

/** Distinct output lines the transcript is showing for this run. */
async function streamedLines(page: Page, run: string): Promise<number> {
  return page.evaluate((marker) => {
    const counts = new Set<string>()
    for (const match of document.body.innerText.matchAll(new RegExp(marker, "g"))) {
      counts.add(match[0])
    }
    return counts.size
  }, `RELOAD_LINE_\\d{2}_${run}`)
}

interface LiveChat {
  sessionId: string
  run: string
  /** POST /workspaces/:id/sessions requests seen after the first load. */
  sessionPosts: () => number
  /** Chat-console warnings collected while the turn ran. */
  consoleLines: () => string[]
}

/**
 * Count `POST …/sessions` on one page. A full load must open the chat in the
 * URL, so any of these after the first load means the landing minted a new
 * empty chat instead. It has to be attached per page: a second tab is a
 * different `Page`, and a counter on tab 1 can never see its requests.
 */
function countSessionPosts(page: Page): () => number {
  let posts = 0
  page.on("request", (req) => {
    if (req.method() !== "POST") return
    if (/\/api\/(workspaces|projects)\/[^/]+\/sessions(\?|$)/.test(new URL(req.url()).pathname)) {
      posts++
    }
  })
  return () => posts
}

/**
 * Sign in, land on `/`, send a real ~45 s turn and wait until its first line is
 * on screen (the turn is running and the chat has a session in the URL).
 */
async function startLiveTurn(page: Page, testName: string): Promise<LiveChat> {
  const run = `${testName}${Date.now().toString(36)}`.replace(/[^A-Za-z0-9]/g, "")
  await ensureAuthenticated(page, makeTestUser("ReloadLive"))
  await page.goto("/")

  const composer = homeComposerInput(page).filter({ visible: true }).first()
  await composer.waitFor({ state: "visible", timeout: 60_000 })

  // The landing chat puts its session in the URL (SHO-287); that URL is what a
  // second tab / F5 / Back is given.
  await expect
    .poll(() => new URL(page.url()).searchParams.get("chatSessionId"), {
      timeout: 60_000,
      message: "the landing chat puts its session in the URL",
    })
    .toBeTruthy()
  const sessionId = new URL(page.url()).searchParams.get("chatSessionId")!

  const consoleLines: string[] = []
  // Attached before the send: the landing's own `POST …/sessions` happens
  // earlier, when the chat first opens (§ above), so what this sees is a
  // *second* session being created.
  const postsAfterSend = countSessionPosts(page)
  page.on("console", (msg) => {
    const text = msg.text()
    if (/\[AutoResume\]|\[ChatPanel\]/.test(text)) consoleLines.push(text.slice(0, 400))
  })

  await composer.click()
  await composer.fill(
    `${PROMPT_SNIPPET} and wait for it to finish (it takes about ${LINES} seconds; ` +
      `if exec returns a run_id, keep calling exec_wait until it completes):\n\n` +
      `for i in $(seq -w 1 ${LINES}); do echo "RELOAD_LINE_\${i}_${run}"; sleep 1; done\n\n` +
      `Then reply with only the lines the command printed. Do not change any files.`,
  )
  await page.waitForTimeout(300)
  await page.keyboard.press("Enter")

  await page.waitForSelector(AGENT_STOP_SELECTOR, { state: "attached", timeout: 60_000 })
  await expect
    .poll(() => streamedLines(page, run), {
      timeout: 120_000,
      message: "the turn printed its first line",
    })
    .toBeGreaterThanOrEqual(1)

  return { sessionId, run, sessionPosts: postsAfterSend, consoleLines: () => consoleLines }
}

/**
 * The chat this window is looking at is the running one: the id is still in the
 * URL, the prompt is on screen, Stop is offered, and the reply keeps growing to
 * the last line.
 */
async function expectRunningChatReopened(page: Page, chat: LiveChat): Promise<void> {
  expect(new URL(page.url()).searchParams.get("chatSessionId")).toBe(chat.sessionId)

  await expect(page.getByText(PROMPT_SNIPPET, { exact: false }).first()).toBeVisible({
    timeout: 60_000,
  })
  await expect(
    page.locator(AGENT_STOP_SELECTOR).first(),
    "the reopened chat shows the turn as running",
  ).toBeAttached({ timeout: 20_000 })

  const before = await streamedLines(page, chat.run)
  await expect
    .poll(() => streamedLines(page, chat.run), {
      timeout: 60_000,
      message: "the reopened chat keeps streaming",
    })
    .toBeGreaterThan(before)

  await expect
    .poll(() => streamedLines(page, chat.run), {
      timeout: 240_000,
      message: `all ${LINES} lines arrived in the reopened chat`,
    })
    .toBe(LINES)
  await assertChatHealthy(page)
}

/** A normal turn must not reconnect, nor miss the reply the server saved. */
function expectQuietTurn(chat: LiveChat): void {
  const lines = chat.consoleLines()
  expect(
    lines.filter((line) => /\[AutoResume\].*(reconnecting fromSeq|stream errored mid-turn)/.test(line)),
    "the turn's stream was interrupted and reconnected",
  ).toEqual([])
  expect(
    lines.filter((line) => /Assistant message not yet persisted/.test(line)),
    "the panel could not find the reply the server saved",
  ).toEqual([])
}

test.describe("a running workspace chat across a full page load", () => {
  test("a second tab opens the running chat, not an empty one", async ({ page }) => {
    test.setTimeout(600_000)
    const chat = await startLiveTurn(page, "tab")

    const other = await page.context().newPage()
    // Counted on the new tab's own page — a counter on tab 1 cannot see it.
    const otherSessionPosts = countSessionPosts(other)
    await other.goto(`/?chatSessionId=${chat.sessionId}`)
    await expectRunningChatReopened(other, chat)

    // A full load must open the chat in the URL, not mint a new empty one.
    expect(otherSessionPosts(), "a second tab created a chat session").toBe(0)
    expect(chat.sessionPosts(), "the first tab created a chat session").toBe(0)
    expectQuietTurn(chat)
    await other.close()
  })

  test("F5 mid-turn reopens the running chat", async ({ page }) => {
    test.setTimeout(600_000)
    const chat = await startLiveTurn(page, "reload")

    await page.reload()
    await expectRunningChatReopened(page, chat)
    expect(chat.sessionPosts(), "a reload created a chat session").toBe(0)
    expectQuietTurn(chat)
  })

  test("Back after a full page load reopens the running chat", async ({ page }) => {
    test.setTimeout(600_000)
    const chat = await startLiveTurn(page, "back")

    await page.goto("/home")
    await page.goBack()
    await expectRunningChatReopened(page, chat)
    expect(chat.sessionPosts(), "going back created a chat session").toBe(0)
    expectQuietTurn(chat)
  })
})
