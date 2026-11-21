// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A Word document previews as rendered pages (SHO-467).
 *
 * Every file host asks `fileViewKind()` and renders through `FileContentView` →
 * `FilePreview`, so the same `document` kind reaches the IDE tab, the workspace
 * viewer, the `share_file` panel and a team-chat attachment. This spec drives
 * the two hosts that have a URL of their own:
 *
 *   - a team-chat attachment, opened from `/f/<id>` — the bytes come from the
 *     real upload, so the whole chain is real: the API's sandboxed viewer page,
 *     the host's credentialed fetch, the message transport and the renderer.
 *   - a chat `share_file` chip — the sidebar pane.
 *
 * `e2e/local/fixtures/qa-doc-heading-table.docx` is a minimal valid OOXML
 * document (heading, bold/italic paragraph, table).
 *
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *   npx playwright test --config e2e/local/playwright.config.ts docx-preview
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { LOCAL_API_BASE } from "./helpers"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

const SUFFIX = Date.now().toString(36)

/** The document every "it renders" assertion below is about. */
const DOC = readFileSync(join(__dirname, "fixtures/qa-doc-heading-table.docx"))
const DOC_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/** Bytes that are not a zip at all: the renderer must fail, not spin. */
const BROKEN_DOC = Buffer.from("this is not a Word document", "utf8")

