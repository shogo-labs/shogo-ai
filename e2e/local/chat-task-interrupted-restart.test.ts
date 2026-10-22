// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A background task the runtime dies under is reported honestly (SHO-141, #1634).
 *
 * The bug: `t_514e92a0 completed (exit code 0)` for a task that merged nothing.
 * Three defects stacked into that one sentence — the verdict was inferred from
 * the exit code, the code was the last stage of a pipeline (`tail`'s), and the
 * restart deleted the log the report pointed at.
 *
 * From the user's path, this spec drives the real local API + agent runtime
 * against the scripted fake model and asserts:
 *   1. after the runtime restarts under a running background task, the dock row
 *      reads `interrupted` and never `completed`;
 *   2. the task's output log is still readable after that restart, and its
 *      footer says `interrupted` with no `exit_code`;
 *   3. a piped background command reports its own failure (`false | cat` is a
 *      failure, not `tail`'s success).
 *
 * Runs the real local API + agent runtime against the scripted fake model:
 *
 *   AGENT_RUNTIME_ENTRY= LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 \
 *   LOCAL_LLM_BASIC_MODEL=fake-stream LOCAL_LLM_ADVANCED_MODEL=fake-stream \
 *   E2E_LOCAL_START_STACK=1 E2E_FAKE_LLM_STACK=1 \
 *   npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-task-interrupted-restart --project chromium --retries 0
 *
 * `AGENT_RUNTIME_ENTRY` must be unset: with it set, the API spawns the runtime
 * bundled inside the installed app instead of this checkout's source.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { FakeLlmServer, marker } from "../../apps/desktop/e2e/streaming/fake-llm-server"
import { openTeamHome } from "./helpers"

const API = process.env.E2E_API_URL || "http://localhost:8002"
const LLM_PORT = Number(process.env.E2E_FAKE_LLM_PORT || 18765)
/** The workspace agent chat: `chatScope="workspace"`, no projectId. */
const AGENT_CHAT_PATH = "/agent"
const BOOTSTRAP_SECRET = process.env.SHOGO_E2E_BOOTSTRAP_SECRET || "e2e-local-restart"

// Needs the API pointed at the fake model, which would change every other
// local spec; CI runs it in its own job.
test.skip(
  process.env.E2E_FAKE_LLM_STACK !== "1",
  "needs an API started with LOCAL_LLM_BASE_URL pointing at the fake model (see the header); set E2E_FAKE_LLM_STACK=1",
)

test.setTimeout(420_000)

let llm: FakeLlmServer
let context: BrowserContext

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(420_000)
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

/**
 * Restart the host agent runtime the way a runtime restart does: the API stops
 * the supervised process (a graceful stop, so the shutdown sweep runs) and the
 * next request cold-starts it. A page reload alone re-attaches to the warm
 * runtime and would skip the path under test.
 */
async function restartRuntime(): Promise<string[]> {
  const res = await context.request.post(`${API}/api/internal/e2e/restart-local-runtime`, {
    headers: { "x-e2e-bootstrap-secret": BOOTSTRAP_SECRET },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok() || body?.ok !== true) {
    throw new Error(`restart-local-runtime failed (${res.status()}): ${JSON.stringify(body)}`)
  }
  return body.stopped ?? []
}

/** A dock row that reads exactly `label` (the status text under the command). */
const settledRow = (page: Page, label: string) =>
  page.getByText(label, { exact: true }).filter({ visible: true }).first()

test.describe("a task the runtime restart killed", () => {
  test("the dock reads interrupted after the restart, never completed", async () => {
    const page = await context.newPage()
    await openWorkspaceChat(page)

    const command = "sleep 900"
    await send(page, `${marker("bg", "ir1", 20, { ms: 5, cmd: command })} start the long build in the background`)
    await expect(runningChip(page)).toBeVisible({ timeout: 90_000 })
    await expect(cancelButtons(page).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(command, { exact: false }).first()).toBeVisible({ timeout: 90_000 })

    const stopped = await restartRuntime()
    expect(stopped.length, "the restart stopped no runtime, so nothing was tested").toBeGreaterThan(0)

    // Cold panel against a cold runtime: the row comes back from the snapshot
    // the shutdown persisted (or from its footer-less log), not from live frames.
    await page.reload()
    await expect(composer(page)).toBeVisible({ timeout: 120_000 })

    await expect(settledRow(page, "interrupted")).toBeVisible({ timeout: 150_000 })
    await expect(page.getByText(command, { exact: false }).first()).toBeVisible({ timeout: 60_000 })
    // The verdict the reporter saw, and any exit-code variant of it, is gone.
    await expect(page.getByText("completed", { exact: true })).toHaveCount(0)
    await expect(page.getByText(/completed \(exit code/)).toHaveCount(0)

    // The runtime is really back: a fresh turn runs and still does not rewrite
    // the killed task's verdict.
    await send(page, `${marker("long", "ir1b", 6, { ms: 5 })} are you back?`)
    await expect(page.getByText("tir1bw0006", { exact: false }).first()).toBeVisible({ timeout: 120_000 })
    await expect(settledRow(page, "interrupted")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("completed", { exact: true })).toHaveCount(0)

    await page.close()
  })

  test("the log the interrupted row points at still exists and says interrupted", async () => {
    const page = await context.newPage()
    await openWorkspaceChat(page)

    const command = "sleep 900"
    await send(page, `${marker("bg", "ir2", 20, { ms: 5, cmd: command })} one more in the background`)
    await expect(cancelButtons(page).first()).toBeVisible({ timeout: 90_000 })

    expect((await restartRuntime()).length).toBeGreaterThan(0)

    await page.reload()
    await expect(composer(page)).toBeVisible({ timeout: 120_000 })
    await expect(settledRow(page, "interrupted")).toBeVisible({ timeout: 150_000 })

    // "Output" opens the task's log through the runtime. A report that points at
    // a deleted file shows nothing here — which is the half of AC4 that this
    // surface can prove (a VM re-assignment deletes the tree; see the card).
    await page.getByLabel("Show output").filter({ visible: true }).first().click()
    const viewer = page.getByLabel("Hide output").filter({ visible: true }).first()
    await expect(viewer).toBeVisible({ timeout: 30_000 })

    // The footer is written by the shutdown sweep: the verdict, and no exit code.
    await expect(page.getByText(/status: interrupted/).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/exit_code:/)).toHaveCount(0)

    await page.close()
  })

  test("a piped background command reports its own failure, not the last stage's", async () => {
    const page = await context.newPage()
    await openWorkspaceChat(page)

    // `false | cat`: `cat` exits 0 and used to be reported as the command's own
    // success (the reporter's `cmd | tail -25` in miniature).
    await send(page, `${marker("bg", "ir3", 20, { ms: 5, cmd: "false | cat" })} run the check in the background`)
    await expect(page.getByText("false | cat", { exact: false }).first()).toBeVisible({ timeout: 90_000 })

    await expect(settledRow(page, "failed")).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText("completed", { exact: true })).toHaveCount(0)

    await page.close()
  })
})
