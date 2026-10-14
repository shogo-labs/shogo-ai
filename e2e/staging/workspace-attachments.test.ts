// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "./fixtures"
import {
  makeTestUser,
  signUpAndOnboard,
  createProjectAndWait,
  NO_BUILD_PROJECT_PROMPT,
  waitForAgentResponse,
  type TestUser,
} from "./helpers"

/**
 * Workspace Attachments E2E Tests (UI-driven)
 *
 * Exercises the Folders panel → "Attached projects" flow. Two runtime models:
 *
 *   Hosted (cloud / metal): a project is online ONLY in its own runtime
 *   (`ws:proj:<id>`). Attaching B to A no longer mounts B into A's runtime;
 *   A's agent reaches B through the remote project channel — the file/exec
 *   tools take a `project` param and run inside B's own runtime.
 *
 *   Local desktop (SHOGO_LOCAL_MODE): attachments are still mounted on the
 *   host as sibling folders of an anchor-keyed merged root.
 *
 *   Basic path:
 *     1. Create anchor project A and a second project B.
 *     2. A → Settings → Folders → Add project → B; assert B attaches.
 *     3. A's agent can reach B (hosted: lists B among reachable projects;
 *        local: sees A and B as top-level folders, not the whole filesystem).
 *     4. Cross-project read: A's agent reads a file in B.
 *
 *   Complex path:
 *     5. Cross-project write: A's agent edits a file in B.
 *     6. Open B in Studio; B's own agent sees the edit.
 *     7. Hosted: A's own top-level listing has no B folder.
 *     8. Read-only attach of C: the mode still shows in the UI (local: edits
 *        to C are refused).
 *     9. Detach B; the attachment row is gone (local: B leaves the tree).
 *
 * Workspace runtimes are unconditional. The suite requires a target
 * environment with the attachments API and agent runtime available.
 *
 * Local-folder coverage (add a folder + agent reads a file in it) is
 * Electron-only: `window.shogoDesktop.pickFolders` is not present in web
 * Playwright. It is covered under the desktop harness
 * (apps/desktop/e2e/playwright.config.ts) or by stubbing the bridge with
 * page.addInitScript — see the stubbed case at the end of this file.
 *
 * Run: STAGING_URL=... \
 *   npx playwright test --config e2e/playwright.config.ts workspace-attachments
 */

const TEST_USER = makeTestUser("WorkspaceAttachments")
const RUN = Date.now().toString(36)
const WRITE_MARKER = `attached-write-ok-${RUN}`

// ── Local UI helpers ─────────────────────────────────────────────────────────

/**
 * Ensures we land on an authenticated home screen, working in both target
 * shapes:
 *   - Hosted/staging: a real `/sign-in` flow → run `signUpAndOnboard`.
 *   - Local desktop mode (SHOGO_LOCAL_MODE=true): there is no auth; the app
 *     boots straight to the home screen as "Local User", so signing up would
 *     hang waiting for a Sign Up tab that never renders. Detect the home
 *     screen first and short-circuit.
 *
 * Returns true for local desktop mode. Every hosted run starts from a fresh
 * browser context, so landing on the home screen without signing up means
 * there is no auth at all.
 */
