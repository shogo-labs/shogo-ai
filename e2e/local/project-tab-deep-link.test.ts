// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-174 — cold load of `/projects/<id>?tab=<tab>` must land on that tab.
 *
 * Before the fix, expo-router's `getStateFromPath` placed the URL query on
 * the leaf route (`projects/[id]/index`) while `_layout.tsx` read
 * `useLocalSearchParams` (the layout's own segment), so `tab`, `file` and
 * every other arrival param were undefined on a cold load.
 *
 * Tests here drive the real UI through cold loads (`page.goto`) and verify
 * the tab is active, the URL is kept, and hard reloads are stable.
 *
 * Needs the local stack:
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts project-tab-deep-link
 */
import { expect, test, type Page } from "@playwright/test"
import { writeActiveWorkspaceSelection } from "./helpers"

const API = process.env.E2E_API_URL || "http://localhost:8002"

let workspaceId = ""
let projectId = ""

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

async function stubProjectRuntime(page: Page) {
  await page.route("**/api/projects/*/sandbox/url", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ready: true,
        status: "running",
        agentUrl: `${API}/stub-agent`,
        url: `${API}/stub-preview`,
        canvasBaseUrl: `${API}/stub-preview`,
      }),
    })
  })
  await page.route("**/api/projects/*/agent-proxy/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  )
}

async function useTeamWorkspace(page: Page) {
  await page.evaluate(writeActiveWorkspaceSelection, [workspaceId, "team"] as const)
}

async function prepare(page: Page) {
  await stubProjectRuntime(page)
  await page.goto("/")
  await page.getByRole("navigation", { name: "App sidebar" }).first().waitFor({ timeout: 120_000 })
  await useTeamWorkspace(page)
}

/** Installs a history-API sniffer and console collector before any page script runs. */
async function installInstrumentation(page: Page): Promise<() => Promise<string>> {
  const consoleLogs: string[] = []

  await page.addInitScript(() => {
    const record = (method: string, url: string | URL) => {
      const entry = `${Date.now()} ${method} ${url}`
      ;(window as any).__sho174History = (window as any).__sho174History ?? []
      ;(window as any).__sho174History.push(entry)
    }
    const orig = { push: history.pushState.bind(history), replace: history.replaceState.bind(history) }
    history.pushState = function (data, title, url) {
      record("push", url ?? location.href)
      orig.push(data, title, url)
    }
    history.replaceState = function (data, title, url) {
      record("replace", url ?? location.href)
      orig.replace(data, title, url)
    }
  })

  page.on("console", (msg) => {
    if (msg.text().includes("SHO174")) consoleLogs.push(msg.text())
  })

  return async () => {
    const browserHistory: string[] = await page
      .evaluate(() => (window as any).__sho174History ?? [])
      .catch(() => [])
    return [
      "=== SHO-174 instrumentation ===",
      "--- history writes ---",
      ...browserHistory,
      "--- console (SHO174) ---",
      ...consoleLogs,
    ].join("\n")
  }
}

/** Tab param from the current URL. */
function tabParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get("tab")
}

test.describe("Project tab deep link (local, SHO-174)", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 1440, height: 900 } })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await stubProjectRuntime(page)
    await page.goto("/")
    await page.getByRole("navigation", { name: "App sidebar" }).first().waitFor({ timeout: 120_000 })

    const suffix = Date.now().toString(36)
    const workspace = await apiJson(page, "POST", "/api/workspaces", { name: `QA tab deeplink ${suffix}`, kind: "team" })
    workspaceId = workspace.json?.data?.id ?? workspace.json?.id
    expect(workspaceId, JSON.stringify(workspace.json)).toBeTruthy()

    const project = await apiJson(page, "POST", "/api/projects", {
      name: `QA tab deeplink ${suffix}`,
      workspaceId,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
      schemas: [],
      settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
    })
    projectId = project.json?.data?.id ?? project.json?.id
    expect(projectId, JSON.stringify(project.json)).toBeTruthy()

    await page.close()
  })

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage()
    if (projectId) await page.request.delete(`${API}/api/projects/${projectId}`).catch(() => {})
    if (workspaceId) await page.request.delete(`${API}/api/workspaces/${workspaceId}`).catch(() => {})
    await page.close()
  })

  test("cold load ?tab=settings lands on Settings (AC1 of SHO-174)", async ({ page }) => {
    const getLog = await installInstrumentation(page)
    await prepare(page)
    await page.goto(`/projects/${projectId}?tab=settings`)
    // settings-nav-machine is the unique test-id inside SettingsPanel
    try {
      await page.getByTestId("settings-nav-machine").waitFor({ state: "visible", timeout: 60_000 })
    } finally {
      console.log(await getLog())
    }
    // The URL should still carry the tab (mirror writes chatSessionId but
    // must not drop tab; check it is preserved)
    await expect.poll(() => tabParam(page), { timeout: 10_000 }).toBe("settings")
  })

  test("hard reload of a settings URL stays on Settings", async ({ page }) => {
    await prepare(page)
    await page.goto(`/projects/${projectId}?tab=settings`)
    await page.getByTestId("settings-nav-machine").waitFor({ state: "visible", timeout: 60_000 })

    await page.reload()
    await page.getByTestId("settings-nav-machine").waitFor({ state: "visible", timeout: 60_000 })
    expect(tabParam(page)).toBe("settings")
  })

  test("cold load ?tab=files lands on Files panel (AC1)", async ({ page }) => {
    await prepare(page)
    await page.goto(`/projects/${projectId}?tab=files`)
    // The Files panel renders a file tree; we probe for the panel heading
    await page.getByRole("heading", { name: /files/i }).first().waitFor({ state: "visible", timeout: 60_000 })
    await expect.poll(() => tabParam(page), { timeout: 10_000 }).toBe("files")
  })

  test("in-app push to settings is unaffected (AC5)", async ({ page }) => {
    await prepare(page)
    // Start on canvas via a cold load
    await page.goto(`/projects/${projectId}`)
    await page.waitForLoadState("networkidle")
    // The sidebar settings click uses router.push with tab: 'settings'
    await page.getByRole("link", { name: /settings/i }).first().click()
    await page.getByTestId("settings-nav-machine").waitFor({ state: "visible", timeout: 60_000 })
  })
})
