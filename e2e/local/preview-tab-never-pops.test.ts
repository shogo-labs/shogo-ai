// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-200 part D — a folder project's Preview must stop taking itself over.
 *
 * The pop is a client decision, so the flapping input is driven at the seam the
 * client actually reads (`GET /api/projects/:id/external-preview`): the API-side
 * stability rules have their own unit tests, what a unit test cannot show is a
 * browser session staying put.
 *
 * The assertion is on *pane content*, not on tab chrome: the wide shell renders
 * more than one tab strip and only the preview surface itself says unambiguously
 * that Preview is on screen (its address bar). The desktop preview bridge is
 * stubbed because the auto-open only arms when `window.shogoDesktop.preview`
 * exists — an embedded webview the browser does not have.
 *
 * Needs the local stack:
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts preview-tab-never-pops
 */
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:8002"
/** The layout's external-preview poll. */
const POLL_MS = 5_000

async function apiJson(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(`${API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    data: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status(), json }
}

/** A project runtime needs the built runtime template, which the local stack
 *  does not have; the project page otherwise sits on "Starting your project…"
 *  and never renders its chrome. */
async function stubProjectRuntime(page: Page) {
  const body = JSON.stringify({
    ready: true,
    status: "running",
    agentUrl: `${API}/stub-agent`,
    url: `${API}/stub-preview`,
    canvasBaseUrl: `${API}/stub-preview`,
  })
  await page.route("**/api/projects/*/sandbox/url", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body }),
  )
  await page.route("**/api/projects/*/agent-proxy/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  )
}

/**
 * The embedded preview webview the auto-open gates on. It must *add* `preview`
 * to whatever the page installs, never replace the whole `shogoDesktop` object:
 * the rest of the shell calls sibling methods (`getRecordingStatus`, …) and a
 * partial stub takes the root error boundary down.
 */
async function stubDesktopPreviewBridge(page: Page) {
  await page.addInitScript(() => {
    const preview = {
      load: async () => undefined,
      setBounds: async () => undefined,
      setVisible: async () => undefined,
      reload: async () => undefined,
      goBack: async () => undefined,
      goForward: async () => undefined,
      capture: async () => null,
      getState: async () => ({
        url: null,
        canGoBack: false,
        canGoForward: false,
        loading: false,
        visible: true,
      }),
      onEvent: () => () => {},
    }
    let bridge: any = { preview }
    Object.defineProperty(window, "shogoDesktop", {
      configurable: true,
      get: () => bridge,
      set: (value: any) => {
        bridge = { ...(value ?? {}), preview: value?.preview ?? preview }
      },
    })
  })
}

/** Serve whatever `current.detectedUrl` holds on every poll. */
async function driveDetectedUrl(page: Page, current: { detectedUrl: string | null }) {
  await page.route("**/api/projects/*/external-preview", async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        projectId: "stub",
        workingMode: "external",
        savedUrl: null,
        detectedUrl: current.detectedUrl,
        detections: [],
        attributedPorts: [],
      }),
    })
  })
}

/**
 * Is the Preview surface on screen? The wide shell has more than one tab strip
 * and only the preview surface itself answers unambiguously, so this is its
 * address bar — or the panel's own boundary, because the webview under the
 * bridge stub is expected to fail without a real Electron host. Either way the
 * pane mounted, which is what "the tab changed" means.
 */
const previewSurface = (page: Page): Locator =>
  page.getByLabel("Open in system browser").or(page.getByText("ExternalPreview encountered an error"))

async function expectPreviewHidden(page: Page) {
  await expect(previewSurface(page)).toHaveCount(0)
}

const composer = (page: Page): Locator =>
  page.getByRole("textbox", { name: "Chat message input" }).first()

async function settle(page: Page) {
  await page.waitForTimeout(POLL_MS + 1_500)
}

async function createFolderProject(page: Page, name: string): Promise<string> {
  const folder = resolve(__dirname, `../../test-results/sho-200-${name}`)
  mkdirSync(folder, { recursive: true })
  const res = await apiJson(page, "POST", "/api/local/projects/from-folders", {
    paths: [folder],
    acceptedGitRoot: false,
  })
  expect(res.status, `from-folders: ${JSON.stringify(res.json)}`).toBe(201)
  const id = res.json?.project?.id
  expect(id, "folder project id").toBeTruthy()
  return id
}

/** The chat pane is what the user is looking at, so it must be on screen —
 *  without it, "Preview did not appear" would be vacuous. */
async function waitForProjectShell(page: Page, projectId: string, query = "") {
  await page.goto(`/projects/${encodeURIComponent(projectId)}${query}`)
  await composer(page).waitFor({ state: "visible", timeout: 120_000 })
}

test.describe("Preview tab auto-open (local)", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 1440, height: 900 } })

  let projectId = ""

  test.beforeEach(async ({ page }) => {
    await stubProjectRuntime(page)
    await stubDesktopPreviewBridge(page)
    await page.goto("/")
    await page
      .getByRole("navigation", { name: "App sidebar" })
      .first()
      .waitFor({ timeout: 120_000 })
  })

  test.afterEach(async ({ page }) => {
    if (projectId) await page.request.delete(`${API}/api/projects/${projectId}`).catch(() => {})
    projectId = ""
  })

  // The control: proves the harness can see the pop at all. A folder project
  // whose dev server appears with no user intent yet must bring Preview forward.
  test("a dev server appearing brings Preview forward once", async ({ page }) => {
    const current: { detectedUrl: string | null } = { detectedUrl: null }
    await driveDetectedUrl(page, current)
    projectId = await createFolderProject(page, "control")

    await waitForProjectShell(page, projectId)
    await expectPreviewHidden(page)

    current.detectedUrl = "http://127.0.0.1:5301"
    await expect(previewSurface(page).first()).toBeVisible({ timeout: 40_000 })
  })

  /**
   * S1/S2/S3/S4/S5 — not yet expressible, and here is the finding.
   *
   * The flap path itself works in the harness: the control above drives the pop.
   * What has no answer yet is *what "the tab changed" means in the wide shell*.
   * On a folder project the wide layout keeps Chat and Preview on screen at the
   * same time, `effectiveTab` stays `external-preview` once the project is
   * external (the landing policy writes `navTab=external-preview` and rewrites
   * the incoming `?tab=`), and the Preview surface's own visibility tracks the
   * *detected URL*, not the tab — so "did Preview take the tab back" cannot be
   * read from either the pane or the tab strip at this viewport. On a phone
   * viewport, where tabs are exclusive, the auto-open is deliberately off
   * (`phone-layout`), so the same assertion would be vacuous.
   *
   * The client gate itself is covered by the state-machine unit tests
   * (`apps/mobile/lib/__tests__/preview-auto-open.test.ts`, S1-S5) and by the
   * observer/route suites on the API side. Whoever picks this up needs a
   * decision on the wide-shell tab model first — that is a product call, not a
   * test-harness detail.
   */
  test.fixme("a flapping dev server never re-opens Preview over the user's tab", async () => {})

  // D — a managed project has no Preview tab and nothing in the idle path may
  // move the user off the tab they chose.
  test("a managed project's tab is never switched while the page sits idle", async ({ page }) => {
    const workspaces = await apiJson(page, "GET", "/api/workspaces")
    const list =
      workspaces.json?.items ?? workspaces.json?.data ?? workspaces.json?.workspaces ?? workspaces.json
    const rows = Array.isArray(list) ? list : []
    const workspace =
      rows.find((row: { kind?: string }) => row.kind === "personal") ?? rows[0]
    const workspaceId = workspace?.id
    expect(workspaceId, `workspaces: ${JSON.stringify(workspaces.json)}`).toBeTruthy()
    const created = await apiJson(page, "POST", "/api/projects", {
      name: "SHO-200 idle",
      workspaceId,
      accessLevel: "anyone",
      status: "draft",
      schemas: [],
      settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
    })
    projectId = created.json?.data?.id ?? created.json?.id
    expect(projectId, `create project: ${JSON.stringify(created.json)}`).toBeTruthy()

    await page.goto(`/projects/${encodeURIComponent(projectId)}?tab=chat-fullscreen`)
    await composer(page).waitFor({ state: "visible", timeout: 120_000 })

    await page.waitForTimeout(20_000)
    await expect(composer(page)).toBeVisible()
    await expectPreviewHidden(page)
  })
})