async function ensureAuthenticated(page: Page, user: TestUser): Promise<boolean> {
  await page.goto("/")
  // A cold Playwright context loads the dev bundle on first navigation, which
  // can take far longer than a few seconds, so race the two possible shells
  // with a generous budget: the authenticated home (local mode, or an
  // already-signed-in staging session) vs. the sign-in screen's "Sign Up" tab
  // (fresh staging account).
  const home = page.getByText("What are we building", { exact: false }).first()
  const signUpTab = page.getByRole("tab", { name: "Sign Up" })
  await Promise.race([
    home.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
    signUpTab.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
  ])
  if (await home.isVisible().catch(() => false)) return true
  await signUpAndOnboard(page, user)
  return process.env.SHOGO_LOCAL_MODE === "true"
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
 * Waits out the "Restarting context…" banner if one shows. Only local desktop
 * still restarts the anchor runtime to rebuild its merged root; hosted
 * attachments change no runtime, so the banner may never appear.
 */
async function waitForRuntimeRestart(page: Page): Promise<void> {
  await page
    .getByTestId("runtime-restarting")
    .waitFor({ state: "detached", timeout: 30_000 })
    .catch(() => {})
}

/**
 * Attaches `attachedProjectId` to the currently-open project via the
 * Folders panel picker. The attachment is still recorded on hosted targets
 * (it is what the Folders UI lists), it just no longer mounts anything.
 */
async function attachProject(page: Page, attachedProjectId: string): Promise<void> {
  await page.getByTestId("attachments-add-project").click()
  await page.getByTestId("attach-picker").waitFor({ state: "visible", timeout: 5_000 })
  await page.getByTestId(`attach-pick-${attachedProjectId}`).click()
  await page
    .getByTestId(`attached-project-${attachedProjectId}`)
    .waitFor({ state: "visible", timeout: 15_000 })
  await waitForRuntimeRestart(page)
}

/**
 * Navigates fresh to a project and waits until its chat is genuinely ready to
 * drive: the pinned workspace session has been promoted to the active tab and
 * its conversation has finished loading. Navigating fresh (rather than
 * clicking the Chat tab on carried-over state) avoids the transient
 * dual-tab/"Loading conversation…" race where the pinned session is still
 * mounting alongside the prior project session.
 */
async function openProjectChat(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`)
  // The chat area shows a "Starting workspace…" gate and mounts NO composer
  // until the pinned session resolves and becomes the sole tab — so the
  // composer only appears once routing has settled. Wait for the gate to
  // clear, then the visible composer.
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
  // Enter submission is unreliable in RN-web, so we use the explicit Send
  // button (it appears once the box is non-empty). A single retry covers the
  // rare slow first paint.
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

/**
 * The transcript from the last occurrence of `prompt` onward — the prompt and
 * the agent's reply to it. Negative assertions need this: earlier turns in the
 * same chat legitimately mention the other project.
 */
async function replyTo(page: Page, prompt: string): Promise<string> {
  const text = await chatTranscript(page)
  const at = text.lastIndexOf(prompt.slice(0, 24).toLowerCase())
  return at < 0 ? text : text.slice(at)
}

test.describe("Workspace Attachments (Folders panel → project channel)", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let local = false
  let projectA = ""
  let projectB = ""
  let projectC = ""

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    local = await ensureAuthenticated(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  // ── Setup: three projects in the same workspace ────────────────────────────

  test("create anchor A and attach targets B, C", async () => {
    projectA = await createProjectReturningId(page, NO_BUILD_PROJECT_PROMPT)
    projectB = await createProjectReturningId(page, NO_BUILD_PROJECT_PROMPT)
    projectC = await createProjectReturningId(page, NO_BUILD_PROJECT_PROMPT)
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

  test("agent in A can reach B", async () => {
    await openProjectChat(page, projectA)
    if (local) {
      await sendProjectChatMessage(
        page,
        "List ONLY the top-level folder names you can see in your workspace root. " +
          "Output them as a plain list.",
      )
      await waitForAgentResponse(page)
      const text = await chatTranscript(page)
      // Merged-root subfolders are named by project id: the anchor (A) and the
      // attached project (B), and NOT the whole local projects dir / templates.
      expect(text).toContain(projectA.toLowerCase())
      expect(text).toContain(projectB.toLowerCase())
      expect(text).not.toContain("template-yc-founder-operating-system")
      return
    }
    await sendProjectChatMessage(
      page,
      "List every project you can reach in this workspace with your project tools " +
        "(connect_project / the `project` parameter). Output one line per project with its id.",
    )
    await waitForAgentResponse(page)
    expect(await chatTranscript(page)).toContain(projectB.toLowerCase())
  })

  test("cross-project READ: agent reads a file in B", async () => {
    await sendProjectChatMessage(
      page,
      local
        ? `Read the file at ${projectB}/AGENTS.md (or, if it does not exist, ` +
            `any top-level file inside the ${projectB} folder) and quote its first line back to me.`
        : `Using read_file with the project parameter set to "${projectB}", read AGENTS.md ` +
            `(or, if it does not exist, any top-level file in that project) and quote its first line back to me.`,
    )
    await waitForAgentResponse(page)
    const text = await chatTranscript(page)
    // A successful read should not surface a permission/allowlist error.
    expect(text).not.toContain("not allowed")
    expect(text).not.toContain("outside the workspace")
  })

  // ── Complex path ───────────────────────────────────────────────────────────

  test("cross-project WRITE: agent edits a file in B", async () => {
    await sendProjectChatMessage(
      page,
      local
        ? `Create a file ${projectB}/SHOGO_E2E_WRITE.md containing the single line ` +
            `"${WRITE_MARKER}", then confirm it was written.`
        : `Using write_file with the project parameter set to "${projectB}", create SHOGO_E2E_WRITE.md ` +
            `in that project's root containing the single line "${WRITE_MARKER}". ` +
            `Do not write it into your own project. Then confirm it was written.`,
    )
    await waitForAgentResponse(page)
    const text = await chatTranscript(page)
    expect(text).not.toContain("readonly")
    expect(text).not.toContain("read-only")
    expect(text).not.toContain("not allowed")
  })

  test("the edit is visible in B's own runtime", async () => {
    await openProjectChat(page, projectB)
    const prompt =
      "Read the file SHOGO_E2E_WRITE.md in your workspace root and quote its full contents verbatim."
    await sendProjectChatMessage(page, prompt)
    await waitForAgentResponse(page)
    expect(await replyTo(page, prompt)).toContain(WRITE_MARKER)
  })

  test("A's own top-level listing has no B folder", async () => {
    test.skip(local, "local desktop still mounts attached projects into the merged root")
    await openProjectChat(page, projectA)
    const prompt =
      "Without using the project parameter, list ONLY the top-level entries of your own " +
      "workspace root as a plain list. Do not mention any other project."
    await sendProjectChatMessage(page, prompt)
    await waitForAgentResponse(page)
    const reply = await replyTo(page, prompt)
    expect(reply).not.toContain(projectB.toLowerCase())
    expect(reply).not.toContain("shogo_e2e_write.md")
  })

  test("read-only attach of C: the mode is shown (and enforced on local desktop)", async () => {
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
    await waitForRuntimeRestart(page)

    // Hosted: the attachment mode is recorded and shown, but no longer
    // restricts anything — the project channel reaches every project in the
    // workspace with the caller's own permissions, so there is no write
    // refusal to assert.
    if (!local) return

    // Local desktop: READONLY_ROOTS is seeded at boot, so the restart above is
    // the gate that the readonly runtime is up.
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

  test("detach B; the attachment is gone", async () => {
    await page.goto(`/projects/${projectA}`)
    await openFoldersPanel(page)
    await page.getByTestId(`detach-project-${projectB}`).click()
    await expect(page.getByTestId(`attached-project-${projectB}`)).toHaveCount(0, {
      timeout: 15_000,
    })
    await waitForRuntimeRestart(page)
    // Hosted: nothing was mounted, so there is no tree to re-check.
    if (!local) return

    await openProjectChat(page, projectA)
    const prompt = "List ONLY the top-level folder names in your workspace root as a plain list."
    await sendProjectChatMessage(page, prompt)
    await waitForAgentResponse(page)
    const reply = await replyTo(page, prompt)
    expect(reply).toContain(projectA.toLowerCase())
    expect(reply).not.toContain(projectB.toLowerCase())
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
    !STUB_DIR,
    "Local-folder UI coverage needs a host path in E2E_LOCAL_FOLDER_STUB " +
      "to feed the stubbed pickFolders bridge.",
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
    projectId = await createProjectReturningId(page, NO_BUILD_PROJECT_PROMPT)
    await page.goto(`/projects/${projectId}`)
    await openFoldersPanel(page)

    await page.getByTestId("folders-add-folder").click()
    // The folder is keyed by id we don't know up front, so assert that a
    // linked-folder row appeared and the restart state resolved.
    await expect(page.locator('[data-testid^="linked-folder-"]')).toHaveCount(1, {
      timeout: 15_000,
    })
    await waitForRuntimeRestart(page)
  })
})
