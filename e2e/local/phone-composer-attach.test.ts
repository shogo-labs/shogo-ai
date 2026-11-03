// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-283 — the phone composer's "+" sheet must actually open a picker.
 *
 * On iOS Safari the chooser only opens from a click inside the tap's own task
 * (transient user activation). The sheet used to close itself and hand the
 * action to `executeNativeAttachAction`, which reaches the picker through a
 * dynamic import and a detached `<input>` — so Safari dropped it and the tap
 * looked dead. The rows now click the composer's own hidden
 * `<input type="file">` synchronously, with `accept`/`capture` set per row.
 *
 * This is the real proof: WebKit, an iPhone profile, and Playwright's
 * `filechooser` event — which only fires when the browser actually opened a
 * chooser. A unit test can assert `.click()` was called; only the browser can
 * say the chooser opened.
 *
 * All three rows are checked in ONE test on ONE page load: the phone lane runs
 * at ~26 of its 30 minutes, so a test per row (x2 projects) costs more than the
 * lane can spare.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts phone-composer-attach
 */
import { expect, test, type Page } from "@playwright/test"
import { signIn } from "./team-nav-seed"
import { ignoreDevErrorToast } from "./helpers"

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

/**
 * A project runtime needs the built runtime template, which the local stack
 * does not have: without this the page sits on "Starting your project…" and no
 * composer renders. The chat itself still goes to the real API.
 */
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

function composer(page: Page) {
  return page.getByRole("textbox", { name: "Chat message input" }).first()
}

/** Open the phone "+" sheet and wait for its rows. */
async function openPlusSheet(page: Page) {
  await page.getByTestId("project-composer-plus").first().click()
  await expect(page.getByText("Photo library", { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  })
}

/**
 * Tap one row and return the chooser the browser opened. `waitForEvent` is
 * armed before the tap, so a chooser that never opens fails on the timeout
 * rather than passing silently.
 */
async function tapRow(page: Page, label: string) {
  const chooser = page.waitForEvent("filechooser", { timeout: 15_000 })
  await page.getByText(label, { exact: true }).first().click()
  return chooser
}

test.describe("SHO-283 — phone composer attach rows open a real chooser", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000)
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await signIn(page)

    const suffix = Date.now().toString(36)
    const workspace = await apiJson(page, "POST", "/api/workspaces", {
      name: `QA attach ${suffix}`,
      kind: "team",
    })
    workspaceId = workspace.json?.data?.id ?? workspace.json?.id
    expect(workspaceId, JSON.stringify(workspace.json)).toBeTruthy()

    const project = await apiJson(page, "POST", "/api/projects", {
      name: `Attach ${suffix}`,
      workspaceId,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
      schemas: [],
      settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
    })
    projectId = project.json?.data?.id ?? project.json?.id
    expect(projectId, JSON.stringify(project.json)).toBeTruthy()

    const pinned = await apiJson(page, "POST", `/api/local/projects/${projectId}/workspace-session`)
    const sessionId = pinned.json?.session?.id
    expect(sessionId, JSON.stringify(pinned.json)).toBeTruthy()

    for (const [role, content] of [
      ["user", "Build me a landing page"],
      ["assistant", "Here is the first pass."],
    ] as const) {
      const seeded = await apiJson(page, "POST", "/api/chat-messages", {
        sessionId,
        role,
        content,
        parts: JSON.stringify([{ type: "text", text: content }]),
      })
      expect(seeded.status, JSON.stringify(seeded.json)).toBeLessThan(300)
    }
    await page.close()
  })

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage()
    if (projectId) await page.request.delete(`${API}/api/projects/${projectId}`).catch(() => {})
    if (workspaceId) await page.request.delete(`${API}/api/workspaces/${workspaceId}`).catch(() => {})
    await page.close()
  })

  test("every attach row opens a chooser with the right accept/capture, and a pick attaches", async ({
    page,
  }) => {
    await ignoreDevErrorToast(page)
    await stubProjectRuntime(page)
    await signIn(page)
    await page.evaluate((id) => {
      localStorage.setItem("shogo:active-workspace-id", id)
      localStorage.setItem("shogo:active-workspace-kind", "team")
    }, workspaceId)

    await page.goto(`/projects/${projectId}`)
    await composer(page).waitFor({ state: "visible", timeout: 120_000 })

    // Photo library — an image chooser, no camera capture, and the pick lands.
    await openPlusSheet(page)
    const library = await tapRow(page, "Photo library")
    expect(await library.element().getAttribute("accept")).toBe("image/*")
    expect(await library.element().getAttribute("capture")).toBeNull()
    await library.setFiles({
      name: "qa-photo.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    })
    await expect(page.getByRole("button", { name: "Preview image qa-photo.png" })).toBeVisible({
      timeout: 30_000,
    })

    // Browse files — no accept filter, no capture, and the file lands.
    await openPlusSheet(page)
    const browse = await tapRow(page, "Browse files")
    expect(await browse.element().getAttribute("accept")).toBeNull()
    expect(await browse.element().getAttribute("capture")).toBeNull()
    await browse.setFiles({
      name: "qa-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("SHO-283 attach proof\n"),
    })
    await expect(page.getByText("qa-notes.txt", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    })

    // Take photo — the camera, not the library.
    await openPlusSheet(page)
    const camera = await tapRow(page, "Take photo")
    expect(await camera.element().getAttribute("accept")).toBe("image/*")
    expect(await camera.element().getAttribute("capture")).toBe("environment")
  })
})
