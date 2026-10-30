// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page, type Route } from "@playwright/test"

/**
 * Russell's bug, end to end: a file the workspace agent wrote in ANOTHER
 * project with the remote `project` parameter came back as that project's own
 * relative path, so the reply said `plans/x.md` — a path that exists nowhere in
 * the workspace runtime. It drew no chip and clicking it said "File not found"
 * (SHO-247).
 *
 * The runtime half (`withRemoteProject` adding `project` + `chatPath`) is
 * covered by `remote-tool-channel.integration.test.ts`. This spec drives the
 * half the user sees: a turn whose `write_file` ran in another project, the
 * bare path in its reply, the chip, and the file's contents in the side pane —
 * read from the OWNING project's runtime, because the workspace runtime answers
 * 404 for it (a project that is not mounted, which is every project on metal).
 *
 * Only the turn and the two agent proxies are answered by the test; the click
 * path, the file index, the pane and the viewer are the real app.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     --project=chromium workspace-chat-remote-project-file
 */

const API = process.env.E2E_API_URL || "http://localhost:8002"

/** A project id shape `resolveChatFilePath` accepts (a bare UUID segment). */
const PROJECT_ID = "3f1d9a52-8c4b-4e6a-9f27-0a1b2c3d4e5f"
const PROJECT_NAME = "QA Remote Project"
const REMOTE_PATH = "plans/qa-sho247.md"
const REMOTE_CONTENT = "# Sealed marketplace agents\n\nQA-SHO247-REMOTE-CONTENT"
const MISSING_PATH = "plans/qa-sho247-nowhere.md"

let frameCounter = 0
function sseFrame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

interface TurnOptions {
  /** What the reply says, markdown. */
  text: string
  /** The remote `write_file` call this turn made, if any. */
  write?: { path: string; project: string }
}

/**
 * One assistant turn: a remote `write_file` (when asked for) whose result
 * carries the `project` + `chatPath` the runtime now returns, then the reply.
 */
function buildTurn({ text, write }: TurnOptions): string {
  frameCounter += 1
  const textId = `text_${frameCounter}`
  const callId = `call_${frameCounter}`
  const frames: Record<string, unknown>[] = [
    { type: "start", messageId: `msg_${frameCounter}` },
    { type: "start-step" },
  ]
  if (write) {
    frames.push(
      { type: "tool-input-start", toolCallId: callId, toolName: "write_file", dynamic: true },
      {
        type: "tool-input-available",
        toolCallId: callId,
        toolName: "write_file",
        input: { path: write.path, project: write.project, content: REMOTE_CONTENT },
        dynamic: true,
      },
      {
        type: "tool-output-available",
        toolCallId: callId,
        // The shape `withRemoteProject` adds (SHO-247).
        output: {
          path: write.path,
          bytes: REMOTE_CONTENT.length,
          project: { id: PROJECT_ID, name: PROJECT_NAME },
          chatPath: `${PROJECT_ID}/${write.path}`,
        },
        dynamic: true,
      },
    )
  }
  frames.push(
    { type: "text-start", id: textId },
    { type: "text-delta", id: textId, delta: text },
    { type: "text-end", id: textId },
    { type: "finish-step" },
    { type: "finish" },
  )
  return frames.map(sseFrame).join("")
}

let nextTurn: TurnOptions | null = null

async function installChatMock(page: Page) {
  const handler = async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.continue()
      return
    }
    const turn = nextTurn ?? { text: "OK." }
    nextTurn = null
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: buildTurn(turn),
    })
  }
  await page.route("**/api/workspaces/*/chat", handler)
  await page.route("**/api/projects/*/chat", handler)
}

const NOT_FOUND = {
  status: 404,
  contentType: "application/json",
  body: JSON.stringify({ error: { code: "file_not_found", message: "File not found" } }),
}

/**
 * The web app is served from :8081 and calls the API on :8002, so a mocked
 * answer needs the same CORS headers the local API sends — a cross-origin
 * `credentials: include` fetch is blocked without them and the index would
 * quietly stay empty.
 */
function cors(route: Route) {
  return {
    "access-control-allow-origin": route.request().headers()["origin"] ?? "*",
    "access-control-allow-credentials": "true",
  }
}

/**
 * The workspace runtime never mounted the project, so it has neither the file
 * in its list nor the file itself. The owning project's runtime has both.
 */
async function installAgentMocks(page: Page, hits: string[] = []) {
  await page.route(/\/api\/workspaces\/[^/]+\/agent-proxy\/agent\/workspace\/file-list/, (route) => {
    hits.push("workspace file-list")
    return route.fulfill({
      status: 200,
      headers: { ...cors(route), "content-type": "application/json" },
      body: JSON.stringify({ files: [], truncated: false }),
    })
  })
  await page.route(/\/api\/workspaces\/[^/]+\/agent-proxy\/agent\/workspace\/files\//, (route) => {
    hits.push("workspace file read")
    return route.fulfill({
      ...NOT_FOUND,
      headers: { ...cors(route), "content-type": "application/json" },
    })
  })
  await page.route(
    new RegExp(`/api/projects/${PROJECT_ID}/agent-proxy/agent/workspace/file-list`),
    (route) => {
      hits.push("project file-list")
      return route.fulfill({
        status: 200,
        headers: { ...cors(route), "content-type": "application/json" },
        body: JSON.stringify({ files: [REMOTE_PATH], truncated: false }),
      })
    },
  )
  await page.route(
    new RegExp(`/api/projects/${PROJECT_ID}/agent-proxy/agent/workspace/files/`),
    (route) => {
      hits.push("project file read")
      return route.fulfill({
        status: 200,
        headers: { ...cors(route), "content-type": "application/json" },
        body: JSON.stringify({ content: REMOTE_CONTENT }),
      })
    },
  )
  return hits
}

