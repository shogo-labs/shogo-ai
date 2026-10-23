// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-130 AC 5 — *the agent on the machine*, not just the proxy.
 *
 * "If I am in the cloud and I choose a machine workspace then I should see
 * exactly what is on that machine and I should be able to talk to any of the
 * agents on that machine." Talking to an agent is the part a request-log
 * assertion cannot see: the turn has to reach the machine's agent runtime, and
 * that agent has to read *the machine's* disk.
 *
 * So this runs the real agent against the scripted model in
 * `apps/desktop/e2e/streaming/fake-llm-server.ts` (the same harness
 * `chat-resume-on-send` uses): the model calls `read_file` on a canary that
 * exists only inside the machine's workspace, and the assertion is that the
 * model's continuation request carries a tool result containing that canary.
 * The negative control is the same marked message sent from the cloud
 * workspace: its agent reads its own workspace root, where the canary is not.
 *
 * Needs the API pointed at the fake model, which would change every other local
 * spec, so it is skipped unless that stack is up:
 *
 *   LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 LOCAL_LLM_BASIC_MODEL=fake-stream \
 *   LOCAL_LLM_ADVANCED_MODEL=fake-stream SHOGO_LOCAL_MODE=true bun --no-env-file apps/api/src/entry.ts
 *
 *   E2E_FAKE_LLM_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     machine-workspace-agent-turn --project chromium --retries 0
 */
import { expect, test, type Page } from "@playwright/test"
import { FakeLlmServer, marker, token } from "../../apps/desktop/e2e/streaming/fake-llm-server"
import { LOCAL_API_BASE } from "./helpers"
import {
  MACHINE_WORKSPACE_NAME,
  installCloudRelay,
  openCloudWorkspace,
  readWorkspaces,
  relayBase,
  selectMachineWorkspace,
  type RelayCall,
} from "./machine-relay"

const CANARY = "SHO130-AGENT-CANARY-4d91"
/** Where the canary sits inside the machine's workspace. */
const CANARY_PATH = ".tmp/sho130-agent-canary.txt"
const LLM_PORT = Number(process.env.E2E_FAKE_LLM_PORT || 18765)
const MACHINE_TAG = "m1"
const CLOUD_TAG = "c1"

test.skip(
  process.env.E2E_FAKE_LLM_STACK !== "1",
  "needs an API started with LOCAL_LLM_BASE_URL pointing at the fake model (see the header); set E2E_FAKE_LLM_STACK=1",
)
test.setTimeout(300_000)

let llm: FakeLlmServer

test.beforeAll(async () => {
  llm = new FakeLlmServer()
  await llm.start(LLM_PORT)
  const models = await fetch(`${LOCAL_API_BASE}/api/local/models`).then((r) => r.json()).catch(() => null)
  if (!models?.ok || !(models.models ?? []).some((m: { id?: string }) => m?.id === "fake-stream")) {
    throw new Error(
      `the API is not using the fake model on :${LLM_PORT} (GET /api/local/models: ${JSON.stringify(models).slice(0, 200)}); ` +
        `start it with LOCAL_LLM_BASE_URL=http://127.0.0.1:${LLM_PORT} LOCAL_LLM_BASIC_MODEL=fake-stream LOCAL_LLM_ADVANCED_MODEL=fake-stream`,
    )
  }
})

test.afterAll(async () => {
  await llm?.stop()
})

/** Put the canary on the machine's disk, through the relay the app uses. */
async function writeCanary(page: Page, machineWorkspaceId: string): Promise<void> {
  const url = `${relayBase()}/api/workspaces/${machineWorkspaceId}/agent-proxy/agent/workspace/files/${CANARY_PATH}`
  const write = () =>
    page.evaluate(
      async ({ url, token }) => {
        const res = await fetch(url, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: token }),
        })
        return { status: res.status, body: await res.text() }
      },
      { url, token: CANARY },
    )
  let last = { status: 0, body: "" }
  await expect
    .poll(
      async () => {
        last = await write()
        return last.status
      },
      { timeout: 120_000, intervals: [2000] },
    )
    .toBe(200)
}

/** Send a marked turn from the workspace agent chat that is on screen. */
async function sendTurn(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox").last()
  await expect(composer).toBeVisible({ timeout: 60_000 })
  await composer.click()
  await composer.fill(text)
  await page.keyboard.press("Enter")
}

test("SHO-130 AC 5 · the agent on the machine reads the machine's disk, and the cloud agent does not", async ({
  page,
}) => {
  test.slow()
  const log: RelayCall[] = []

  await openCloudWorkspace(page)
  const { personal, team, userId } = await readWorkspaces(page)
  await installCloudRelay(page, { machineWorkspaceId: team.id, userId, log })
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForTimeout(3000)

  await writeCanary(page, team.id)

  // ── The machine's workspace: the agent reads its own disk ────────────────
  await selectMachineWorkspace(page)
  await expect(page.getByRole("button", { name: `${MACHINE_WORKSPACE_NAME}, workspace menu` })).toBeVisible({
    timeout: 20_000,
  })

  await sendTurn(page, `Read the canary ${marker("tool", MACHINE_TAG, 40, { ms: 5, rounds: 1, path: CANARY_PATH })}`)

  // Two model requests: the tool call, then the continuation carrying its result.
  await llm.waitForRequestCount(MACHINE_TAG, 2, 180_000)
  const machineTurns = llm.requestsFor(MACHINE_TAG)
  expect(machineTurns[0].toolCalled).toBe("read_file")
  // This is the whole claim: the model was handed the canary's contents, which
  // only exist inside the machine's workspace.
  expect(machineTurns[1].toolResults ?? "").toContain(CANARY)
  // …and that turn went to the machine, not the cloud workspace.
  expect(log.some((r) => r.path.includes("/chat") && r.path.includes(team.id))).toBe(true)
  expect(log.some((r) => r.path.includes("/chat") && r.path.includes(personal.id))).toBe(false)

  // The agent's answer reaches the person looking at the machine workspace.
  await expect(page.getByText(token(MACHINE_TAG, 1), { exact: false })).toBeVisible({ timeout: 60_000 })

  // ── The same message from the cloud workspace: no canary ─────────────────
  await page.getByRole("button", { name: /— open account/ }).first().click()
  await page.getByTestId(`workspace-row:cloud:${personal.id}`).click()
  await expect(page.getByText(new RegExp(`Connected to`, "i"))).toHaveCount(0, { timeout: 30_000 })

  await sendTurn(page, `Read the canary ${marker("tool", CLOUD_TAG, 40, { ms: 5, rounds: 1, path: CANARY_PATH })}`)
  await llm.waitForRequestCount(CLOUD_TAG, 2, 180_000)
  const cloudTurns = llm.requestsFor(CLOUD_TAG)
  expect(cloudTurns[0].toolCalled).toBe("read_file")
  // The cloud workspace's agent read its own root — the canary is not there.
  expect(cloudTurns[1].toolResults ?? "").not.toContain(CANARY)
  expect(cloudTurns.every((t) => !(t.toolResults ?? "").includes(CANARY))).toBe(true)

})
