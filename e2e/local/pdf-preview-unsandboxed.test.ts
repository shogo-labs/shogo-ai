// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Russell's bug, end to end: opening a PDF in the app showed Chrome's grey
 * "This page has been blocked by Chrome" page instead of the document (SHO-224).
 *
 * Chromium will not run its built-in PDF viewer in a frame that carries
 * `sandbox`, whatever the `allow-*` flags, so `PdfPreview` frames without one
 * and only ever frames a `blob:` URL typed `application/pdf` — an http(s) URL
 * is fetched and re-wrapped first, so an uploaded `.pdf` that is really HTML has
 * nothing to execute now that the sandbox is gone.
 *
 * Both entry points are driven through the real UI:
 *   - a chat `share_file` chip, which hands the preview a `blob:` of its own
 *     (the preview must pass it through and never fetch again), and
 *   - a team-chat attachment, which hands it an http URL from the file-metadata
 *     route (the preview must fetch the bytes and frame a blob instead).
 *
 * `E2E_LOCAL_START_STACK=1` boots the stack itself; against your own:
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *   npx playwright test --config e2e/local/playwright.config.ts pdf-preview-unsandboxed
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

const suffix = Date.now().toString(36)

/**
 * A real one-page PDF, xref and all. Bundled Chromium has no PDF viewer, but
 * the fixture stays a document the viewer can open so the spec means the same
 * thing when it is run against Google Chrome.
 */
function buildPdf(line: string): Buffer {
  const content = `BT /F1 18 Tf 24 120 Td (${line}) Tj ET`
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  bodies.forEach((body, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefAt = out.length
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}

/** Every frame the page owns; a blocked PDF navigation lands at `chrome-error:`. */
async function frameUrls(page: Page): Promise<string[]> {
  return page.frames().map((frame) => frame.url())
}

async function blobTypeOf(page: Page, url: string): Promise<string> {
  return page.evaluate(async (href) => {
    const response = await fetch(href)
    const blob = await response.blob()
    return blob.type
  }, url)
}

/** The one assertion the whole card rests on: no sandbox, always a typed blob. */
async function expectUnsandboxedBlobFrame(page: Page, scope: ReturnType<Page["locator"]>) {
  // Every PDF preview is a single frame, so this catches the bug even if a
  // test hook goes missing: on the buggy component it is the frame carrying
  // `sandbox` and the http URL that this asserts against.
  const frame = scope.locator("iframe")
  await expect(frame).toHaveCount(1, { timeout: 30_000 })
  await expect(frame).toBeVisible({ timeout: 30_000 })

  // Chrome refuses a PDF viewer in a sandboxed frame at all, so the attribute
  // must be absent — `allow-same-origin` etc. do not help.
  expect(await frame.getAttribute("sandbox")).toBeNull()

  const src = await frame.getAttribute("src")
  expect(src?.startsWith("blob:")).toBe(true)
  // The frame holds a PDF document, not whatever the server claimed it was.
  expect(await blobTypeOf(page, src!)).toBe("application/pdf")

  // And the navigation did not end up on Chrome's blocked-error page.
  expect((await frameUrls(page)).filter((url) => url.startsWith("chrome-error://"))).toEqual([])
  return frame
}

// ─── A chat share_file chip hands the preview its own blob ────────────────

const API = process.env.E2E_API_URL || "http://localhost:8002"

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

interface ShareFixture {
  status?: number
  contentType?: string
  body: Buffer
}

/** `/api/f/<token>` answers from here, so the spec owns the bytes. */
const fixtures = new Map<string, ShareFixture>()

function shareHref(path: string): string {
  const payload = Buffer.from(
    JSON.stringify({ typ: "file", projectId: "proj-qa", workspaceId: "ws-qa", path }),
    "utf8",
  ).toString("base64url")
  return `/api/f/${payload}.qa-signature`
}

function registerFixture(path: string, fixture: ShareFixture): { href: string; token: string } {
  const href = shareHref(path)
  const token = href.slice("/api/f/".length)
  fixtures.set(token, fixture)
  return { href, token }
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
      status: fixture.status ?? 200,
      headers: { ...cors, "content-type": fixture.contentType ?? "application/octet-stream" },
      body: fixture.body,
    })
  })
}

function composer(page: Page) {
  return page.getByTestId("project-composer-input").or(page.getByTestId("home-composer-input"))
}

async function send(page: Page, text: string) {
  // Expo's dev overlay sits above the app when any uncaught rejection reaches
  // the page (Monaco's dispose path emits a cancelled promise). It is a dev
  // artifact, not part of the feature under test: close it so the click lands.
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

test.describe("A PDF shared with the workspace agent", () => {
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

    const workspaces = await apiJson(page, "GET", "/api/workspaces")
    const list = workspaces.json?.items ?? workspaces.json?.data ?? workspaces.json?.workspaces ?? workspaces.json
    const rows = Array.isArray(list) ? list : []
    const workspace = rows.find((row: { kind?: string }) => row.kind === "personal") ?? rows[0]
    expect(workspace?.id, `workspace list ${workspaces.status}`).toBeTruthy()
    const primary = await apiJson(page, "POST", `/api/workspaces/${workspace.id}/sessions/primary`, {})
    expect(primary.json?.session?.id, JSON.stringify(primary.json)).toBeTruthy()
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test("opens in the pane framed unsandboxed from the chip's own blob, fetched exactly once", async () => {
    const { href, token } = registerFixture(`docs/qa-brief-${suffix}.pdf`, {
      contentType: "application/pdf",
      body: buildPdf("SHO-224 share chip"),
    })

    // The download is what mints the caller's blob; the preview must not repeat it.
    const downloads: string[] = []
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith(token)) downloads.push(request.url())
    })

    nextReply = `Brief attached.\n\n[QA brief](${href})`
    await send(page, "Share the brief")

    const chip = page.getByTestId("chat-file-chip").filter({ hasText: `qa-brief-${suffix}.pdf` }).last()
    await expect(chip).toBeVisible({ timeout: 30_000 })
    await chip.click()

    const pane = page.getByTestId("workspace-share-file-pane")
    await expect(pane).toBeVisible({ timeout: 30_000 })
    const frame = await expectUnsandboxedBlobFrame(page, pane)

    // ShareFileView already wrapped these bytes as application/pdf: the preview
    // framed that blob as-is instead of downloading the file a second time.
    const src = await frame.getAttribute("src")
    expect(await page.evaluate((url) => url.startsWith("blob:"), src!)).toBe(true)
    expect(downloads).toHaveLength(1)
    expect(new URL(page.url()).pathname).toBe("/")
  })
})

