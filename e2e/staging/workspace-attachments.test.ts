// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import {
  makeTestUser,
  signUpAndOnboard,
  createProjectAndWait,
  waitForAgentResponse,
  type TestUser,
} from "./helpers"

/**
 * Workspace Attachments E2E Tests (UI-driven)
 *
 * Exercises the Folders panel → "Attached projects" flow that converges
 * every project onto its anchor-keyed merged-root workspace runtime:
 *
 *   Basic path (project attachments only, web-reachable):
 *     1. Create anchor project A and a second project B.
 *     2. A → Settings → Folders → Add project → B; assert B attaches and
 *        the "Restarting context…" state resolves.
 *     3. In A's chat, ask the agent to list top-level folders; assert it
 *        sees BOTH A and B (proves the anchor-scoped merged root) and not
 *        the whole filesystem — the original `ls -la` symptom.
 *     4. Cross-project read: ask the agent to read a file in B.
 *
 *   Complex path:
 *     5. Cross-project write (readwrite attach): edit a file in B.
 *     6. Readonly enforcement: attach C as read-only; an edit to C is
 *        refused while a read succeeds.
 *     7. Detach B; after the restart B is gone from the merged tree.
 *
 * This whole suite depends on the workspace-runtime rollout flag being on
 * in the target environment (SHOGO_WORKSPACE_RUNTIME /
 * EXPO_PUBLIC_WORKSPACE_RUNTIME). When the flag is off, project chat uses
 * the legacy single-project runtime and there are no attachments, so the
 * suite skips cleanly. Set E2E_WORKSPACE_RUNTIME=true when running against
 * a flag-on env.
 *
 * Local-folder coverage (add a folder + agent reads a file in it) is
 * Electron-only: `window.shogoDesktop.pickFolders` is not present in web
 * Playwright. It is covered under the desktop harness
 * (apps/desktop/e2e/playwright.config.ts) or by stubbing the bridge with
 * page.addInitScript — see the stubbed case at the end of this file.
 *
 * Run: STAGING_URL=... E2E_WORKSPACE_RUNTIME=true \
 *   npx playwright test --config e2e/playwright.config.ts workspace-attachments
 */

const WORKSPACE_RUNTIME_ENABLED =
  process.env.EXPO_PUBLIC_WORKSPACE_RUNTIME === "true" ||
  process.env.SHOGO_WORKSPACE_RUNTIME === "true" ||
  process.env.E2E_WORKSPACE_RUNTIME === "true"

const TEST_USER = makeTestUser("WorkspaceAttachments")

// ── Local UI helpers ─────────────────────────────────────────────────────────

/**
 * Ensures we land on an authenticated home screen, working in both target
 * shapes:
 *   - Hosted/staging: a real `/sign-in` flow → run `signUpAndOnboard`.
 *   - Local desktop mode (SHOGO_LOCAL_MODE=true): there is no auth; the app
 *     boots straight to the home screen as "Local User", so signing up would
 *     hang waiting for a Sign Up tab that never renders. Detect the home
 *     screen first and short-circuit.
 */
async function ensureAuthenticated(page: Page, user: TestUser): Promise<void> {
  await page.goto("/")
  // A cold Playwright context loads the dev bundle on first navigation, which
  // can take far longer than a few seconds, so race the two possible shells
  // with a generous budget: the authenticated home (local mode, or an
  // already-signed-in staging session) vs. the sign-in screen's "Sign Up" tab
  // (fresh staging account).
  const home = page.getByText("What's on your mind", { exact: false }).first()
  const signUpTab = page.getByRole("tab", { name: "Sign Up" })
  await Promise.race([
    home.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
    signUpTab.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
  ])
  if (await home.isVisible().catch(() => false)) return
  await signUpAndOnboard(page, user)
}

/**
 * Creates a project from the home composer and returns its project id,
 * parsed out of the `/projects/<id>` URL we land on. Reuses the shared
 * `createProjectAndWait` so we wait through the initial build stream.
 */