function composer(page: Page) {
  return page.getByTestId("project-composer-input").or(page.getByTestId("home-composer-input"))
}

function fileChip(page: Page, name: string) {
  return page.getByTestId("chat-file-chip").filter({ hasText: name }).last()
}

async function send(page: Page, text: string) {
  // Expo's dev overlay sits above the app when any uncaught rejection reaches
  // the page. It is a dev artifact, not part of the feature under test.
  const dismiss = page.getByRole("button", { name: "Dismiss error" })
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
  const input = composer(page)
  await input.click()
  await input.fill(text)
  await page.keyboard.press("Enter")
}

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

test.describe("A file the workspace agent wrote in another project", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  const mockHits: string[] = []

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 800 })
    await installChatMock(page)
    await installAgentMocks(page, mockHits)
    await page.goto("/")
    await page.getByRole("navigation", { name: "App sidebar" }).waitFor({
      state: "visible",
      timeout: 60_000,
    })

    // Local mode opens the Personal workspace (the companion chat). The
    // workspace agent chat — the surface in the bug — is the Team workspace's
    // `/`, so make that workspace active first.
    const workspaces = await apiJson(page, "GET", "/api/workspaces")
    const list =
      workspaces.json?.items ?? workspaces.json?.data ?? workspaces.json?.workspaces ?? workspaces.json
    const rows = Array.isArray(list) ? list : []
    const workspace = rows.find((row: { kind?: string }) => row.kind !== "personal") ?? rows[0]
    expect(workspace?.id, `workspace list ${workspaces.status}`).toBeTruthy()
    await page.evaluate((id) => {
      localStorage.setItem("shogo:active-workspace-id", id)
      localStorage.setItem("shogo:active-workspace-kind", "team")
    }, workspace.id)
    await page.goto("/")
    await composer(page).waitFor({ state: "visible", timeout: 60_000 })

    const primary = await apiJson(page, "POST", `/api/workspaces/${workspace.id}/sessions/primary`, {})
    expect(primary.json?.session?.id, JSON.stringify(primary.json)).toBeTruthy()
  })

  test.afterAll(async () => {
    await page?.close()
  })

  /** One turn that writes `REMOTE_PATH` in the other project and says so. */
  async function remoteWriteTurn(prompt: string) {
    nextTurn = {
      text: `Wrote the plan in ${PROJECT_NAME}: \`${REMOTE_PATH}\``,
      write: { path: REMOTE_PATH, project: PROJECT_NAME },
    }
    await send(page, prompt)
    // The turn itself lands first: a chip that never appears must not be
    // confused with a reply that never rendered.
    await expect(page.getByText("Wrote the plan in", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    })
  }

  test("a bare path the turn wrote there opens from that project's runtime", async () => {
    await remoteWriteTurn("Write the plan in the remote project")

    // The path is an in-app opener either way; AC1's chip is the other test.
    await page
      .locator('[data-testid="chat-file-chip"], [data-testid="chat-file-link"]')
      .filter({ hasText: "qa-sho247.md" })
      .last()
      .click()

    // AC1: it opens in the same side pane, and the contents come from the
    // project's own runtime — the workspace runtime answered 404 for it.
    const pane = page.getByTestId("workspace-file-pane")
    await expect(pane).toBeVisible({ timeout: 30_000 })
    await expect(pane.getByText("QA-SHO247-REMOTE-CONTENT")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("workspace-file-missing")).toHaveCount(0)
    expect(mockHits).toContain("project file read")
  })

  test("the path chips when that project's file list is already known", async () => {
    // The first turn above fetched the other project's list, so this reply
    // renders with it in hand. On a cold cache the list arrives after the text
    // has rendered and the chip only appears on the next re-render of that
    // message (a real streaming turn gets one when the stream ends; a
    // single-chunk reply does not), which is why the assertion is here and not
    // on the first turn.
    await remoteWriteTurn("Write the plan again")

    await expect(
      fileChip(page, "qa-sho247.md"),
      "a remote-project path chips once its project's file list is known",
    ).toBeVisible({ timeout: 15_000 })
  })

  test("a path that exists nowhere is not a chip, and the miss names where it looked", async () => {
    nextTurn = { text: `That one is at \`${MISSING_PATH}\`.` }
    await send(page, "Where is the other plan?")

    await expect(page.getByText(MISSING_PATH, { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    })
    // AC5: a path nothing can resolve stays a plain in-app link, never a chip.
    await expect(fileChip(page, "qa-sho247-nowhere.md")).toHaveCount(0)

    await page.getByTestId("chat-file-link").filter({ hasText: "qa-sho247-nowhere.md" }).last().click()
    const missing = page.getByTestId("workspace-file-missing")
    await expect(missing).toBeVisible({ timeout: 30_000 })
    // AC5: it says where it looked instead of a bare "File not found".
    await expect(missing.getByText("Looked in the workspace folder")).toBeVisible()
  })
})
