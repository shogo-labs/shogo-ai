// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phone web: the floating "Back to conversation" button in a thread must close
 * the thread and return to the channel timeline.
 *
 * Runs in the `iphone-15-pro` and `pixel-7` projects (see playwright.config.ts).
 */
import { mkdirSync, writeFileSync } from "fs"
import { dirname } from "path"
import { expect, test, type Page } from "@playwright/test"
import { activateTeamWorkspace, api, cleanupTeamNav, seedTeamNav, signIn, SCRIPT_PATH, type TeamNavSeed } from "./team-nav-seed"

/**
 * The scripted agent's stream speed is global, so a run that has to stay open
 * while the test looks at the composer gets a slow one — and the seed's own
 * script is put back in `finally`.
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

const backButton = (page: Page) => page.getByRole("button", { name: "Back to conversation" })

test.describe("Team chat thread on phone: back to conversation", () => {
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

    rootText = `thread root ${seed.suffix}`
    await api(seeder, "POST", `/api/conversations/${seed.channelId}/messages`, { text: rootText })
    const list = await api(seeder, "GET", `/api/conversations/${seed.channelId}/messages`)
    rootId = (list.json?.messages ?? []).find((m: any) => !m.threadRootId && m.text === rootText)?.id
    expect(rootId, "seeded thread root message").toBeTruthy()
  })

  test.afterAll(async () => {
    await cleanupTeamNav(seeder, seed)
    await seeder.context().close()
  })

  test.beforeEach(async ({ page }) => {
    await signIn(page)
    await activateTeamWorkspace(page, seed.workspaceId)
  })

  test("back closes a thread opened from its link", async ({ page }) => {
    await page.goto(`/c/${seed.channelId}?thread=${rootId}`)
    await expect(page.getByTestId("floating-thread-header")).toBeVisible({ timeout: 60_000 })

    await backButton(page).click()

    await expect(page).not.toHaveURL(/thread=/, { timeout: 15_000 })
    await expect(page.getByTestId("floating-thread-header")).toHaveCount(0)
    await expect(page.getByTestId("floating-conversation-header")).toBeVisible()
  })

  test("back closes a thread opened from the Reply in thread action", async ({ page }) => {
    await page.goto(`/c/${seed.channelId}`)
    const row = page.getByLabel(new RegExp(`${rootText}$`)).first()
    await expect(row).toBeVisible({ timeout: 60_000 })
    // The action toolbar renders on hover (web), so reveal it before tapping Reply.
    await row.hover()
    await row.getByLabel("Reply in thread").click()
    await expect(page).toHaveURL(new RegExp(`thread=${rootId}`), { timeout: 15_000 })
    await expect(page.getByTestId("floating-thread-header")).toBeVisible()

    await backButton(page).click()

    await expect(page).not.toHaveURL(/thread=/, { timeout: 15_000 })
    await expect(page.getByTestId("floating-thread-header")).toHaveCount(0)
  })

  test("a running agent's dock floats above the phone composer", async ({ page }) => {
    test.setTimeout(240_000)
    const reply = `Read the build logs: three flakes, all from the same checkout timeout (${seed.suffix}).`
    // The scripted runner emits two chunks with `delayMs` before each, so a run
    // lasts about 2 × delayMs. 20 s gives a 40 s run — long enough to still be
    // streaming when the pane has finished loading, with room for the second
    // turn the follow-up message queues (see below) inside the test cap.
    writeScript(seed, 20_000, { [seed.idleAgent]: [{ reply }] })
    try {
      // Start the run BEFORE the pane opens. The dock is a view of the pane's
      // own timeline, so the spec must not depend on live delivery into a page
      // that is still connecting its socket: on pixel-7 the pane missed the
      // mention's `message.created` entirely and learned about the reply only
      // in its finished state (from the backfill on `ready`), so
      // `runningAgentReplies()` docked nothing for the whole 30 s wait
      // (SHO-249 round 2). Opening the thread afterwards makes the dock come
      // from the same initial fetch as every other row.
      const mention = `<@a:p:${seed.idleAgentProjectId}> read the build logs`
      await api(seeder, "POST", `/api/conversations/${seed.channelId}/messages`, { text: mention, threadRootId: rootId })

      // Wait for the run itself before opening the pane, so a red below says the
      // dock is broken rather than that the scripted run was over too early.
      await expect
        .poll(
          async () => {
            const thread = await api(seeder, "GET", `/api/conversations/${seed.channelId}/messages?threadRootId=${rootId}`)
            return (thread.json?.messages ?? []).find(
              (m: any) => m.authorAgent?.name === seed.idleAgent && m.agentStatus === "running",
            )?.id ?? null
          },
          { timeout: 60_000, intervals: [500, 1000, 2000] },
        )
        .not.toBeNull()

      // A later message in the thread is what pushes the running reply's row up
      // the thread, which is the case the dock exists for. Posted while the run
      // is live, the API also queues it for the agent, so a second turn streams
      // when this one ends.
      await api(seeder, "POST", `/api/conversations/${seed.channelId}/messages`, { text: `any update${seed.suffix}?`, threadRootId: rootId })

      await page.goto(`/c/${seed.channelId}?thread=${rootId}`)
      await expect(page.getByTestId("floating-thread-header")).toBeVisible({ timeout: 60_000 })

      const dockRow = page.getByLabel(`Jump to ${seed.idleAgent}'s reply`)
      await expect(dockRow).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(`any update${seed.suffix}?`)).toBeVisible({ timeout: 30_000 })
      await expect(dockRow).toBeVisible()

      // The dock is a running-run view: if the script ended first, the layout
      // checks below would be asserting on nothing.
      const stillRunning = await api(seeder, "GET", `/api/conversations/${seed.channelId}/messages?threadRootId=${rootId}`)
      expect(
        (stillRunning.json?.messages ?? []).find((m: any) => m.authorAgent?.name === seed.idleAgent)?.agentStatus,
        "the scripted run ended before the dock layout was measured",
      ).toBe("running")

      // It floats inside the composer footer, above the input box.
      const footer = page.getByTestId("floating-composer")
      await expect(footer.getByTestId("running-agents-dock")).toBeVisible()
      const dockBox = await page.getByTestId("running-agents-dock").boundingBox()
      const composerBox = await page.getByLabel("Message", { exact: true }).last().boundingBox()
      expect(dockBox, "the dock is laid out").toBeTruthy()
      expect(composerBox, "the composer is laid out").toBeTruthy()
      expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(composerBox!.y + 1)

      // The typing line names people only.
      await expect(page.getByText(`${seed.idleAgent} is typing…`)).toHaveCount(0)

      // The queued second turn re-reads the script when it starts, so shorten it
      // now: the run under test keeps the 20 s chunks it was started with, and
      // the queue drains ~100 ms into its next reply instead of streaming 40 s
      // more (the phone job is capped at 30 min).
      writeScript(seed, 100, { [seed.idleAgent]: [{ reply: "nothing new" }] })

      // Wait for both turns to end server-side, then reload and assert on the
      // fetch. Nothing after this point depends on the pane's realtime socket:
      // on pixel-7 it can sit connected-but-silent for the whole test, which is
      // what turned "the dock goes away" into a 60 s wait for events that never
      // arrived (SHO-249 round 2). The reply row of the run under test keeps its
      // streamed text in the database, so a reload shows it finished.
      await expect
        .poll(
          async () => {
            const thread = await api(seeder, "GET", `/api/conversations/${seed.channelId}/messages?threadRootId=${rootId}`)
            const replies = (thread.json?.messages ?? []).filter(
              (m: any) => m.authorAgent?.name === seed.idleAgent,
            )
            return replies.length >= 2 && replies.every((m: any) => m.agentStatus === "done")
          },
          { timeout: 120_000, intervals: [1000, 2000] },
        )
        .toBe(true)

      await page.reload()
      await expect(page.getByTestId("floating-thread-header")).toBeVisible({ timeout: 60_000 })
      await expect(page.getByText(reply, { exact: false })).toBeVisible({ timeout: 30_000 })
      // Nothing is running → nothing is docked.
      await expect(page.getByTestId("running-agents-dock")).toHaveCount(0)
    } finally {
      writeScript(seed, 100, {})
    }
  })

  test("browser back closes a thread opened from the Reply in thread action", async ({ page }) => {
    await page.goto(`/c/${seed.channelId}`)
    const row = page.getByLabel(new RegExp(`${rootText}$`)).first()
    await expect(row).toBeVisible({ timeout: 60_000 })
    await row.hover()
    await row.getByLabel("Reply in thread").click()
    await expect(page.getByTestId("floating-thread-header")).toBeVisible({ timeout: 15_000 })

    await page.goBack()

    await expect(page).toHaveURL(new RegExp(`/c/${seed.channelId}$`), { timeout: 15_000 })
    await expect(page.getByTestId("floating-thread-header")).toHaveCount(0)
    await expect(page.getByTestId("floating-conversation-header")).toBeVisible()
  })
})