// ─── A team-chat attachment hands it an http URL ──────────────────────────

test.describe("A PDF attached in a team chat", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let workspaceId: string
  let channelId: string
  let pdf: { attachmentId: string; name: string; messageId: string }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    page = await browser.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    await signIn(page)
    workspaceId = await teamWorkspaceId(page)

    const channel = await api(page, "POST", `/api/workspaces/${workspaceId}/conversations`, {
      name: `pdf-${suffix}`,
      kind: "public",
    })
    channelId = channel.json?.conversation?.id
    expect(channelId, JSON.stringify(channel.json)).toBeTruthy()

    const name = `q3-brief-${suffix}.pdf`
    const upload = await page.request.post(`${LOCAL_API_BASE}/api/conversations/${channelId}/attachments`, {
      multipart: { file: { name, mimeType: "application/pdf", buffer: buildPdf("SHO-224 team chat") } },
    })
    expect(upload.status(), await upload.text()).toBe(201)
    const attachment = (await upload.json()).attachment
    const sent = await api(page, "POST", `/api/conversations/${channelId}/messages`, {
      text: "Here is the Q3 brief",
      attachmentIds: [attachment.id],
      clientMsgId: crypto.randomUUID(),
    })
    expect(sent.status, JSON.stringify(sent.json)).toBe(201)
    pdf = { attachmentId: attachment.id, name, messageId: sent.json.message.id }
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test("opens in the app as a blob, though the attachment is served over http", async () => {
    const fetches: string[] = []
    page.on("request", (request) => {
      const url = new URL(request.url())
      // The content route, not the metadata route the viewer loads first.
      if (url.pathname === `/api/conversation-files/${pdf.attachmentId}`) fetches.push(request.url())
    })

    await activateTeamWorkspace(page, workspaceId)
    await page.goto(`/c/${channelId}`)
    await page.getByRole("link", { name: `Open ${pdf.name}` }).click()

    const viewer = page.getByTestId("file-viewer")
    await expect(viewer).toBeVisible({ timeout: 30_000 })
    const frame = await expectUnsandboxedBlobFrame(page, viewer)

    // FileViewer hands the preview an absolute API URL, so the bytes here came
    // from the preview's own fetch — one of them, wrapped as a PDF blob.
    expect(fetches).toHaveLength(1)
    expect(new URL(fetches[0]).pathname).toBe(`/api/conversation-files/${pdf.attachmentId}`)
    expect((await frame.getAttribute("src"))?.startsWith("blob:")).toBe(true)
  })

  test("a failing download shows the status and Open in new tab, never a blank frame", async () => {
    // Only the bytes fail: the metadata route still answers, so the viewer gets
    // far enough to ask the preview for a document.
    await page.route(
      (url) => url.pathname === `/api/conversation-files/${pdf.attachmentId}`,
      async (route: Route) => {
        await route.fulfill({
          status: 503,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: { code: "unavailable", message: "Try again later" } }),
        })
      },
    )

    await activateTeamWorkspace(page, workspaceId)
    await page.goto(`/f/${pdf.attachmentId}?name=${encodeURIComponent(pdf.name)}`)

    const viewer = page.getByTestId("file-viewer")
    await expect(viewer).toBeVisible({ timeout: 30_000 })
    await expect(viewer.getByText(`Could not open ${pdf.name} · HTTP 503`)).toBeVisible({ timeout: 30_000 })
    await expect(viewer.locator("iframe")).toHaveCount(0)

    // The escape hatch keeps the original URL: it is the file, not the blob.
    // By its text, because the chrome bar's icon button carries the same name.
    const open = viewer.getByText("Open in new tab", { exact: true })
    await expect(open).toBeVisible()

    // Listen on the context, before the click: the popup is a page of its own
    // and its request is what proves which URL the button was given.
    const popupRequests: string[] = []
    page.context().on("request", (request) => popupRequests.push(request.url()))
    const popupPromise = page.waitForEvent("popup", { timeout: 30_000 })
    await open.click()
    await popupPromise
    await expect
      .poll(() => popupRequests.find((url) => url.includes(pdf.attachmentId)) ?? null, { timeout: 30_000 })
      .not.toBeNull()
    expect(new URL(popupRequests.find((url) => url.includes(pdf.attachmentId))!).pathname).toBe(
      `/api/conversation-files/${pdf.attachmentId}`,
    )
    // It left the app alone: the document opens beside it, not in place.
    expect(new URL(page.url()).pathname).toBe(`/f/${pdf.attachmentId}`)
  })
})
