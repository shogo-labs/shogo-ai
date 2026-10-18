// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  test,
  expect,
  type APIRequestContext,
  type Page,
  type Route,
} from "@playwright/test"

// Local project chats run on the merged workspace runtime (/api/workspaces/:id/chat).
const CHAT_URL_GLOB = "**/api/{projects,workspaces}/*/chat"
const QUEUE_URL_GLOB = "**/api/chat-queued-messages**"
const API_BASE_URL = process.env.E2E_API_URL || "http://localhost:8010"

let frameId = 0
function sse(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function completedTurn(text: string): string {
  frameId += 1
  const messageId = `queue_e2e_message_${frameId}`
  const textId = `queue_e2e_text_${frameId}`
  return [
    sse({ type: "start", messageId }),
    sse({ type: "start-step" }),
    sse({ type: "text-start", id: textId }),
    sse({ type: "text-delta", id: textId, delta: text }),
    sse({ type: "text-end", id: textId }),
    sse({ type: "finish-step" }),
    sse({ type: "finish" }),
  ].join("")
}

/**
 * The queue is the server's: `rows` stands in for the `chat_queued_message`
 * table, so the spec decides when a queued message is dispatched (the server
 * removes the row when it starts the turn).
 */
type QueueMockState = {
  rows: Array<Record<string, unknown>>
  mockChat: boolean
  holdNextChat: boolean
  onChatSeen?: () => void
  releaseChat?: () => void
  nextRowId: number
  nextReply: number
}

function installQueueMock(page: Page, state: QueueMockState) {
  return Promise.all([
    page.route(CHAT_URL_GLOB, async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue()
      if (!state.mockChat) return route.continue()
      if (state.holdNextChat) {
        state.holdNextChat = false
        state.onChatSeen?.()
        await new Promise<void>((resolve) => {
          state.releaseChat = resolve
        })
      }
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: completedTurn(`Mocked response ${++state.nextReply}`),
      })
    }),
    page.route(QUEUE_URL_GLOB, async (route: Route) => {
      const request = route.request()
      const url = new URL(request.url())
      const parts = url.pathname.split("/").filter(Boolean)
      const resourceIndex = parts.indexOf("chat-queued-messages")
      const id = parts[resourceIndex + 1]
      if (request.method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, items: state.rows, total: state.rows.length }),
        })
        return
      }
      if (request.method() === "POST" && parts.length === resourceIndex + 1) {
        const body = request.postDataJSON() as Record<string, unknown>
        const row = {
          id: `queue-e2e-${++state.nextRowId}`,
          sessionId: body.sessionId,
          userId: "local-e2e-user",
          position: state.rows.length,
          status: "pending",
          content: body.content,
          parts: body.parts,
          body: body.body,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        state.rows.push(row)
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: row }),
        })
        return
      }
      if (!id) return route.continue()
      const index = state.rows.findIndex((row) => row.id === id)
      if (request.method() === "PATCH") {
        Object.assign(state.rows[index], request.postDataJSON())
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: state.rows[index] }),
        })
        return
      }
      if (request.method() === "DELETE") {
        state.rows.splice(index, 1)
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) })
        return
      }
      if (request.method() === "POST" && parts.at(-1) === "reorder") {
        const body = request.postDataJSON() as { direction: "up" | "down" }
        const next = body.direction === "up" ? index - 1 : index + 1
        if (index >= 0 && next >= 0 && next < state.rows.length) {
          ;[state.rows[index], state.rows[next]] = [state.rows[next], state.rows[index]]
          state.rows.forEach((row, position) => {
            row.position = position
          })
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: state.rows.find((row) => row.id === id) }),
        })
        return
      }
      await route.continue()
    }),
  ])
}

function projectComposerInput(page: Page) {
  return page.getByTestId("project-composer-input").or(
    page.getByRole("textbox", { name: "Chat message input" }),
  )
}

