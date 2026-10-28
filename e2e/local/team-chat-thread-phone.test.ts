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
    test.setTimeout(180_000)
    const reply = `Read the build logs: three flakes, all from the same checkout timeout (${seed.suffix}).`
    // 2500ms per streamed chunk keeps the run open for the length of the test.
    writeScript(seed, 2500, { [seed.idleAgent]: [{ reply }] })
    try {
      await page.goto(`/c/${seed.channelId}?thread=${rootId}`)
      await expect(page.getByTestId("floating-thread-header")).toBeVisible({ timeout: 60_000 })

      const mention = `<@a:p:${seed.idleAgentProjectId}> read the build logs`
      await api(seeder, "POST", `/api/conversations/${seed.channelId}/messages`, { text: mention, threadRootId: rootId })

      const dockRow = page.getByLabel(`Jump to ${seed.idleAgent}'s reply`)
      await expect(dockRow).toBeVisible({ timeout: 30_000 })

      // Posted under the agent's marker, which is what pushes it up the thread.
      await api(seeder, "POST", `/api/conversations/${seed.channelId}/messages`, { text: `any update${seed.suffix}?`, threadRootId: rootId })
      await expect(page.getByText(`any update${seed.suffix}?`)).toBeVisible({ timeout: 30_000 })
      await expect(dockRow).toBeVisible()

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

      await expect(page.getByText(reply, { exact: false })).toBeVisible({ timeout: 60_000 })
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
