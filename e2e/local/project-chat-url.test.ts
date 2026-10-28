// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-169 — the project page keeps the open chat's id in `?chatSessionId=`, so
 * the address bar names the chat and a copied link (or a reload) lands on that
 * exact chat instead of the project's pinned/last chat.
 *
 * Driven through the real UI against the real local API: the project, its two
 * project chats and their messages go through `/api/*`, and every chat switch
 * below is the same in-place `setChatSessionId` the sidebar row, tab and
 * history list use. Only the per-project runtime URL is stubbed
 * (`/sandbox/url` → ready), because a project runtime needs the built runtime
 * template; the chat itself, the layout, the router and the mirror are real.
 *
 * Needs the local stack:
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts project-chat-url
 */
import { expect, test, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:8002"

let workspaceId = ""
let projectId = ""
let projectId2 = ""
let seedIds2: string[] = []
let alphaId = ""
let bravoId = ""

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

/** Session ids whose transcript the chat panel fetched (`chat-messages?sessionId=`). */
function trackChatLoads(page: Page): string[] {
  const ids: string[] = []
  page.on("request", (request) => {
    const match = request.url().match(/chat-messages\?sessionId=([^&]+)/)
    if (match) ids.push(decodeURIComponent(match[1]))
  })
  return ids
}

/**
 * A project runtime needs the built runtime template, which the local stack
 * does not have: without this the page sits on "Starting your project…" and no
 * chat panel renders. The chat itself still goes to the real API.
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

async function useTeamWorkspace(page: Page) {
  await page.evaluate((id) => {
    localStorage.setItem("shogo:active-workspace-id", id)
    localStorage.setItem("shogo:active-workspace-kind", "team")
  }, workspaceId)
}

/** Stub the runtime, land on the app (localStorage needs a document) and pick the team workspace. */
async function prepare(page: Page) {
  await stubProjectRuntime(page)
  await page.goto("/")
  await page.getByRole("navigation", { name: "App sidebar" }).first().waitFor({ timeout: 120_000 })
  await useTeamWorkspace(page)
}

async function openProject(page: Page, search = "", project = projectId) {
  await page.goto(`/projects/${project}${search}`)
  await composer(page).waitFor({ state: "visible", timeout: 120_000 })
}

function composer(page: Page) {
  return page.getByRole("textbox", { name: "Chat message input" }).first()
}

function chatParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get("chatSessionId")
}