/**
 * A row in the "N Queued" strip. A queued prompt also paints as a transcript
 * bubble (the send owns its bubble), so a page-wide `getByText(prompt)` matches
 * both — assertions have to say which one they mean. `exact: true` matters:
 * without it this also matches the "Delete queued message" / "Move queued
 * message down" buttons.
 *
 * The shell mounts more than one chat panel (desktop + phone layouts, restored
 * tabs), so several strips can be in the DOM with the same rows: callers use
 * `.first()` to assert presence, `toHaveCount(0)` to assert absence.
 */
function queuedRow(page: Page, text: string) {
  return page.getByLabel("Queued message", { exact: true }).filter({ hasText: text })
}

/**
 * Positions (document order) of the transcript text containing `text`.
 *
 * A page-wide text scan has to skip two lookalikes: the "N Queued" strip, which
 * repeats the text of every queued message, and the composer, whose transparent
 * mention-highlight mirror repeats whatever is typed or restored as a draft.
 * Both are decorative for this purpose, so only real transcript text counts.
 */
async function transcriptPositions(page: Page, text: string): Promise<number[]> {
  return page.evaluate((needle) => {
    // The composer repeats its own text twice over: once in the transparent
    // mention-highlight mirror and once in the input, so its subtree is skipped
    // whole (the input's parent is the composer row that holds both).
    const composer = document.querySelector('[aria-label="Chat message input"]')
    const composerRoot = composer?.parentElement ?? null
    const hidden = (start: Element | null) => {
      for (let el: Element | null = start; el; el = el.parentElement) {
        if (el.getAttribute("aria-label") === "Queued message") return true
        if (el.getAttribute("aria-hidden") === "true") return true
        if (composerRoot && el === composerRoot) return true
        const style = (el as HTMLElement).style
        if (style && (style.pointerEvents === "none" || style.color === "transparent")) {
          return true
        }
      }
      return false
    }
    const positions: number[] = []
    const walker = document.createTreeWalker(document.body!, NodeFilter.SHOW_TEXT)
    let position = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      position += 1
      if (hidden(node.parentElement)) continue
      if ((node.nodeValue ?? "").includes(needle)) positions.push(position)
    }
    return positions
  }, text)
}

/** How many transcript bubbles carry `text`. */
async function transcriptCount(page: Page, text: string): Promise<number> {
  return (await transcriptPositions(page, text)).length
}

/** Where in the transcript `text` sits, for ordering two bubbles. -1 when absent. */
async function bubbleIndex(page: Page, text: string): Promise<number> {
  const [first] = await transcriptPositions(page, text)
  return first ?? -1
}

async function transcriptOrder(page: Page, first: string, second: string): Promise<boolean> {
  const firstIndex = await bubbleIndex(page, first)
  const secondIndex = await bubbleIndex(page, second)
  return firstIndex >= 0 && secondIndex >= 0 && firstIndex < secondIndex
}

async function waitForIdle(page: Page) {
  await page.waitForSelector('[data-testid="stop-streaming"], [aria-label="Stop"]', {
    state: "detached",
    timeout: 30_000,
  }).catch(() => {})
}

