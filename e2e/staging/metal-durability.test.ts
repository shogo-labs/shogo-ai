// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type FrameLocator, type Page } from "./fixtures"
import {
  bootstrapApiBase,
  createProjectAndWait,
  makeTestUser,
  runtimeFaultViaApi,
  signUpAndOnboard,
  suspendRuntimeViaApi,
  waitForAgentIdle,
  waitForAgentResponse,
  type TestUser,
} from "./helpers"

/**
 * Metal durability E2E: the off-happy-path lifecycles behind the post-2.0
 * data-loss fixes, on real staging hosts.
 *
 *   1. Crash: kill the VM's Firecracker process (disk left behind). The next
 *      open must rescue the workspace from that disk, not boot the template or
 *      an older backup (#965).
 *   2. Cold boot with the snapshot gone: suspend, drop the local and durable
 *      snapshot, reopen. The project must come back from its source / repo
 *      backups alone (#1072, #1081).
 *   3. Checkpoint rollback while the runtime is cold: the API must hydrate the
 *      durable repo before touching it, never "failed to unpack tree object"
 *      (#992).
 *
 * Faults go through `/api/internal/e2e/runtime-fault`, which needs
 * `SHOGO_E2E_BOOTSTRAP_SECRET` here and `METAL_E2E_FAULTS=1` on the staging
 * metal hosts. The suite skips when either is missing.
 *
 * Run: E2E_TARGET_URL=... SHOGO_E2E_BOOTSTRAP_SECRET=... \
 *   npx playwright test --config e2e/playwright.config.ts metal-durability
 */

const TEST_USER = makeTestUser("MetalDurability")
const RUN = Date.now().toString(36)
const FIRST = `Durable First ${RUN}`
const SECOND = `Durable Second ${RUN}`

const PREVIEW_BOOT_TIMEOUT_MS = 180_000
const PREVIEW_CONTENT_TIMEOUT_MS = 90_000

async function ensureAuthenticated(page: Page, user: TestUser): Promise<void> {
  await page.goto("/")
  const home = page.getByText("What are we building", { exact: false }).first()
  const signUpTab = page.getByRole("tab", { name: "Sign Up" })
  await Promise.race([
    home.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
    signUpTab.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
  ])
  if (await home.isVisible().catch(() => false)) return
  await signUpAndOnboard(page, user)
}

function previewFrame(page: Page): FrameLocator {
  return page.frameLocator('[data-testid="canvas-preview-iframe"]')
}

async function expectPreviewHeading(page: Page, heading: string): Promise<void> {
  await page.getByTestId("canvas-preview-iframe").waitFor({ state: "attached", timeout: PREVIEW_BOOT_TIMEOUT_MS })
  const deadline = Date.now() + PREVIEW_CONTENT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await page.getByLabel("Refresh preview").first().click({ force: true }).catch(() => {})
    const ok = await previewFrame(page)
      .getByText(heading, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    if (ok) return
    await page.waitForTimeout(1_500)
  }
  throw new Error(`preview never rendered "${heading}"`)
}

async function expectNotTemplate(page: Page): Promise<void> {
  const frame = previewFrame(page)
  await expect(frame.getByText("Project Ready", { exact: false })).toHaveCount(0)
  await expect(frame.getByText("Start building your app!", { exact: false })).toHaveCount(0)
}

async function setHeading(page: Page, heading: string): Promise<void> {
  await waitForAgentIdle(page)
  const box = page.getByTestId("project-composer-input").filter({ visible: true }).first()
  await box.fill(
    `Replace the ENTIRE contents of src/App.tsx with a minimal default-exported React component ` +
      `whose only visible content is a single <h1> with the exact text "${heading}". ` +
      `Do not add any other text, components, or files. After writing the file, stop.`,
  )
  await page.keyboard.press("Enter")
  await waitForAgentResponse(page)
  await expectPreviewHeading(page, heading)
}

async function reopen(page: Page, projectId: string): Promise<void> {
  await page.goto("/")
  await page.waitForSelector("text=What are we building", { timeout: 30_000 })
  await page.goto(`/projects/${projectId}`)
}

test.describe("Metal durability (faults on staging hosts)", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let projectId = ""

  test.beforeAll(async ({ browser }) => {
    test.skip(!process.env.SHOGO_E2E_BOOTSTRAP_SECRET, "needs SHOGO_E2E_BOOTSTRAP_SECRET for the fault backdoor")
    page = await browser.newPage()
    await ensureAuthenticated(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test("a project with two committed turns", async () => {
    test.setTimeout(600_000)
    await createProjectAndWait(
      page,
      "Create the simplest possible starter app: a single page that shows the word Hello. No extra pages, components, features, or backend.",
    )
    projectId = page.url().match(/\/projects\/([^/?#]+)/)?.[1] ?? ""
    expect(projectId, `expected a /projects/<id> URL, got ${page.url()}`).not.toBe("")
    await setHeading(page, FIRST)
    await setHeading(page, SECOND)
  })

  test("crash: the next open rescues the workspace from the dead VM's disk", async () => {
    test.setTimeout(480_000)
    const r = await runtimeFaultViaApi(page, projectId, "crash")
    test.skip(!r, "runtime faults unavailable (host needs METAL_E2E_FAULTS=1)")
    expect(r!.ok, JSON.stringify(r!.body)).toBe(true)

    await reopen(page, projectId)
    await expectPreviewHeading(page, SECOND)
    await expectNotTemplate(page)
  })

  test("cold boot with the snapshot gone comes back from backups", async () => {
    test.setTimeout(480_000)
    expect(await suspendRuntimeViaApi(page, projectId), "runtime must really suspend").toBe(true)
    const r = await runtimeFaultViaApi(page, projectId, "drop-snapshot")
    test.skip(!r, "runtime faults unavailable (host needs METAL_E2E_FAULTS=1)")
    expect(r!.ok, JSON.stringify(r!.body)).toBe(true)

    await reopen(page, projectId)
    await expectPreviewHeading(page, SECOND)
    await expectNotTemplate(page)
  })

  test("checkpoint rollback succeeds while the runtime is cold", async () => {
    test.setTimeout(300_000)
    expect(await suspendRuntimeViaApi(page, projectId), "runtime must really suspend").toBe(true)
    const r = await runtimeFaultViaApi(page, projectId, "drop-snapshot")
    test.skip(!r, "runtime faults unavailable (host needs METAL_E2E_FAULTS=1)")

    const base = bootstrapApiBase()
    const list = await page.request.get(`${base}/api/projects/${projectId}/checkpoints`, { headers: { Origin: base } })
    expect(list.ok(), await list.text()).toBe(true)
    const { checkpoints } = (await list.json()) as { checkpoints: Array<{ id: string }> }
    expect(checkpoints.length, "each committed turn records a checkpoint").toBeGreaterThanOrEqual(2)

    const rollback = await page.request.post(
      `${base}/api/projects/${projectId}/checkpoints/${checkpoints[1].id}/rollback`,
      { headers: { Origin: base, "content-type": "application/json" }, data: {} },
    )
    const body = await rollback.text()
    expect(body).not.toContain("failed to unpack tree object")
    expect(rollback.ok(), body).toBe(true)
  })
})