test.describe("Project chat URL (local)", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 1440, height: 900 } })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await stubProjectRuntime(page)
    await page.goto("/")
    await page.getByRole("navigation", { name: "App sidebar" }).first().waitFor({ timeout: 120_000 })

    const suffix = Date.now().toString(36)
    const workspace = await apiJson(page, "POST", "/api/workspaces", { name: `QA chat url ${suffix}`, kind: "team" })
    workspaceId = workspace.json?.data?.id ?? workspace.json?.id
    expect(workspaceId, JSON.stringify(workspace.json)).toBeTruthy()

    const project = await apiJson(page, "POST", "/api/projects", {
      name: `QA chat url ${suffix}`,
      workspaceId,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
      schemas: [],
      settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
    })
    projectId = project.json?.data?.id ?? project.json?.id
    expect(projectId, JSON.stringify(project.json)).toBeTruthy()

    for (const name of ["Alpha", "Bravo"]) {
      const created = await apiJson(page, "POST", "/api/chat-sessions", {
        contextId: projectId,
        contextType: "project",
        inferredName: `Chat ${name}`,
        name: `Chat ${name}`,
      })
      const id = created.json?.data?.id ?? created.json?.id
      expect(id, JSON.stringify(created.json)).toBeTruthy()
      if (name === "Alpha") alphaId = id
      else bravoId = id
    }

    // A message per chat, so "the right chat opened" is also visible on screen.
    for (const [id, text] of [
      [alphaId, `ALPHA-SEED-${suffix}`],
      [bravoId, `BRAVO-SEED-${suffix}`],
    ] as const) {
      const seeded = await apiJson(page, "POST", "/api/chat-messages", {
        sessionId: id,
        role: "user",
        content: text,
      })
      expect(seeded.status, JSON.stringify(seeded.json)).toBeLessThan(300)
    }

    // A second project with no chat the app has ever restored: an arriving
    // `?newChat=1` only creates its chat when the project has none of its own
    // yet (pre-existing behaviour, see SHO-175), so this is what makes the
    // arrival case measurable at all.
    const project2 = await apiJson(page, "POST", "/api/projects", {
      name: `QA chat url ${suffix} two`,
      workspaceId,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
      schemas: [],
      settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
    })
    projectId2 = project2.json?.data?.id ?? project2.json?.id
    expect(projectId2, JSON.stringify(project2.json)).toBeTruthy()
    for (const name of ["Charlie", "Delta"]) {
      const created = await apiJson(page, "POST", "/api/chat-sessions", {
        contextId: projectId2,
        contextType: "project",
        inferredName: `Chat ${name}`,
        name: `Chat ${name}`,
      })
      expect(created.json?.data?.id ?? created.json?.id, JSON.stringify(created.json)).toBeTruthy()
      seedIds2.push(created.json?.data?.id ?? created.json?.id)
    }

    await page.close()
  })

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage()
    if (projectId) await page.request.delete(`${API}/api/projects/${projectId}`).catch(() => {})
    if (workspaceId) await page.request.delete(`${API}/api/workspaces/${workspaceId}`).catch(() => {})
    await page.close()
  })

  test("opening a project puts the chat it opened in the URL", async ({ page }) => {
    const loads = trackChatLoads(page)
    await prepare(page)
    await openProject(page)

    await expect.poll(() => chatParam(page), { timeout: 20_000 }).toBeTruthy()
    const named = chatParam(page)!
    expect(new URL(page.url()).pathname).toBe(`/projects/${projectId}`)
    // The chat the URL names is the one the panel actually loaded.
    await expect.poll(() => loads.includes(named), { timeout: 20_000 }).toBe(true)
  })

  test("clicking a chat in the sidebar names it, in place, without a Back entry", async ({ page }) => {
    const loads = trackChatLoads(page)
    await prepare(page)
    await openProject(page)
    await expect.poll(() => chatParam(page), { timeout: 20_000 }).toBeTruthy()

    const entriesBefore = await page.evaluate(() => history.length)
    const pathBefore = new URL(page.url()).pathname

    await page.getByLabel("Chat: Chat Alpha").click()
    await expect.poll(() => chatParam(page), { timeout: 20_000 }).toBe(alphaId)
    expect(new URL(page.url()).pathname).toBe(pathBefore)
    await expect.poll(() => loads.includes(alphaId), { timeout: 20_000 }).toBe(true)

    await page.getByLabel("Chat: Chat Bravo").click()
    await expect.poll(() => chatParam(page), { timeout: 20_000 }).toBe(bravoId)
    await expect.poll(() => loads.includes(bravoId), { timeout: 20_000 }).toBe(true)

    // Switching chats must not stack browser-history entries (AC6).
    expect(await page.evaluate(() => history.length)).toBe(entriesBefore)
  })

  // SHO-174: a cold load of ?chatSessionId=<chat> opens the project's pinned
  // chat, not the one in the URL — on origin/main too, i.e. this PR neither
  // causes nor fixes the read side. Kept as fixme so it starts enforcing the
  // moment SHO-174 lands instead of either going red or being deleted.
  test.fixme("a copied URL opens that exact chat, and a reload keeps it", async ({ page }) => {
    const loads = trackChatLoads(page)
    await prepare(page)
    await openProject(page, `?chatSessionId=${bravoId}`)

    await expect.poll(() => chatParam(page), { timeout: 20_000 }).toBe(bravoId)
    await expect(page.getByText(/BRAVO-SEED-/).first()).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => loads.includes(bravoId), { timeout: 20_000 }).toBe(true)

    await page.reload()
    await composer(page).waitFor({ state: "visible", timeout: 120_000 })
    expect(chatParam(page)).toBe(bravoId)
    await expect(page.getByText(/BRAVO-SEED-/).first()).toBeVisible({ timeout: 20_000 })
  })

  test("+ new chat names the new chat and drops the one-shot params", async ({ page }) => {
    await prepare(page)
    await openProject(page)

    // Opening the project already names a chat, so wait for the param to
    // *change* — polling for "truthy" would read the pre-click value.
    const before = chatParam(page)
    await page.getByLabel("New chat", { exact: true }).first().click()
    await expect
      .poll(
        () => {
          const current = chatParam(page)
          return current && current !== before ? current : ""
        },
        { timeout: 40_000 },
      )
      .toMatch(/^[0-9a-f][0-9a-f-]{30,}$/)
    const created = chatParam(page)!
    expect([alphaId, bravoId]).not.toContain(created)
    const url = new URL(page.url())
    expect(url.searchParams.get("newChat")).toBeNull()
    expect(url.searchParams.get("newChatNonce")).toBeNull()
  })

  test("a newChat link creates its chat and leaves no one-shot params behind", async ({ page }) => {
    await prepare(page)
    // Own project: an arriving newChat on a project that already has a chat the
    // screen restores is ignored (pre-existing, SHO-175), which would make this
    // assert the wrong thing.
    await openProject(page, `?newChat=1&newChatNonce=${Date.now()}`, projectId2)

    // The named chat must be the one this arrival created, i.e. neither of the
    // two chats the project was seeded with.
    await expect
      .poll(
        () => {
          const current = chatParam(page)
          return current && !seedIds2.includes(current) ? current : ""
        },
        { timeout: 40_000 },
      )
      .toMatch(/^[0-9a-f][0-9a-f-]{30,}$/)
    const url = new URL(page.url())
    expect(url.searchParams.get("newChat")).toBeNull()
    expect(url.searchParams.get("newChatNonce")).toBeNull()
  })

  test("an unknown chat id falls back to the project chat and corrects the URL", async ({ page }) => {
    await prepare(page)
    await openProject(page, `?chatSessionId=not-a-real-chat-${Date.now()}`)

    await expect.poll(() => chatParam(page), { timeout: 40_000 }).not.toMatch(/^not-a-real-chat-/)
    // A real chat of this project, not a blank panel: the panel loaded a chat
    // and the composer is ready.
    await expect(composer(page)).toBeVisible()
  })
})