async function openProject(page: Page, api: APIRequestContext) {
  await page.goto("/")
  await page.getByRole("navigation", { name: "App sidebar" }).waitFor({
    state: "visible",
    timeout: 20_000,
  })
  const listed = await api.get(`${API_BASE_URL}/api/projects?limit=1`)
  if (!listed.ok()) throw new Error(`Unable to list local projects: ${listed.status()}`)
  const listedPayload = (await listed.json()) as {
    items?: Array<{ id: string }>
  }
  let project = listedPayload.items?.[0]

  if (!project) {
    const workspacesResponse = await api.get(
      `${API_BASE_URL}/api/workspaces?limit=1`,
    )
    if (!workspacesResponse.ok()) {
      throw new Error(`Unable to list local workspaces: ${workspacesResponse.status()}`)
    }
    const workspacesPayload = (await workspacesResponse.json()) as {
      items?: Array<{ id: string }>
    }
    const workspace = workspacesPayload.items?.[0]
    if (!workspace) throw new Error("No local workspace is available for the queue E2E")

    const created = await api.post(`${API_BASE_URL}/api/projects`, {
      data: {
        name: `Chat queue E2E ${Date.now()}`,
        description: "Chat queue E2E fixture",
        workspaceId: workspace.id,
        tier: "starter",
        status: "draft",
        accessLevel: "anyone",
      },
    })
    if (!created.ok()) throw new Error(`Unable to create local project: ${created.status()}`)
    project = ((await created.json()) as { data?: { id: string } }).data
  }

  if (!project?.id) throw new Error("Local project response did not include an id")
  await page.goto(`/projects/${project.id}`)
  await page.waitForURL(/\/projects\//, { timeout: 30_000 })
  const switchToText = page.getByText("Switch to text input", { exact: true })
  if (await switchToText.isVisible().catch(() => false)) {
    await switchToText.click()
  }
  await projectComposerInput(page).waitFor({ state: "visible", timeout: 20_000 })
  await waitForIdle(page)
}

/**
 * Send `first` with the chat POST held open so the composer is mid-turn and the
 * next sends queue instead of starting turns.
 */
async function holdATurnWith(page: Page, state: QueueMockState, first: string) {
  state.mockChat = true
  state.holdNextChat = true
  const chatSeen = new Promise<void>((resolve) => {
    state.onChatSeen = resolve
  })
  await projectComposerInput(page).fill(first)
  await page.keyboard.press("Enter")
  await chatSeen
}

/**
 * Unique prompts per test: the local API keeps its database across runs and
 * `openProject` reuses the first project, so a prompt reused from an earlier run
 * is already in that session's history — and a transcript assertion counts
 * whatever is on screen, not just this run's bubbles.
 */
function prompts(stamp: string) {
  return {
    lead: `lead prompt ${stamp}`,
    alpha: `alpha queued prompt ${stamp}`,
    beta: `beta queued prompt ${stamp}`,
  }
}

test.describe("server-backed chat queue — local UI", () => {
  test("keeps a queued prompt after reload and supports reorder/delete/edit", async ({ page }) => {
    const state: QueueMockState = {
      rows: [],
      mockChat: false,
      holdNextChat: false,
      nextRowId: 0,
      nextReply: 0,
    }
    const { lead, alpha, beta } = prompts(`reorder-${Date.now().toString(36)}`)
    await installQueueMock(page, state)
    await openProject(page, page.request)
    await holdATurnWith(page, state, lead)

    await projectComposerInput(page).fill(alpha)
    await page.keyboard.press("Enter")
    await expect(queuedRow(page, alpha).first()).toBeVisible()
    // …and it is already a transcript bubble of its own, next to the strip.
    await expect.poll(() => transcriptCount(page, alpha)).toBe(1)
    await projectComposerInput(page).fill(beta)
    await page.keyboard.press("Enter")
    await expect(queuedRow(page, beta).first()).toBeVisible()
    await expect.poll(() => transcriptCount(page, beta)).toBe(1)
    expect(state.rows).toHaveLength(2)
    // Two queued messages are two bubbles, in the order they were sent.
    await expect.poll(() => transcriptOrder(page, alpha, beta)).toBe(true)

    await queuedRow(page, alpha).first().getByLabel("Move queued message down").click()
    await expect.poll(() => state.rows.map((row) => row.content)).toEqual([beta, alpha])
    // The bubbles follow the queue, not the order they were painted in.
    await expect.poll(() => transcriptOrder(page, beta, alpha)).toBe(true)

    // Deleting a queued message takes its bubble with it: nothing is left on
    // screen for a message that will never be sent.
    await queuedRow(page, beta).first().getByLabel("Delete queued message").click()
    await expect(queuedRow(page, beta)).toHaveCount(0)
    await expect.poll(() => transcriptCount(page, beta)).toBe(0)
    await expect(queuedRow(page, alpha).first()).toBeVisible()
    await expect.poll(() => transcriptCount(page, alpha)).toBe(1)

    // Editing pulls it back into the composer; re-sending gives one bubble, not
    // one for the draft and one for the send.
    await queuedRow(page, alpha).first().getByLabel("Edit queued message").click()
    await expect.poll(() => transcriptCount(page, alpha)).toBe(0)
    await expect(projectComposerInput(page)).toHaveValue(alpha)
    await page.keyboard.press("Enter")
    await expect(queuedRow(page, alpha).first()).toBeVisible()
    await expect.poll(() => transcriptCount(page, alpha)).toBe(1)
    expect(state.rows.map((row) => row.content)).toEqual([alpha])

    state.releaseChat?.()
    await page.waitForTimeout(300)
    await page.reload()
    await expect(queuedRow(page, alpha).first()).toBeVisible()
    // Part D: a reloaded page shows the queue in the transcript too, and
    // deleting it there takes the bubble away with the row.
    await expect.poll(() => transcriptCount(page, alpha)).toBe(1)
    await queuedRow(page, alpha).first().getByLabel("Delete queued message").click()
    await expect(queuedRow(page, alpha)).toHaveCount(0)
    await expect.poll(() => transcriptCount(page, alpha)).toBe(0)
    expect(state.rows).toHaveLength(0)
  })

  test("a still-queued bubble survives the dispatch of the message ahead of it", async ({ page }) => {
    const state: QueueMockState = {
      rows: [],
      mockChat: false,
      holdNextChat: false,
      nextRowId: 0,
      nextReply: 0,
    }
    const { lead, alpha, beta } = prompts(`dispatch-${Date.now().toString(36)}`)
    await installQueueMock(page, state)
    await openProject(page, page.request)
    // Acceptance criterion for the bug: attaching a dispatch whose bubble is
    // already on screen must not reload the history.
    const historyGets: string[] = []
    page.on("request", (request) => {
      if (request.method() !== "GET") return
      if (new URL(request.url()).pathname !== "/api/chat-messages") return
      historyGets.push(request.url())
    })
    await holdATurnWith(page, state, lead)

    await projectComposerInput(page).fill(alpha)
    await page.keyboard.press("Enter")
    await expect(queuedRow(page, alpha).first()).toBeVisible()
    await projectComposerInput(page).fill(beta)
    await page.keyboard.press("Enter")
    await expect(queuedRow(page, beta).first()).toBeVisible()
    await expect.poll(() => transcriptCount(page, alpha)).toBe(1)
    await expect.poll(() => transcriptCount(page, beta)).toBe(1)

    state.releaseChat?.()
    await waitForIdle(page)

    // A turn that just finished reconciles the persisted reply with a few
    // bounded retries (~5 × 400 ms). Let that go quiet first, so a stray fetch
    // cannot be mistaken for the reload the dispatch used to pay.
    await expect
      .poll(
        async () => {
          const before = historyGets.length
          await page.waitForTimeout(700)
          return historyGets.length - before
        },
        { timeout: 20_000 },
      )
      .toBe(0)

    // The server takes the head of the queue and starts its turn.
    historyGets.length = 0
    state.rows.splice(0, 1)
    expect(state.rows.map((row) => row.content)).toEqual([beta])
    await expect.poll(() => queuedRow(page, alpha).count(), { timeout: 15_000 }).toBe(0)
    // Alpha's bubble is the turn's own message, so it stays on screen; beta is
    // still queued, so its bubble must survive the dispatch too, in order.
    await expect
      .poll(() => transcriptCount(page, alpha), { timeout: 15_000 })
      .toBe(1)
    await expect
      .poll(() => transcriptCount(page, beta), { timeout: 15_000 })
      .toBe(1)
    await expect.poll(() => transcriptOrder(page, alpha, beta)).toBe(true)
    expect(historyGets).toEqual([])
  })
})