async function createProjectReturningId(page: Page, prompt: string): Promise<string> {
  await createProjectAndWait(page, prompt)
  const m = page.url().match(/\/projects\/([^/?#]+)/)
  expect(m, `expected a /projects/<id> URL, got ${page.url()}`).toBeTruthy()
  return m![1]
}

/**
 * Opens the project's Settings → Folders panel using the stable testIDs we
 * added (`project-tab-settings`, `settings-nav-folders`). Leaves the
 * FoldersPanel visible.
 */
async function openFoldersPanel(page: Page): Promise<void> {
  const settingsTab = page
    .getByTestId("project-tab-settings")
    .or(page.getByLabel("Settings", { exact: true }))
    .first()
  await settingsTab.waitFor({ state: "visible", timeout: 15_000 })
  await settingsTab.click()

  const foldersNav = page.getByTestId("settings-nav-folders").first()
  await foldersNav.waitFor({ state: "visible", timeout: 10_000 })
  await foldersNav.click()

  await page.getByTestId("folders-panel").waitFor({ state: "visible", timeout: 10_000 })
}

/**
 * Attaches `attachedProjectId` to the currently-open project via the
 * Folders panel picker, then waits for the optimistic "Restarting context…"
 * state to resolve (best-effort — it may be too quick to observe).
 */
async function attachProject(page: Page, attachedProjectId: string): Promise<void> {
  await page.getByTestId("attachments-add-project").click()
  await page.getByTestId("attach-picker").waitFor({ state: "visible", timeout: 5_000 })
  await page.getByTestId(`attach-pick-${attachedProjectId}`).click()
  await page
    .getByTestId(`attached-project-${attachedProjectId}`)
    .waitFor({ state: "visible", timeout: 15_000 })
  // The "Restarting context…" banner now polls the runtime-status endpoint and
  // only clears once the anchor runtime reports healthy again — so waiting for
  // it to detach is a real readiness gate (no sleeps): subsequent chat is
  // guaranteed to hit the rebuilt/rebooted merged root.
  await page
    .getByTestId("runtime-restarting")
    .waitFor({ state: "detached", timeout: 30_000 })
    .catch(() => {})
}

/**
 * Navigates fresh to a project and waits until its chat is genuinely ready to
 * drive: the pinned workspace session has been promoted to the active tab and
 * its conversation has finished loading. Navigating fresh (rather than
 * clicking the Chat tab on carried-over state) avoids the transient
 * dual-tab/"Loading conversation…" race where the pinned session is still
 * mounting alongside the prior project session. Also picks up any merged-root
 * changes from a just-completed attach/detach, since the runtime refreshes its
 * symlinks on resolve.
 */
async function openProjectChat(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`)
  // Flag-on, the chat area shows a "Starting workspace…" gate and mounts NO
  // composer until the anchor-pinned session resolves and becomes the sole
  // tab — so the composer only appears once routing has settled (no async
  // tab-swap / fill-wipe race to wait out). Wait for the gate to clear, then
  // the visible composer.
  await page
    .getByTestId("workspace-chat-loading")
    .waitFor({ state: "detached", timeout: 30_000 })
    .catch(() => {})
  await visibleComposer(page).waitFor({ state: "visible", timeout: 30_000 })
  await page
    .getByText("Loading conversation...", { exact: false })
    .first()
    .waitFor({ state: "detached", timeout: 30_000 })
    .catch(() => {})
  await waitForAgentResponse(page)
}

/** The currently-visible project chat composer (there can be a hidden,
 * still-loading sibling tab, so we must filter to the visible one). */
function visibleComposer(page: Page) {
  return page
    .getByRole("textbox", { name: "Chat message input" })
    .filter({ visible: true })
    .first()
}

/**
 * Sends a message into the *project* chat composer. The shared
 * `sendChatMessage` helper targets the home screen's `home-composer-input`,
 * which does not exist inside a project — the project ChatPanel renders
 * `ChatInput` (testID `project-composer-input`, accessibilityLabel
 * "Chat message input"). Mirrors `sendChatMessage`'s fill + Enter flow.
 */
async function sendProjectChatMessage(page: Page, text: string): Promise<void> {
  // With the deterministic single-session routing (Phase 1) the composer no
  // longer re-mounts out from under us, so this is a straightforward
  // fill → click "Send message" → confirm-by-transcript. Enter submission is
  // unreliable in RN-web, so we use the explicit Send button (it appears once
  // the box is non-empty). A single retry covers the rare slow first paint.
  const snippet = text.slice(0, 24)
  for (let attempt = 0; attempt < 2; attempt++) {
    const box = visibleComposer(page)
    await box.waitFor({ state: "visible", timeout: 15_000 })
    await box.fill(text)
    await page
      .getByRole("button", { name: "Send message" })
      .filter({ visible: true })
      .first()
      .click({ force: true })
    const landed = await page
      .getByText(snippet, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false)
    if (landed) return
  }
  throw new Error("sendProjectChatMessage: message never appeared in the transcript")
}

/** Returns the concatenated visible text of the chat transcript. */
async function chatTranscript(page: Page): Promise<string> {
  return (await page.locator("body").innerText()).toLowerCase()
}

test.describe("Workspace Attachments (Folders panel → merged runtime)", () => {
  test.describe.configure({ mode: "serial" })
  test.skip(
    !WORKSPACE_RUNTIME_ENABLED,
    "Requires the workspace-runtime rollout flag (SHOGO_WORKSPACE_RUNTIME / " +
      "EXPO_PUBLIC_WORKSPACE_RUNTIME). Set E2E_WORKSPACE_RUNTIME=true when the " +
      "target env has it on.",
  )

  let page: Page
  let projectA = ""
  let projectB = ""
  let projectC = ""

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await ensureAuthenticated(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  // ── Setup: three projects in the same workspace ────────────────────────────

  test("create anchor A and attach targets B, C", async () => {
    projectA = await createProjectReturningId(page, "Anchor project A for attachment tests")
    projectB = await createProjectReturningId(page, "Target project B with a readme")
    projectC = await createProjectReturningId(page, "Target project C read-only")
    expect(projectA).not.toBe(projectB)
    expect(projectB).not.toBe(projectC)
  })

  // ── Basic path ─────────────────────────────────────────────────────────────

  test("attach B to A via the Folders panel", async () => {
    await page.goto(`/projects/${projectA}`)
    await openFoldersPanel(page)
    await attachProject(page, projectB)
    await expect(page.getByTestId(`attached-project-${projectB}`)).toBeVisible()
  })

  test("agent in A sees only the anchor-scoped merged root (A + B)", async () => {
    await openProjectChat(page, projectA)
    await sendProjectChatMessage(
      page,
      "List ONLY the top-level folder names you can see in your workspace root. " +
        "Output them as a plain list.",
    )
    await waitForAgentResponse(page)

    const text = await chatTranscript(page)
    // Merged-root subfolders are named by project id. The agent must see
    // both the anchor (A) and the attached project (B)…
    expect(text).toContain(projectA)
    expect(text).toContain(projectB)
    // …and must NOT be staring at the whole local projects dir / templates,
    // which was the original `ls -la` regression this feature fixes.
    expect(text).not.toContain("template-yc-founder-operating-system")
  })

  test("cross-project READ: agent reads a file in B", async () => {
    await sendProjectChatMessage(
      page,
      `Read the file at ${projectB}/AGENTS.md (or, if it does not exist, ` +
        `any top-level file inside the ${projectB} folder) and quote its first line back to me.`,
    )
    await waitForAgentResponse(page)
    const text = await chatTranscript(page)
    // A successful read should not surface a permission/allowlist error.
    expect(text).not.toContain("not allowed")
    expect(text).not.toContain("outside the workspace")
  })

  // ── Complex path ───────────────────────────────────────────────────────────

  test("cross-project WRITE: agent edits a file in B (readwrite attach)", async () => {
    await sendProjectChatMessage(
      page,
      `Create a file ${projectB}/SHOGO_E2E_WRITE.md containing the single line ` +
        `"attached-write-ok", then confirm it was written.`,
    )
    await waitForAgentResponse(page)
    const text = await chatTranscript(page)
    expect(text).not.toContain("readonly")
    expect(text).not.toContain("read-only")
    expect(text).toContain("attached-write-ok")
  })

  test("readonly enforcement: attach C read-only, edits are refused", async () => {
    await page.goto(`/projects/${projectA}`)
    await openFoldersPanel(page)
    await attachProject(page, projectC)
    // Flip C to read-only. Assert on the EXACT status label — a substring
    // match on "Read-only" also hits the toggle button ("Make read-only") and
    // can hit the project's display name (the agent may name a project
    // something like "Read-Only Access"), tripping Playwright strict mode.
    await page.getByTestId(`toggle-mode-${projectC}`).click()
    await expect(
      page.getByTestId(`attached-project-${projectC}`).getByText("Read-only", { exact: true }),
    ).toBeVisible({ timeout: 10_000 })
    // READONLY_ROOTS is seeded at boot, so flipping to read-only forces an
    // env-coupled restart. The banner clears on real readiness (status poll),
    // so this wait is the gate that the readonly runtime is up before we
    // assert the write is refused — no sleep needed.
    await page
      .getByTestId("runtime-restarting")
      .waitFor({ state: "detached", timeout: 30_000 })
      .catch(() => {})

    await openProjectChat(page, projectA)
    // A read of C should still work…
    await sendProjectChatMessage(
      page,
      `List the top-level files inside the ${projectC} folder.`,
    )
    await waitForAgentResponse(page)
    let text = await chatTranscript(page)
    expect(text).not.toContain("not allowed")

    // …but a write must be blocked by the runtime (READONLY_ROOTS).
    await sendProjectChatMessage(
      page,
      `Create a file ${projectC}/SHOGO_E2E_SHOULD_FAIL.md with the text "nope".`,
    )
    await waitForAgentResponse(page)
    text = await chatTranscript(page)
    expect(text).toMatch(/read-?only|not allowed|denied|cannot write|permission/)
  })

  test("detach B; after restart B is gone from the merged tree", async () => {
    await page.goto(`/projects/${projectA}`)
    await openFoldersPanel(page)
    await page.getByTestId(`detach-project-${projectB}`).click()
    await expect(page.getByTestId(`attached-project-${projectB}`)).toHaveCount(0, {
      timeout: 15_000,
    })
    await page
      .getByTestId("runtime-restarting")
      .waitFor({ state: "detached", timeout: 30_000 })
      .catch(() => {})

    await openProjectChat(page, projectA)
    await sendProjectChatMessage(
      page,
      "List ONLY the top-level folder names in your workspace root as a plain list.",
    )
    await waitForAgentResponse(page)
    const text = await chatTranscript(page)
    expect(text).toContain(projectA)
    expect(text).not.toContain(projectB)
  })
})

// ── Local-folder coverage (stubbed desktop bridge) ───────────────────────────

/**
 * The "add a local folder + agent reads a file in it" path uses the
 * Electron-only `window.shogoDesktop.pickFolders` picker, which is absent in
 * web Playwright. We cover the UI half here by injecting a fake bridge with
 * page.addInitScript before the app loads, so the "Add folder" button is
 * reachable and the panel records the linked folder.
 *
 * The agent-side read of a file inside that folder is only meaningful under
 * the real desktop harness (apps/desktop/e2e/playwright.config.ts), where
 * the runtime can actually symlink and serve the host path; this web case
 * asserts the UI wiring only and is skipped unless a stub dir is provided
 * via E2E_LOCAL_FOLDER_STUB.
 */
test.describe("Workspace Attachments — local folder (stubbed bridge)", () => {
  test.describe.configure({ mode: "serial" })
  const STUB_DIR = process.env.E2E_LOCAL_FOLDER_STUB
  test.skip(
    !WORKSPACE_RUNTIME_ENABLED || !STUB_DIR,
    "Local-folder UI coverage needs the workspace-runtime flag and a host " +
      "path in E2E_LOCAL_FOLDER_STUB to feed the stubbed pickFolders bridge.",
  )

  const LOCAL_USER = makeTestUser("WorkspaceLocalFolder")
  let page: Page
  let projectId = ""

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    // Inject a fake desktop bridge BEFORE any app code runs so FoldersPanel
    // detects pickFolders support and the "Add folder" CTA is enabled.
    await page.addInitScript((dir) => {
      // @ts-expect-error — test-only shim of the Electron preload bridge.
      window.shogoDesktop = {
        ...(window as any).shogoDesktop,
        pickFolders: async () => [dir],
      }
    }, STUB_DIR)
    await ensureAuthenticated(page, LOCAL_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("link a local folder via the stubbed picker", async () => {
    projectId = await createProjectReturningId(page, "Project that links a local folder")
    await page.goto(`/projects/${projectId}`)
    await openFoldersPanel(page)

    await page.getByTestId("folders-add-folder").click()
    // The folder is keyed by id we don't know up front, so assert that a
    // linked-folder row appeared and the restart state resolved.
    await expect(page.locator('[data-testid^="linked-folder-"]')).toHaveCount(1, {
      timeout: 15_000,
    })
    await page
      .getByTestId("runtime-restarting")
      .waitFor({ state: "detached", timeout: 30_000 })
      .catch(() => {})
  })
})
