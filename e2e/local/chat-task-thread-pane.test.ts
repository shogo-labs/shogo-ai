// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pressing a background task opens its destination in a side window (SHO-27).
 *
 * The dock row used to open the runtime-local log, which for a task that hands
 * work to another agent is empty — so the viewer stayed blank while the task
 * ran and after it settled. Now the row is a press target: it opens the task's
 * `link` (the agent's thread, a card, a callee project session) or its log, in
 * a pane beside the current chat, and it never renders an empty box.
 *
 * Runs the real local API + agent runtime against the scripted fake model:
 *
 *   AGENT_RUNTIME_ENTRY= LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 \
 *   LOCAL_LLM_BASIC_MODEL=fake-stream LOCAL_LLM_ADVANCED_MODEL=fake-stream \
 *   E2E_LOCAL_START_STACK=1 E2E_FAKE_LLM_STACK=1 \
 *   npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-task-thread-pane --project chromium --retries 0
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

const runningChip = (page: Page) =>
  page.getByLabel("Running", { exact: true }).filter({ visible: true })

/** The side window a pressed task opens (both surfaces mount the same pane). */
const taskPane = (page: Page) => page.getByTestId("task-thread-pane").filter({ visible: true }).first()

/** The dock row's press target, named after the task it opens. */
const taskRow = (page: Page, title: string) =>
  page.getByRole("button", { name: `Open ${title}`, exact: true }).filter({ visible: true }).first()

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

test.describe("chat task thread pane", () => {
  test("a running task opens its side window and says No output yet instead of staying blank", async () => {
    const page = await context.newPage()
    await openWorkspaceChat(page)

    const command = "sleep 900"
    await send(page, `${marker("bg", "pane1", 20, { ms: 5, cmd: "sleep 900" })} start that in the background`)

    // The row is the press target — its accessible name is `Open <title>`.
    await expect(runningChip(page)).toBeVisible({ timeout: 90_000 })
    const row = taskRow(page, command)
    await expect(row).toBeVisible({ timeout: 60_000 })

    const urlBefore = page.url()
    await row.click()

    // One press, a pane beside the chat — no navigation, nothing blank.
    const pane = taskPane(page)
    await expect(pane).toBeVisible({ timeout: 30_000 })
    await expect(pane.getByText("Command output", { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(pane.getByTestId("task-thread-log")).toHaveText(/No output yet/, { timeout: 30_000 })
    expect(page.url()).toBe(urlBefore)
    await expect(composer(page)).toBeVisible({ timeout: 15_000 })

    // Closing returns to the chat, which never moved.
    await page.getByLabel("Close task thread").click()
    await expect(pane).toHaveCount(0)

    // Leave nothing running behind the next case.
    await page.getByLabel("Kill process").filter({ visible: true }).first().click()
    await page.close()
  })

  test("a finished task's row still opens its destination, with its real output", async () => {
    const page = await context.newPage()
    await openWorkspaceChat(page)

    const command = "echo sho27done"
    await send(page, `${marker("bg", "pane2", 20, { ms: 5, cmd: "echo sho27done" })} and a quick one`)

    // The row settles in place instead of vanishing, and stays a press target.
    const finishedChip = page.getByLabel("Finished", { exact: true }).filter({ visible: true })
    await expect(finishedChip.first()).toBeVisible({ timeout: 150_000 })
    const row = taskRow(page, command)
    await expect(row).toBeVisible({ timeout: 30_000 })

    const urlBefore = page.url()
    await row.click()

    const pane = taskPane(page)
    await expect(pane).toBeVisible({ timeout: 30_000 })
    await expect(pane.getByText("Command output", { exact: true })).toBeVisible({ timeout: 15_000 })
    // The tail is the command's real output — never an empty box.
    await expect(pane.getByTestId("task-thread-log")).toContainText("sho27done", { timeout: 30_000 })
    expect(page.url()).toBe(urlBefore)
    await expect(composer(page)).toBeVisible({ timeout: 15_000 })

    await page.getByLabel("Close task thread").click()
    await expect(pane).toHaveCount(0)
    await page.close()
  })
})
