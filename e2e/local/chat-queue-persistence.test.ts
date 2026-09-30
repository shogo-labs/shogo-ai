// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  test,
  expect,
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

function projectComposerInput(page: Page) {
  return page.getByTestId("project-composer-input").or(
    page.getByRole("textbox", { name: "Chat message input" }),
  )
}

async function waitForIdle(page: Page) {
  await page.waitForSelector('[data-testid="stop-streaming"], [aria-label="Stop"]', {
    state: "detached",
    timeout: 30_000,
  }).catch(() => {})
}

async function openProject(page: Page) {
  await page.goto("/")
  await page.getByRole("link", { name: "Chat", exact: true }).waitFor({
    state: "visible",
    timeout: 20_000,
  })
  // Share the browser's local auto-sign-in cookie with API setup requests.
  const listed = await page.request.get(`${API_BASE_URL}/api/projects?limit=1`)
  if (!listed.ok()) throw new Error(`Unable to list local projects: ${listed.status()}`)
  const listedPayload = (await listed.json()) as {
    items?: Array<{ id: string }>
  }
  let project = listedPayload.items?.[0]

  if (!project) {
    const workspacesResponse = await page.request.get(
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

    const created = await page.request.post(`${API_BASE_URL}/api/projects`, {
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

test.describe("server-backed chat queue — local UI", () => {
  test("keeps a queued prompt after reload and supports reorder/delete", async ({ page }) => {
    const queueRows: Array<Record<string, unknown>> = []
    let nextId = 0
    let holdNextChat = false
    let mockChatRequests = false
    let chatSeenResolve: (() => void) | null = null
    let releaseHeldChat: (() => void) | null = null

    await page.route(CHAT_URL_GLOB, async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue()
      if (!mockChatRequests) return route.continue()
      if (holdNextChat) {
        holdNextChat = false
        chatSeenResolve?.()
        await new Promise<void>((resolve) => {
          releaseHeldChat = resolve
        })
      }
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: completedTurn("Mocked response"),
      })
    })

    await page.route(QUEUE_URL_GLOB, async (route: Route) => {
      const request = route.request()
      const url = new URL(request.url())
      const parts = url.pathname.split("/").filter(Boolean)
      const resourceIndex = parts.indexOf("chat-queued-messages")
      const id = parts[resourceIndex + 1]
      if (request.method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, items: queueRows, total: queueRows.length }),
        })
        return
      }
      if (request.method() === "POST" && parts.length === resourceIndex + 1) {
        const body = request.postDataJSON() as Record<string, unknown>
        const row = {
          id: `queue-e2e-${++nextId}`,
          sessionId: body.sessionId,
          userId: "local-e2e-user",
          position: queueRows.length,
          status: "pending",
          content: body.content,
          parts: body.parts,
          body: body.body,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        queueRows.push(row)
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: row }),
        })
        return
      }
      if (!id) return route.continue()
      const index = queueRows.findIndex((row) => row.id === id)
      if (request.method() === "PATCH") {
        Object.assign(queueRows[index], request.postDataJSON())
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: queueRows[index] }),
        })
        return
      }
      if (request.method() === "DELETE") {
        queueRows.splice(index, 1)
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) })
        return
      }
      if (request.method() === "POST" && parts.at(-1) === "reorder") {
        const body = request.postDataJSON() as { direction: "up" | "down" }
        const next = body.direction === "up" ? index - 1 : index + 1
        if (index >= 0 && next >= 0 && next < queueRows.length) {
          ;[queueRows[index], queueRows[next]] = [queueRows[next], queueRows[index]]
          queueRows.forEach((row, position) => { row.position = position })
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: queueRows.find((row) => row.id === id) }),
        })
        return
      }
      await route.continue()
    })

    await openProject(page)

    mockChatRequests = true
    holdNextChat = true
    const firstChatSeen = new Promise<void>((resolve) => {
      chatSeenResolve = resolve
    })
    await projectComposerInput(page).fill("first prompt")
    await page.keyboard.press("Enter")
    await firstChatSeen

    await projectComposerInput(page).fill("queued prompt")
    await page.keyboard.press("Enter")
    await expect(page.getByText("queued prompt", { exact: true })).toBeVisible()
    await projectComposerInput(page).fill("second queued prompt")
    await page.keyboard.press("Enter")
    await expect(page.getByText("second queued prompt", { exact: true })).toBeVisible()
    expect(queueRows).toHaveLength(2)

    await page.getByLabel("Move queued message down").first().click()
    await expect.poll(() => queueRows.map((row) => row.content)).toEqual([
      "second queued prompt",
      "queued prompt",
    ])

    releaseHeldChat?.()
    await page.waitForTimeout(300)
    await page.reload()
    await expect(page.getByText("queued prompt", { exact: true })).toBeVisible()
    await expect(page.getByText("second queued prompt", { exact: true })).toBeVisible()

    const queuedId = String(queueRows[0].id)
    await page.getByLabel("Delete queued message").first().click()
    await expect(page.getByText("second queued prompt", { exact: true })).toHaveCount(0)
    await expect(page.getByText("queued prompt", { exact: true })).toBeVisible()
    expect(queueRows.find((row) => row.id === queuedId)).toBeUndefined()
  })
})
