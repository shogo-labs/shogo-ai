// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The thread pane's X closes the thread while an agent is still replying
 * (SHO-243).
 *
 * The press is taken from the pointer gesture, not only from RN-web's
 * `onPress`: the browser drops the synthetic `click` when the button's DOM node
 * is replaced between mousedown and mouseup, and a reply streaming into the
 * pane re-renders the header on every delta. So the last two tests press the
 * button *without* a click, which is exactly the case `onPress` alone loses.
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

/**
 * The scripted agent's stream speed is global, so a test that has to stay open
 * while the pane is closed gets a slow one — and the seed's own script is put
 * back in `finally`.
 */
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

const closeButton = (page: Page) => page.getByRole("button", { name: "Close thread" })

/**
 * A press with no `click` after it: pointerdown on the button, pointerup on the
 * document — the gesture a browser leaves behind when it decides the two
 * landed on different nodes. `release` moves the pointer off the button first.
 */
async function pressWithoutClick(page: Page, label: string, release?: { x: number; y: number }) {
  await page.getByRole("button", { name: label }).evaluate((element, releasePoint) => {
    const box = element.getBoundingClientRect()
    const start = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    const at = (x: number, y: number, buttons: number) => ({
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons,
      clientX: x,
      clientY: y,
    })
    element.dispatchEvent(new PointerEvent("pointerdown", at(start.x, start.y, 1)))
    document.dispatchEvent(
      new PointerEvent("pointerup", at(releasePoint?.x ?? start.x, releasePoint?.y ?? start.y, 0)),
    )
  }, release)
}

