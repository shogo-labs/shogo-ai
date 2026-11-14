// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-367: you never see your own name in the typing indicator — not in a
 * channel, not in a thread, and not in your other window.
 *
 * The server broadcasts `typing` to the whole workspace, typist included, so
 * every window of the typist receives the event. The client has to drop it, and
 * the id it drops on must be the one the server stamped on the event (the
 * socket's `ready.userId`), not whatever `useAuth()`/`useWorkspaceUser` reports.
 *
 * The probe socket below is a *second connection of the same user*, so the
 * `typing` frame it records proves the server really did deliver the typist's
 * own event to this user's sockets — the UI must still show nothing. Another
 * person typing still shows: `desktop-cloud-workspaces.test.ts` covers that
 * with a real second user.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test"
import { LOCAL_API_BASE, openTeamHome } from "./helpers"

const suffix = Date.now().toString(36)

async function apiJson(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(`${LOCAL_API_BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    data: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status(), json }
}

/** A second team-chat socket for the signed-in user, in its own browser context. */
async function probeSocket(browser: Browser, baseURL: string, page: Page, workspaceId: string) {
  const context = await browser.newContext({ baseURL, storageState: await page.context().storageState() })
  const probe = await context.newPage()
  await probe.goto("/")
  await probe.evaluate((url) => {
    const w = window as any
    w.frames_ = []
    w.sock = new WebSocket(url)
    w.sock.onmessage = (ev: MessageEvent) => w.frames_.push(JSON.parse(ev.data))
    return new Promise((resolve) => ((w as any).sock.onopen = resolve))
  }, `${LOCAL_API_BASE.replace(/^http/, "ws")}/api/workspaces/${workspaceId}/rt`)
  return {
    frames: () => probe.evaluate(() => (window as any).frames_ as any[]),
    close: () => context.close(),
  }
}

async function openComposer(page: Page, channelId: string, threadRootId?: string) {
  await page.goto(threadRootId ? `/c/${channelId}?thread=${threadRootId}` : `/c/${channelId}`)
  const composer = page.getByLabel("Message", { exact: true }).last()
  await composer.waitFor({ state: "visible", timeout: 30_000 })
  return composer
}

test.describe("Team chat: you never see your own typing", () => {
  test.describe.configure({ mode: "serial" })
  test.setTimeout(180_000)

  let browser: Browser
  let baseURL: string
  let context: BrowserContext
  let windowA: Page
  let windowB: Page
  let workspaceId: string
  let channelId: string
  let threadRootId: string

  test.beforeAll(async ({ browser: b }, info) => {
    browser = b
    baseURL = String(info.project.use.baseURL)
    // One context, two windows: the same signed-in user, each window with its
    // own socket. (`browser.newPage()` cannot hand out a second page.)
    context = await browser.newContext({ baseURL })
    windowA = await context.newPage()
    await windowA.setViewportSize({ width: 1440, height: 900 })
    await openTeamHome(windowA)
    windowB = await context.newPage()
    await windowB.setViewportSize({ width: 1440, height: 900 })

    const workspaces = await apiJson(windowA, "GET", "/api/workspaces")
    const rows = (workspaces.json?.items ?? workspaces.json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
    workspaceId = rows.find((w) => w.kind !== "personal")!.id

    const channel = await apiJson(windowA, "POST", `/api/workspaces/${workspaceId}/conversations`, {
      name: `own-typing-${suffix}`,
      kind: "public",
    })
    channelId = channel.json?.conversation?.id
    expect(channelId, JSON.stringify(channel.json)).toBeTruthy()

    const posted = await apiJson(windowA, "POST", `/api/conversations/${channelId}/messages`, {
      text: `thread root ${suffix}`,
      clientMsgId: `root-${suffix}`,
    })
    expect(posted.status, JSON.stringify(posted.json)).toBeLessThan(300)
    threadRootId = posted.json?.message?.id
    expect(threadRootId, JSON.stringify(posted.json)).toBeTruthy()
  })

  test.afterAll(async () => {
    await context?.close()
  })

  test("typing in a channel shows in no window of the typist, though the server does deliver it", async () => {
    const probe = await probeSocket(browser, baseURL, windowA, workspaceId)
    try {
      const composerA = await openComposer(windowA, channelId)
      await openComposer(windowB, channelId)

      await composerA.click()
      await composerA.pressSequentially("drafting the reply in a channel", { delay: 120 })

      // The server still sends my own typing to my own sockets...
      await expect(async () => {
        const frames = await probe.frames()
        const own = frames.find((f) => f.type === "typing" && f.conversationId === channelId && !f.threadRootId)
        expect(own, JSON.stringify(frames)).toBeTruthy()
        // ...under the exact name the indicator would render.
        await expect(windowA.getByText(`${own.name} is typing`, { exact: false })).toHaveCount(0)
        await expect(windowB.getByText(`${own.name} is typing`, { exact: false })).toHaveCount(0)
      }).toPass({ timeout: 15_000 })

      // No typing line at all: the only typist is me.
      await expect(windowA.getByText("is typing", { exact: false })).toHaveCount(0)
      await expect(windowB.getByText("is typing", { exact: false })).toHaveCount(0)
    } finally {
      await probe.close()
    }
  })

  test("typing in a thread shows in no window of the typist, though the server does deliver it", async () => {
    const probe = await probeSocket(browser, baseURL, windowA, workspaceId)
    try {
      const composerA = await openComposer(windowA, channelId, threadRootId)
      await openComposer(windowB, channelId, threadRootId)

      await composerA.click()
      await composerA.pressSequentially("drafting the reply in a thread", { delay: 120 })

      await expect(async () => {
        const frames = await probe.frames()
        const own = frames.find((f) => f.type === "typing" && f.conversationId === channelId && f.threadRootId === threadRootId)
        expect(own, JSON.stringify(frames)).toBeTruthy()
        await expect(windowA.getByText(`${own.name} is typing`, { exact: false })).toHaveCount(0)
        await expect(windowB.getByText(`${own.name} is typing`, { exact: false })).toHaveCount(0)
      }).toPass({ timeout: 15_000 })

      await expect(windowA.getByText("is typing", { exact: false })).toHaveCount(0)
      await expect(windowB.getByText("is typing", { exact: false })).toHaveCount(0)
    } finally {
      await probe.close()
    }
  })
})