let frameCounter = 0
function sseFrame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`
}
function buildTurn(text: string): string {
  frameCounter += 1
  const textId = `text_${frameCounter}`
  return [
    sseFrame({ type: "start", messageId: `msg_${frameCounter}` }),
    sseFrame({ type: "start-step" }),
    sseFrame({ type: "text-start", id: textId }),
    sseFrame({ type: "text-delta", id: textId, delta: text }),
    sseFrame({ type: "text-end", id: textId }),
    sseFrame({ type: "finish-step" }),
    sseFrame({ type: "finish" }),
  ].join("")
}

let nextReply: string | null = null

async function installChatMock(page: Page) {
  const handler = async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.continue()
      return
    }
    const text = nextReply ?? "OK."
    nextReply = null
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: buildTurn(text),
    })
  }
  await page.route("**/api/workspaces/*/chat", handler)
  await page.route("**/api/projects/*/chat", handler)
}

const fixtures = new Map<string, { contentType: string; body: Buffer }>()

function shareHref(path: string): string {
  const payload = Buffer.from(
    JSON.stringify({ typ: "file", projectId: "proj-qa", workspaceId: "ws-qa", path }),
    "utf8",
  ).toString("base64url")
  return `/api/f/${payload}.qa-signature`
}

function registerDocFixture(path: string, body: Buffer = DOC): string {
  const href = shareHref(path)
  fixtures.set(href.slice("/api/f/".length), { contentType: DOC_MIME, body })
  return href
}

async function installFileMock(page: Page) {
  await page.route("**/api/f/*", async (route: Route) => {
    const token = new URL(route.request().url()).pathname.split("/").pop() ?? ""
    const fixture = fixtures.get(token)
    const cors = {
      "access-control-allow-origin": route.request().headers()["origin"] ?? "*",
      "access-control-allow-credentials": "true",
      "cache-control": "private, no-store",
    }
    if (!fixture) {
      await route.fulfill({
        status: 404,
        headers: { ...cors, "content-type": "application/json" },
        body: JSON.stringify({ error: { code: "file_not_found", message: "File not found" } }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      headers: { ...cors, "content-type": fixture.contentType },
      body: fixture.body,
    })
  })
}

function composer(page: Page) {
  return page.getByTestId("project-composer-input").or(page.getByTestId("home-composer-input"))
}

function fileChip(page: Page, name: string) {
  return page.getByTestId("chat-file-chip").filter({ hasText: name }).last()
}

async function send(page: Page, text: string) {
  const dismiss = page.getByRole("button", { name: "Dismiss error" })
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
  const input = composer(page)
  await input.click()
  await input.fill(text)
  await page.keyboard.press("Enter")
}

/**
 * The frame's own report is the assertion: `data-item-count` is only set from
 * the viewer's `rendered` message (via `OfficePreview`), so any value ≥ 1 means
 * the page loaded, the bytes crossed the boundary, and the renderer succeeded.
 */
async function expectDocumentRendered(host: ReturnType<Page["getByTestId"]>, timeout = 60_000) {
  const frame = host.getByTestId("document-preview-frame")
  await expect(frame).toBeVisible({ timeout })
  await expect(frame).toHaveAttribute("data-item-count", /^\d+$/, { timeout })
  return frame
}

test.describe("a Word document opened from team chat", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let workspaceId: string
  let channelId: string
  let doc: { attachmentId: string; name: string }
  let broken: { attachmentId: string; name: string }

  /** A real upload to a real channel, posted as a message: the viewer reads these bytes. */
  async function share(file: { name: string; buffer: Buffer }) {
    const upload = await page.request.post(
      `${LOCAL_API_BASE}/api/conversations/${channelId}/attachments`,
      { multipart: { file: { ...file, mimeType: DOC_MIME } } },
    )
    expect(upload.status(), await upload.text()).toBe(201)
    const attachment = (await upload.json()).attachment
    const sent = await api(page, "POST", `/api/conversations/${channelId}/messages`, {
      text: `Doc: ${file.name}`,
      attachmentIds: [attachment.id],
      clientMsgId: crypto.randomUUID(),
    })
    expect(sent.status, JSON.stringify(sent.json)).toBe(201)
    return { attachmentId: attachment.id as string, name: file.name }
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    page = await browser.newPage()
    await signIn(page)
    workspaceId = await teamWorkspaceId(page)
    const channel = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, {
      name: `docx-${SUFFIX}`,
      kind: "public",
    })
    channelId = channel.json?.conversation?.id
    expect(channelId, JSON.stringify(channel.json)).toBeTruthy()
    doc = await share({ name: `qa-doc-${SUFFIX}.docx`, buffer: DOC })
    broken = await share({ name: `qa-broken-${SUFFIX}.docx`, buffer: BROKEN_DOC })
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test("the viewer page is served with the right CSP", async () => {
    const response = await page.request.get(`${LOCAL_API_BASE}/api/viewers/document`)
    expect(response.status()).toBe(200)
    const csp = response.headers()["content-security-policy"] ?? ""
    expect(csp).toContain("sandbox allow-scripts")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).not.toContain("allow-same-origin")
  })

  test("a .docx chip opens as rendered document pages in team chat", async () => {
    await activateTeamWorkspace(page, workspaceId)
    await page.goto(`/f/${doc.attachmentId}?name=${encodeURIComponent(doc.name)}`)

    const viewer = page.getByTestId("file-viewer")
    await expect(viewer).toBeVisible({ timeout: 30_000 })
    const frame = await expectDocumentRendered(viewer)
    expect(await frame.getAttribute("sandbox")).toBe("allow-scripts")
    await expect(viewer.getByText("Text extracted from this file")).toHaveCount(0)
  })

  test("a corrupt .docx shows the extracted-text fallback, not an empty frame", async () => {
    await activateTeamWorkspace(page, workspaceId)
    await page.goto(`/f/${broken.attachmentId}?name=${encodeURIComponent(broken.name)}`)

    const viewer = page.getByTestId("file-viewer")
    await expect(viewer).toBeVisible({ timeout: 30_000 })
    // Either honest end: the viewer's own error, or the host's text fallback.
    const settled = viewer
      .getByTestId("document-preview-error")
      .or(viewer.getByText("There's no text to show for this file."))
      .or(viewer.getByText("Text extracted from this file"))
    await expect(settled.first()).toBeVisible({ timeout: 20_000 })
    // Never an endless spinner.
    await expect(viewer.getByTestId("document-preview-loading")).toHaveCount(0)
  })
})

test.describe("a Word document from the share_file panel", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 800 })
    await installChatMock(page)
    await installFileMock(page)
    await page.goto("/")
    await composer(page).waitFor({ state: "visible", timeout: 60_000 })

    const workspaces = await page.request.get(`${LOCAL_API_BASE}/api/workspaces`)
    const body = await workspaces.json()
    const list = body?.items ?? body?.data ?? body?.workspaces ?? body
    const rows = Array.isArray(list) ? list : []
    const workspace = rows.find((row: { kind?: string }) => row.kind === "personal") ?? rows[0]
    expect(workspace?.id, `workspace list ${workspaces.status()}`).toBeTruthy()
    const primary = await page.request.post(
      `${LOCAL_API_BASE}/api/workspaces/${workspace.id}/sessions/primary`,
      { data: {} },
    )
    expect(primary.status(), await primary.text()).toBeLessThan(400)
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test("renders as document pages in the share pane", async () => {
    const name = `qa-share-doc-${SUFFIX}.docx`
    const href = registerDocFixture(`docs/${name}`)
    nextReply = `Here is the document.\n\n[QA doc](${href})`
    await send(page, "Share the document")

    const chip = fileChip(page, name)
    await expect(chip).toBeVisible({ timeout: 30_000 })
    await chip.click()

    const pane = page.getByTestId("workspace-share-file-pane")
    await expect(pane).toBeVisible({ timeout: 30_000 })
    await expect(pane.getByText("No preview for this file type.")).toHaveCount(0)
    await expectDocumentRendered(pane)
    await expect(pane.getByText("Text extracted from this file")).toHaveCount(0)
    // It stays in the app: the pane, not a tab.
    expect(new URL(page.url()).pathname).toBe("/")
  })
})
