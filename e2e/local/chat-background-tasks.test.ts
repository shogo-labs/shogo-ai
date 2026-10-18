// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The chat dock keeps a background task across navigation and reload (SHO-25).
 *
 * The dock used to be fed by live `data-task-update` frames only: for a
 * workspace chat (the landing chat — `workspaceId` + `chatScope`, no
 * `projectId`) the runtime base resolved to `null`, so the seed fetch never
 * ran and every row vanished the moment the panel remounted. A task that
 * finished left the list entirely, because the runtime only ever listed
 * running tasks.
 *
 * Runs the real local API + agent runtime against the scripted fake model:
 *
 *   AGENT_RUNTIME_ENTRY= LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 \
 *   LOCAL_LLM_BASIC_MODEL=fake-stream LOCAL_LLM_ADVANCED_MODEL=fake-stream \
 *   E2E_LOCAL_START_STACK=1 E2E_FAKE_LLM_STACK=1 \
 *   npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-background-tasks --project chromium --retries 0
 *
 * `AGENT_RUNTIME_ENTRY` must be unset: with it set, the API spawns the runtime
 * bundled inside the installed app instead of this checkout's source, and the
 * assertions below run against the old runtime.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { FakeLlmServer, marker } from "../../apps/desktop/e2e/streaming/fake-llm-server"
import { openTeamHome } from "./helpers"

const API = process.env.E2E_API_URL || "http://localhost:8002"
const LLM_PORT = Number(process.env.E2E_FAKE_LLM_PORT || 18765)
/** The workspace agent chat: `chatScope="workspace"`, no projectId. */
const AGENT_CHAT_PATH = "/agent"
/** Anywhere else in the app — the panel unmounts and remounts. */
const AWAY_PATH = "/home"

// Needs the API pointed at the fake model, which would change every other
// local spec; CI runs it in its own job.
test.skip(
  process.env.E2E_FAKE_LLM_STACK !== "1",
  "needs an API started with LOCAL_LLM_BASE_URL pointing at the fake model (see the header); set E2E_FAKE_LLM_STACK=1",
)

test.setTimeout(300_000)

let llm: FakeLlmServer
let context: BrowserContext

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(360_000)
  llm = new FakeLlmServer()
  await llm.start(LLM_PORT)
  context = await browser.newContext({ baseURL: String(info.project.use.baseURL) })
  const signIn = await context.request.post(`${API}/api/local/auto-sign-in`)
  if (!signIn.ok()) throw new Error(`auto-sign-in failed (${signIn.status()}): ${await signIn.text()}`)
  await context.request.post(`${API}/api/onboarding/complete`)

  const models = await (await context.request.get(`${API}/api/local/models`)).json()
  if (!(models?.models ?? []).some((m: any) => m?.id === "fake-stream")) {
    throw new Error(
      `the API is not using the fake model on :${LLM_PORT} (GET /api/local/models: ${JSON.stringify(models).slice(0, 200)}); ` +
        `start it with LOCAL_LLM_BASE_URL=http://127.0.0.1:${LLM_PORT} LOCAL_LLM_BASIC_MODEL=fake-stream LOCAL_LLM_ADVANCED_MODEL=fake-stream`,
    )
  }
})

test.afterAll(async () => {
  await context?.close()
  await llm?.stop()
})

// ── Window helpers ──────────────────────────────────────────────────────────

const composer = (page: Page) =>
  page.getByTestId("project-composer-input").filter({ visible: true }).first()

/** The dock chip while anything is running (aria-label from `DockPanel`). */
const runningChip = (page: Page) =>
  page.getByLabel("Running", { exact: true }).filter({ visible: true })

/** A live, cancellable dock row — the dock is the only place these exist. */
const cancelButtons = (page: Page) =>
  page.getByRole("button", { name: /^(Kill process|Cancel task|Dismiss)$/ })

async function openWorkspaceChat(page: Page): Promise<void> {
  await openTeamHome(page)
  await page.goto(AGENT_CHAT_PATH)
  await expect(composer(page)).toBeVisible({ timeout: 120_000 })
  const switchToText = page.getByText("Switch to text input", { exact: true })
  if (await switchToText.isVisible().catch(() => false)) await switchToText.click()
}

async function send(page: Page, text: string): Promise<void> {
  const input = composer(page)
  await input.click()
  await input.fill(text)
  await page.keyboard.press("Enter")
}

/** The dock row shows the command, so a unique one identifies it. */
async function expectCommandInDock(page: Page, command: string, timeout = 90_000): Promise<void> {
  await expect(page.getByText(command, { exact: false }).first()).toBeVisible({ timeout })
}

test.describe("chat dock background tasks", () => {
  test("a background task survives navigating away and a reload", async () => {
    const page = await context.newPage()
    await openWorkspaceChat(page)

    const command = "sleep 900"
    await send(page, `${marker("bg", "dock1", 20, { ms: 5, cmd: "sleep 900" })} start the long build in the background`)

    // The row appears while the turn runs (live frames).
    await expect(runningChip(page)).toBeVisible({ timeout: 90_000 })
    await expect(cancelButtons(page).first()).toBeVisible({ timeout: 30_000 })
    await expectCommandInDock(page, command)

    // Away and back: the panel remounts, so only the runtime seed can list it.
    await page.goto(AWAY_PATH)
    await page.getByText("What are we building", { exact: false }).first().waitFor({ state: "visible", timeout: 60_000 })
    await page.goto(AGENT_CHAT_PATH)
    await expect(composer(page)).toBeVisible({ timeout: 120_000 })
    await expect(runningChip(page)).toBeVisible({ timeout: 60_000 })
    await expect(cancelButtons(page).first()).toBeVisible({ timeout: 30_000 })
    await expectCommandInDock(page, command)

    // A full reload is a cold panel with no frames at all.
    await page.reload()
    await expect(composer(page)).toBeVisible({ timeout: 120_000 })
    await expect(runningChip(page)).toBeVisible({ timeout: 60_000 })
    await expect(cancelButtons(page).first()).toBeVisible({ timeout: 30_000 })
    await expectCommandInDock(page, command)

    await page.close()
  })

  test("a finished task stays as a completed row, with Output and no Cancel", async () => {
    const page = await context.newPage()
    await openWorkspaceChat(page)

    await send(page, `${marker("bg", "dock2", 20, { ms: 5, cmd: "sleep 2" })} and a short one too`)

    // It settles on its own, and the runtime keeps it as a terminal row.
    await expect(page.getByText("completed", { exact: true }).first()).toBeVisible({ timeout: 120_000 })
    // Output still opens on a finished row; it is not cancellable.
    await expect(page.getByRole("button", { name: "Show output" }).first()).toBeVisible({ timeout: 15_000 })
    if (await page.getByText(/the agent will continue when/).first().isVisible().catch(() => false)) {
      throw new Error("a finished task must not be announced as one the agent is waiting on")
    }

    // Still there after a remount, with the same outcome.
    await page.reload()
    await expect(composer(page)).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText("completed", { exact: true }).first()).toBeVisible({ timeout: 60_000 })
    await expect(runningChip(page).or(page.getByLabel("Finished", { exact: true })).first()).toBeVisible({ timeout: 30_000 })

    await page.close()
  })
})
