// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type FrameLocator, type Page } from "./fixtures"
import {
  canRecycleViaApi,
  createProjectAndWait,
  makeTestUser,
  recycleRuntimeViaApi,
  signUpAndOnboard,
  waitForAgentIdle,
  waitForAgentResponse,
  type TestUser,
} from "./helpers"

/**
 * Runtime recycle E2E (metal)
 *
 * Guards the support fix for a stuck runtime (API server wedged on its port):
 * a recycle must bring the project back on a clean cold boot WITHOUT losing
 * its code or its database.
 *
 *   1. Create a project whose page lists notes from its own API server and
 *      database, with a form to add one.
 *   2. Add a note through the preview with a per-run unique title the agent
 *      never saw, so it can only come back from the database.
 *   3. Recycle. Expect 200, every backup step ok, the runtime destroyed, and
 *      the cold-booted API server ready.
 *   4. Reopen the project: the code marker and the note must both render.
 *
 * Recycles through the e2e backdoor (`SHOGO_E2E_BOOTSTRAP_SECRET`) or, without
 * it, as a super-admin (`E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`) through
 * POST /api/admin/runtimes/recycle. Skips when neither is set, or when the
 * project is not on a metal runtime.
 *
 * Run: E2E_TARGET_URL=... E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
 *   npx playwright test --config e2e/playwright.config.ts runtime-recycle
 */

const TEST_USER = makeTestUser("RuntimeRecycle")

const PREVIEW_BOOT_TIMEOUT_MS = 180_000
const PREVIEW_CONTENT_TIMEOUT_MS = 90_000

const RUN = Date.now().toString(36)
const CODE_MARKER = `Recycle Notes ${RUN}`
const NOTE_MARKER = `note-${RUN}-${Math.random().toString(36).slice(2, 8)}`

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

/**
 * Refresh the preview until `text` renders. The preview does not reload on its
 * own after source edits or a runtime restart, so the test drives it.
 */
async function expectPreviewText(page: Page, text: string): Promise<void> {
  await page
    .getByTestId("canvas-preview-iframe")
    .waitFor({ state: "attached", timeout: PREVIEW_BOOT_TIMEOUT_MS })
  const deadline = Date.now() + PREVIEW_CONTENT_TIMEOUT_MS
  let lastErr: unknown
  while (Date.now() < deadline) {
    await page.getByLabel("Refresh preview").first().click({ force: true }).catch(() => {})
    const ok = await previewFrame(page)
      .getByText(text, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch((e) => {
        lastErr = e
        return false
      })
    if (ok) return
    await page.waitForTimeout(2_000)
  }
  throw new Error(`preview never rendered "${text}": ${String(lastErr)}`)
}

async function addNoteInPreview(page: Page, title: string): Promise<void> {
  const frame = previewFrame(page)
  const input = frame.getByPlaceholder("New note").first()
  await input.waitFor({ state: "visible", timeout: PREVIEW_CONTENT_TIMEOUT_MS })
  await input.fill(title)
  await frame.getByRole("button", { name: "Add" }).first().click()
  await frame
    .getByText(title, { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
}

test.describe("Runtime recycle", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await ensureAuthenticated(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("recycle keeps code and database, and the API comes back", async () => {
    test.setTimeout(1_200_000)
    test.skip(
      !canRecycleViaApi(),
      "needs SHOGO_E2E_BOOTSTRAP_SECRET or super-admin E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD",
    )

    // 1. A project with its own API server and database.
    await createProjectAndWait(
      page,
      `Build a single-page notes app backed by the project's API server and database. ` +
        `Add a Note model with a title field. The page shows an <h1> with the exact text ` +
        `"${CODE_MARKER}", a text input with the placeholder "New note", a button labelled ` +
        `"Add" that saves the note through the API, and a list of every saved note title ` +
        `loaded from the API. Nothing else.`,
    )
    const m = page.url().match(/\/projects\/([^/?#]+)/)
    expect(m, `expected a /projects/<id> URL, got ${page.url()}`).toBeTruthy()
    const projectId = m![1]
    await waitForAgentResponse(page, 600_000)
    await waitForAgentIdle(page, 600_000)
    await expectPreviewText(page, CODE_MARKER)

    // 2. A row only the database knows about.
    await addNoteInPreview(page, NOTE_MARKER)

    // 3. Recycle.
    const r = await recycleRuntimeViaApi(page, projectId)
    test.skip(r === null, "recycle-runtime backdoor unavailable on this environment")
    test.skip(r!.status === 404, `project ${projectId} is not on a metal runtime`)
    expect(r!.status, JSON.stringify(r!.body)).toBe(200)
    const recycled = (r!.body.results ?? []).filter((x) => x.found)
    expect(recycled.length).toBeGreaterThan(0)
    for (const t of recycled) {
      expect(t.ok, `${t.key}: ${JSON.stringify(t.report?.steps)}`).toBe(true)
      const steps = t.report?.steps ?? []
      expect(steps.every((s) => s.ok), JSON.stringify(steps)).toBe(true)
      expect(steps.map((s) => s.step)).toContain("destroy")
      expect(steps.map((s) => s.step)).toContain("data")
    }
    expect(r!.body.coldBoot?.apiReady, JSON.stringify(r!.body.coldBoot)).toBe(true)

    // 4. Reopen from scratch: the code and the note must both survive.
    await page.goto("/")
    await page.waitForSelector("text=What are we building", { timeout: 30_000 })
    await page.goto(`/projects/${projectId}`)
    await expectPreviewText(page, CODE_MARKER)
    await expectPreviewText(page, NOTE_MARKER)
  })
})