test.describe("Team chat thread pane: closing while an agent replies", () => {
  test.describe.configure({ mode: "serial" })

  let seed: TeamNavSeed
  let seeder: Page
  let rootId: string
  let rootText: string

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext()
    seeder = await context.newPage()
    await signIn(seeder)
    seed = await seedTeamNav(seeder)

    rootText = `close-thread root ${seed.suffix}`
    await api(seeder, "POST", `/api/conversations/${seed.channelId}/messages`, { text: rootText })
    const list = await api(seeder, "GET", `/api/conversations/${seed.channelId}/messages`)
    rootId = (list.json?.messages ?? []).find((m: any) => !m.threadRootId && m.text === rootText)?.id
    expect(rootId, "seeded thread root message").toBeTruthy()
  })

  test.afterAll(async () => {
    writeScript(seed, 100, {})
    await cleanupTeamNav(seeder, seed)
    await seeder.context().close()
  })

  test.beforeEach(async ({ page }) => {
    await signIn(page)
    await activateTeamWorkspace(page, seed.workspaceId)
    // The wide layout puts the thread in a side pane, with the header X.
    await page.setViewportSize({ width: 1280, height: 720 })
  })

  /**
   * Opens the thread and starts a reply that is still streaming when the test
   * presses the X. Returns once the pane shows the agent's run.
   */
  async function openThreadWithRunningReply(page: Page): Promise<string> {
    const reply = `Reading the build logs now: three flakes, all from the same checkout timeout (${seed.suffix}).`
    // 2000ms per streamed chunk keeps the run open for the length of the test.
    writeScript(seed, 2000, { [seed.idleAgent]: [{ reply }] })

    await page.goto(`/c/${seed.channelId}?thread=${rootId}`)
    // By accessible name: `main`'s X has no `accessibilityRole`, and every
    // assertion below should be about the press, not about the role.
    await expect(page.getByLabel("Close thread")).toBeVisible({ timeout: 60_000 })

    const mention = `<@a:p:${seed.idleAgentProjectId}> read the build logs`
    await api(seeder, "POST", `/api/conversations/${seed.channelId}/messages`, { text: mention, threadRootId: rootId })
    await expect(page.getByLabel(`Jump to ${seed.idleAgent}'s reply`)).toBeVisible({ timeout: 30_000 })
    return reply
  }

  test("the X closes the thread while the reply is streaming", async ({ page }) => {
    test.setTimeout(180_000)
    await openThreadWithRunningReply(page)

    await page.getByLabel("Close thread").click()

    await expect(page).not.toHaveURL(/thread=/, { timeout: 15_000 })
    await expect(closeButton(page)).toHaveCount(0)

    // The deltas that arrive afterwards must not put the pane back.
    await page.waitForTimeout(5_000)
    await expect(page).not.toHaveURL(/thread=/)
    await expect(closeButton(page)).toHaveCount(0)
    writeScript(seed, 100, {})
  })

  test("the X closes when the browser drops the click", async ({ page }) => {
    test.setTimeout(180_000)
    await openThreadWithRunningReply(page)

    await pressWithoutClick(page, "Close thread")

    await expect(page).not.toHaveURL(/thread=/, { timeout: 15_000 })
    await expect(closeButton(page)).toHaveCount(0)
    writeScript(seed, 100, {})
  })

  test("a press that leaves the button does not close the thread", async ({ page }) => {
    test.setTimeout(180_000)
    await openThreadWithRunningReply(page)

    // Drag off the header before releasing: not a press on the X.
    await pressWithoutClick(page, "Close thread", { x: 4, y: 4 })
    await page.waitForTimeout(1_000)

    await expect(page).toHaveURL(new RegExp(`thread=${rootId}`))
    await expect(closeButton(page)).toBeVisible()
    writeScript(seed, 100, {})
  })

  /**
   * The mechanism the report points at (SHO-243 hypothesis b), reproduced.
   *
   * RN-web's `PressResponder` terminates the gesture when a `selectionchange`
   * with a live selection lands while the pointer is down
   * (react-native-web/dist/modules/usePressEvents/PressResponder.js:274), and
   * its `click` handler then calls `preventDefault` instead of `onPress`
   * (:311) — no error, nothing in the DOM, the press is simply gone. A reply
   * streaming into the pane re-renders it on every delta, which is what moves a
   * live selection; an idle pane does not re-render, which is why the X works
   * again once the agent is done.
   *
   * Measured on `main` before the fix: the click's `defaultPrevented` is true
   * and the pane stays open. With the pointer fallback the release still closes
   * it.
   */
  test("a live selection that moves during the press does not swallow the close", async ({ page }) => {
    test.setTimeout(180_000)
    await openThreadWithRunningReply(page)

    // A person's selection, made before they reach for the X: the thread's root
    // message. (Selecting the streaming reply itself does not work — the delta
    // that replaces its text node collapses the selection, which is invalid to
    // RN-web and terminates nothing.)
    await page.evaluate((needle) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let node: Text | null = null
      while (walker.nextNode()) {
        const text = walker.currentNode as Text
        if (text.nodeValue?.includes(needle)) {
          node = text
          break
        }
      }
      if (!node) throw new Error(`no text node containing ${needle}`)
      const range = document.createRange()
      range.selectNodeContents(node)
      const selection = window.getSelection()
      if (!selection) throw new Error("no selection")
      selection.removeAllRanges()
      selection.addRange(range)
    }, "close-thread root")
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString().length ?? 0))
      .toBeGreaterThan(0)

    // By its accessible name, not its role: on `main` the X is a Pressable with
    // no `accessibilityRole`, so this locator has to find the same node on both
    // sides for the failure below to be about the press.
    const box = await page.getByLabel("Close thread").boundingBox()
    expect(box, "the X is laid out").toBeTruthy()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()

    // The reply keeps streaming and the selection moves under the press.
    await page.evaluate(() => {
      const selection = window.getSelection()
      const range = selection?.getRangeAt(0)
      if (!selection || !range) throw new Error("selection was dropped")
      const node = range.startContainer as Text
      range.setEnd(node, Math.max(1, node.length - 1))
      selection.removeAllRanges()
      selection.addRange(range)
    })
    // `selectionchange` is dispatched in its own task, so the release has to
    // come after the browser has delivered it — a real press outlives a frame.
    await page.waitForTimeout(250)

    await page.mouse.up()

    await expect(page).not.toHaveURL(/thread=/, { timeout: 15_000 })
    await expect(closeButton(page)).toHaveCount(0)
    writeScript(seed, 100, {})
  })
})
