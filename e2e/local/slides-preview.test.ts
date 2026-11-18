// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A PowerPoint deck previews as real slides (SHO-426).
 *
 * Every file host asks `fileViewKind()` and renders through `FileContentView` →
 * `FilePreview`, so the same `slides` kind reaches the IDE tab, the workspace
 * viewer, the `share_file` panel and a team-chat attachment. This spec drives
 * the two hosts that have a URL of their own:
 *
 *   - a team-chat attachment, opened from `/f/<id>` — the bytes come from the
 *     real upload, so the whole chain is real: the API's sandboxed viewer page,
 *     the host's credentialed fetch, the message transport and the renderer.
 *   - a chat `share_file` chip — the sidebar pane. Only the bytes behind
 *     `/api/f/<token>` are fulfilled here, the way the other share-file specs
 *     do it.
 *
 * `e2e/local/fixtures/qa-deck-3-slides.pptx` is a real three-slide deck written
 * by python-pptx (title + one bullet per slide), not a hand-built zip: if the
 * renderer cannot open a real deck the spec must say so.
 *
 *   SHOGO_LOCAL_MODE=true bun run api:dev &
 *   SHOGO_LOCAL_MODE=true bun run web:dev &
 *   npx playwright test --config e2e/local/playwright.config.ts slides-preview
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { LOCAL_API_BASE } from "./helpers"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

const SUFFIX = Date.now().toString(36)

/** The deck every "it renders" assertion below is about. */
const DECK = readFileSync(join(__dirname, "fixtures/qa-deck-3-slides.pptx"))
const DECK_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

/** Bytes that are not a zip at all: the renderer must fail, not spin. */
const BROKEN_DECK = Buffer.from("this is not a presentation", "utf8")

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

/** `/api/f/<token>` answers from here, so the pane's fetch has real bytes. */
const fixtures = new Map<string, { contentType: string; body: Buffer }>()

function shareHref(path: string): string {
  const payload = Buffer.from(
    JSON.stringify({ typ: "file", projectId: "proj-qa", workspaceId: "ws-qa", path }),
    "utf8",
  ).toString("base64url")
  return `/api/f/${payload}.qa-signature`
}

function registerDeckFixture(path: string): string {
  const href = shareHref(path)
  fixtures.set(href.slice("/api/f/".length), { contentType: DECK_MIME, body: DECK })
  return href
}

async function installFileMock(page: Page) {
  await page.route("**/api/f/*", async (route: Route) => {
    const token = new URL(route.request().url()).pathname.split("/").pop() ?? ""
    const fixture = fixtures.get(token)
    // A cross-origin download with `credentials: include` needs the origin
    // echoed back; the API sends the same two headers in local mode.
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
 * The frame's own report is the assertion: `data-slide-count` is only set from
 * the viewer's `rendered` message, so `3` means the page loaded, the bytes
 * crossed the boundary, and the renderer counted three slides.
 */
async function expectSlideCount(host: ReturnType<Page["getByTestId"]>, timeout = 60_000) {
  const frame = host.getByTestId("slides-preview-frame")
  await expect(frame).toBeVisible({ timeout })
  await expect(frame).toHaveAttribute("data-slide-count", "3", { timeout })
  return frame
}

test.describe("a deck opened from team chat", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let workspaceId: string
  let channelId: string
  let deck: { attachmentId: string; name: string }
  let broken: { attachmentId: string; name: string }

  async function share(file: { name: string; buffer: Buffer }) {
    const upload = await page.request.post(
      `${LOCAL_API_BASE}/api/conversations/${channelId}/attachments`,
      { multipart: { file: { ...file, mimeType: DECK_MIME } } },
    )
    expect(upload.status(), await upload.text()).toBe(201)
    const attachment = (await upload.json()).attachment
    const sent = await api(page, "POST", `/api/conversations/${channelId}/messages`, {
      text: `Deck: ${file.name}`,
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
      name: `slides-${SUFFIX}`,
      kind: "public",
    })
    channelId = channel.json?.conversation?.id
    expect(channelId, JSON.stringify(channel.json)).toBeTruthy()
    deck = await share({ name: `qa-deck-${SUFFIX}.pptx`, buffer: DECK })
    broken = await share({ name: `qa-broken-${SUFFIX}.pptx`, buffer: BROKEN_DECK })
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test("the attachment renders three slides in a sandboxed frame", async () => {
    await activateTeamWorkspace(page, workspaceId)
    await page.goto(`/f/${deck.attachmentId}?name=${encodeURIComponent(deck.name)}`)

    const viewer = page.getByTestId("file-viewer")
    await expect(viewer).toBeVisible({ timeout: 30_000 })
    // A deck is never the extracted-text fallback now.
    await expect(viewer.getByTestId("file-viewer-text")).toHaveCount(0)

    const frame = await expectSlideCount(viewer)
    // Opaque origin: without `allow-same-origin` the deck's HTML can never run
    // as the app, and the page's own CSP says the same thing.
    expect(await frame.getAttribute("sandbox")).toBe("allow-scripts")

    const deckFrame = viewer.frameLocator('[data-testid="slides-preview-frame"]')
    await expect(deckFrame.getByText("QA Deck One")).toBeVisible({ timeout: 30_000 })
    await expect(deckFrame.locator("#counter")).toHaveText("Slide 1 of 3")

    // Scrolling reaches the last slide and the counter follows it.
    await deckFrame.locator("#slides").evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await expect(deckFrame.locator("#counter")).toHaveText("Slide 3 of 3", { timeout: 30_000 })
  })

  test("a deck that cannot be parsed says so and still offers the file", async () => {
    await activateTeamWorkspace(page, workspaceId)
    await page.goto(`/f/${broken.attachmentId}?name=${encodeURIComponent(broken.name)}`)

    const viewer = page.getByTestId("file-viewer")
    await expect(viewer).toBeVisible({ timeout: 30_000 })

    // AC4 allows either honest end: the viewer's own error ("… is this a zip
    // file?" + Open the file) or the host's extracted-text fallback with its
    // Download. What is not allowed is a frame that never settles — this page
    // showed an empty text view in CI round 2, which is the second branch.
    const settled = viewer
      .getByTestId("slides-preview-error")
      .or(viewer.getByText("There's no text to show for this file."))
      .or(viewer.getByText("Text extracted from this file"))
    await expect(settled.first()).toBeVisible({ timeout: 20_000 })

    // Never an endless spinner: the loading overlay is gone either way.
    await expect(viewer.getByTestId("slides-preview-loading")).toHaveCount(0)
    // And the file itself is always still reachable from the page.
    await expect(
      viewer.getByRole("button", { name: /Download|Open the file/ }).first(),
    ).toBeVisible()
  })
})

test.describe("a deck opened from a share_file chip", () => {
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

  test("the chip opens the side pane and the pane renders the slides", async () => {
    const name = `qa-shared-deck-${SUFFIX}.pptx`
    const href = registerDeckFixture(`decks/${name}`)
    nextReply = `Here is the deck.\n\n[QA deck](${href})`
    await send(page, "Share the deck")

    const chip = fileChip(page, name)
    await expect(chip).toBeVisible({ timeout: 30_000 })
    await chip.click()

    const pane = page.getByTestId("workspace-share-file-pane")
    await expect(pane).toBeVisible({ timeout: 30_000 })
    await expect(pane.getByText("No preview for this file type.")).toHaveCount(0)
    await expectSlideCount(pane)
    // It stays in the app: the pane, not a tab.
    expect(new URL(page.url()).pathname).toBe("/")
  })
})
