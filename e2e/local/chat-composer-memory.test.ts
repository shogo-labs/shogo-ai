// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-261 — per-chat composer memory.
 *
 * Each agent chat keeps its own model pick and its own unsent draft in the
 * device cache (`AsyncStorage` → `localStorage` on web), so both survive
 * switching chats, leaving the screen and a reload — and neither leaks into a
 * different chat.
 *
 * Driven through the real UI against the real local API: the workspace, the
 * two projects and their chats are seeded through `/api/*`, and every chat
 * switch is the sidebar row click the app itself uses. Two things are stubbed:
 *  - the per-project runtime URL (a project runtime needs the built template),
 *  - the chat turn itself, so a send finishes without reaching a model and the
 *    test can read the `agentMode` the composer actually sent.
 *
 * The shell keeps a chat panel per open chat mounted side by side, so every
 * locator here is scoped to the panel that shows the chat's own marker line
 * (see `markChatPanel`), never to "the first composer on the page" — and each
 * chat is named and seeded with a marker unique to that `makeChat` call, since
 * a name shared with another chat makes "the panel showing this chat"
 * ambiguous and the failure then reads as a restore bug.
 *
 * Needs the local stack; `E2E_LOCAL_START_STACK=1` boots it:
 *   npx playwright test --config e2e/local/playwright.config.ts chat-composer-memory
 */
import { expect, test, type Locator, type Page, type Route } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:8002"

let workspaceId = ""
let projectId = ""
let projectName = ""
let otherProjectId = ""
let otherProjectName = ""

interface SentTurn {
  agentMode?: string
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

function completedTurn(text: string): string {
  const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`
  return [
    frame({ type: "start", messageId: `sho261_msg_${Date.now()}` }),
    frame({ type: "start-step" }),
    frame({ type: "text-start", id: "sho261_text" }),
    frame({ type: "text-delta", id: "sho261_text", delta: text }),
    frame({ type: "text-end", id: "sho261_text" }),
    frame({ type: "finish-step" }),
    frame({ type: "finish" }),
  ].join("")
}

/**
 * Answer every chat turn locally, recording the `agentMode` the composer put on
 * the request (AC5: the pick, not the fallback, is what A's next message sends).
 */
async function mockChatTurns(page: Page): Promise<SentTurn[]> {
  const sent: SentTurn[] = []
  await page.route("**/api/{projects,workspaces}/*/chat", async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue()
    let body: Record<string, unknown> = {}
    try {
      body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>
    } catch {
      body = {}
    }
    sent.push({ agentMode: typeof body.agentMode === "string" ? body.agentMode : undefined })
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: completedTurn("Noted."),
    })
  })
  // The live-turn probe the composer runs before sending.
  for (const glob of ["**/api/projects/*/chat/*/turn", "**/api/workspaces/*/chat/*/turn"]) {
    await page.route(glob, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "completed" }),
      }),
    )
  }
  return sent
}

async function useTeamWorkspace(page: Page) {
  await page.evaluate((id) => {
    localStorage.setItem("shogo:active-workspace-id", id)
    localStorage.setItem("shogo:active-workspace-kind", "team")
  }, workspaceId)
}

/** Stub the runtime, land on the app (localStorage needs a document), pick the team workspace. */
async function prepare(page: Page) {
  // A panel crash surfaces as a blank chat with a "Retry" button; without the
  // stack there is nothing to report against.
  page.on("pageerror", (error) =>
    console.log("PAGEERROR", (error as Error)?.stack ?? String(error)),
  )
  await stubProjectRuntime(page)
  await page.goto("/")
  await page.getByRole("navigation", { name: "App sidebar" }).first().waitFor({ timeout: 120_000 })
  await useTeamWorkspace(page)
}

function anyComposer(page: Page): Locator {
  return page.getByRole("textbox", { name: "Chat message input" }).first()
}

async function openProject(page: Page) {
  await page.goto(`/projects/${projectId}`)
  await anyComposer(page).waitFor({ state: "visible", timeout: 120_000 })
}

/** The one line of transcript that proves which chat a panel is showing. */
function markerFor(name: string): string {
  return `MARKER-${name.replace(/\s+/g, "-")}`
}

function slugFor(name: string): string {
  return name.replace(/\s+/g, "-")
}

const PANEL_ATTR = "data-qa-chat-panel"

/**
 * Stamp `data-qa-chat-panel` on every chat panel whose subtree shows this
 * chat's marker, so every later locator can be scoped to a panel that is really
 * showing this chat.
 *
 * The shell keeps several panels mounted for one chat (compact and wide
 * variants) at the same on-screen coordinates — "the first composer on the
 * page" is not the chat you think it is, and neither is "the first marked
 * panel", so the caller still has to prefer the visible one.
 */
async function markChatPanel(page: Page, name: string): Promise<boolean> {
  return page.evaluate(
    ({ marker, attr, slug }) => {
      const inputs = Array.from(document.querySelectorAll('[aria-label="Chat message input"]'))
      const panels: Element[] = []
      for (const input of inputs) {
        let node: Element | null = input.parentElement
        let depth = 0
        while (node && depth < 40) {
          depth += 1
          if ((node.textContent ?? "").includes(marker)) {
            panels.push(node)
            break
          }
          node = node.parentElement
        }
      }
      if (panels.length === 0) return false
      // Keep the tightest panel per chat: an outer container can also hold
      // other chats' panels (and the sidebar), so marking it would let a later
      // locator pick someone else's composer.
      const innermost = panels.filter(
        (candidate) => !panels.some((other) => other !== candidate && candidate.contains(other)),
      )
      document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr))
      for (const el of innermost) el.setAttribute(attr, slug)
      return true
    },
    { marker: markerFor(name), attr: PANEL_ATTR, slug: slugFor(name) },
  )
}

/**
 * Every panel currently marked as showing `name` (there can be more than one —
 * the compact and wide chrome), or the whole page when nothing could be marked.
 */
async function markedRoot(page: Page, name: string): Promise<Locator> {
  const marked = await markChatPanel(page, name).catch(() => false)
  if (!marked) return page.locator("body")
  return page.locator(`[${PANEL_ATTR}="${slugFor(name)}"]`)
}

async function composer(page: Page, name: string): Promise<Locator> {
  const candidates = (await markedRoot(page, name)).getByRole("textbox", {
    name: "Chat message input",
  })
  const count = await candidates.count()
  for (let index = 0; index < count; index++) {
    const box = candidates.nth(index)
    if (await box.isVisible().catch(() => false)) return box
  }
  return candidates.first()
}

async function modelTrigger(page: Page, name: string): Promise<Locator> {
  const candidates = (await markedRoot(page, name)).getByRole("button", { name: "Choose model" })
  const count = await candidates.count()
  for (let index = 0; index < count; index++) {
    const trigger = candidates.nth(index)
    if (await trigger.isVisible().catch(() => false)) return trigger
  }
  return candidates.first()
}

/** Wait until this chat's composer holds exactly `text`. */
async function expectDraft(page: Page, name: string, text: string) {
  await expect
    .poll(
      async () => {
        // Re-scope on every tick: a panel is marked only once its transcript
        // renders, and a chat that is still loading has no composer to read yet.
        const box = await composer(page, name)
        if ((await box.count()) === 0) return "<no composer>"
        return box.inputValue({ timeout: 2_000 }).catch(() => "<detached>")
      },
      { timeout: 30_000 },
    )
    .toBe(text)
}

/**
 * Wait until the draft is really in the device cache — the thing a reload reads
 * from. Waiting a fixed number of milliseconds instead makes the reload case a
 * race against the write, which is exactly what AC3 is supposed to guarantee.
 */
async function expectStoredDraft(page: Page, text: string) {
  await expect
    .poll(
      () =>
        page.evaluate((draft) => {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i) ?? ""
            const value = localStorage.getItem(key) ?? ""
            if (key.includes("chat-composer") && value.includes(draft)) return true
          }
          return false
        }, text),
      { timeout: 15_000 },
    )
    .toBe(true)
}

/** Every chat-composer entry currently in localStorage — diagnostics only. */
async function dumpComposerStorage(page: Page): Promise<string> {
  return page.evaluate(() => {
    const entries: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) ?? ""
      if (key.includes("chat-composer")) {
        entries.push(`${key}=${(localStorage.getItem(key) ?? "").slice(0, 200)}`)
      }
    }
    return entries.sort().join(" | ")
  })
}

/** The short label the composer's model trigger paints. */
async function shownModel(page: Page, name: string): Promise<string> {
  return ((await (await modelTrigger(page, name)).innerText()) ?? "").trim()
}

/**
 * Type into a chat's composer. `fill` on the right panel, not a click: the
 * panels overlap, so a click would land on whichever is painted on top.
 */
async function typeDraft(page: Page, name: string, text: string) {
  await (await composer(page, name)).fill(text)
}

function chatParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get("chatSessionId")
}

/**
 * A fresh chat on the project, named so its sidebar row is addressable, and
 * seeded with one message so "the panel really is on this chat" is observable
 * on screen (see `markChatPanel`).
 */
let chatToken = 0

/**
 * A fresh chat on the project whose **name is unique to this call**.
 *
 * Two chats in one project can be created with the same base name (each test
 * makes its own "Chat Alpha"), and both are seeded with the same marker line.
 * Every locator here is scoped by that marker, so a shared name makes "the
 * panel showing this chat" ambiguous — the sidebar row, `markChatPanel` and the
 * composer would all be free to resolve to the *other* chat's panel, which is
 * how AC3 looked like a restore race when the wrong box was being read.
 */
async function makeChat(
  page: Page,
  base: string,
): Promise<{ id: string; name: string }> {
  chatToken += 1
  const name = `${base} ${Date.now().toString(36)}${chatToken}`
  const created = await apiJson(page, "POST", "/api/chat-sessions", {
    contextId: projectId,
    contextType: "project",
    inferredName: name,
    name,
  })
  const id = created.json?.data?.id ?? created.json?.id
  expect(id, JSON.stringify(created.json)).toBeTruthy()
  const marker = markerFor(name)
  const seeded = await apiJson(page, "POST", "/api/chat-messages", {
    sessionId: id,
    role: "user",
    content: marker,
    // A row the turn machinery wrote carries `parts`; a null `parts` is a
    // legacy shape and crashes the panel on render (see the AC8 note below).
    parts: JSON.stringify([{ type: "text", text: marker }]),
  })
  expect(seeded.status, JSON.stringify(seeded.json)).toBeLessThan(300)
  return { id: id as string, name }
}

/**
 * Wait for this chat's composer to hold `text` after a reload, and on failure
 * report what the device cache holds — an empty box *with* the draft still in
 * storage is a restore bug, an empty box with the record gone is a write bug,
 * and the two must never be confused in a failure report.
 */
async function expectRestoredDraft(page: Page, name: string, text: string) {
  const deadline = Date.now() + 20_000
  let seen = ""
  while (Date.now() < deadline) {
    seen = await (await composer(page, name)).inputValue()
    if (seen === text) return
    await page.waitForTimeout(250)
  }
  throw new Error(
    `draft not restored after reload: composer held ${JSON.stringify(seen)}, ` +
      `expected ${JSON.stringify(text)}; storage: ${await dumpComposerStorage(page)}`,
  )
}

/**
 * Switch chats the way a person does: click the sidebar row, in place. When
 * `draft` is given, also wait for that chat's composer to hold it — entering a
 * chat pushes that chat's own stored draft into its box, so waiting for the
 * settled value is both the wait and the check.
 */
async function openChat(page: Page, name: string, id: string, draft?: string) {
  await page.getByLabel(`Chat: ${name}`, { exact: true }).first().click()
  await expect.poll(() => chatParam(page), { timeout: 30_000 }).toBe(id)
  // The URL naming the chat is not enough: a panel must be showing it.
  await expect.poll(() => markChatPanel(page, name), { timeout: 30_000 }).toBe(true)
  if (draft !== undefined) await expectDraft(page, name, draft)
}

/**
 * Open the picker and select a model this chat is not already on.
 *
 * The trigger paints `shortDisplayName` ("Opus") while the row paints
 * `displayName` ("Opus 5"), so comparing the two texts is meaningless — and
 * the picker's first row is usually the model already in force. Pick a row
 * whose text plainly names a *different* model, then prove the pick landed by
 * watching the trigger change.
 */
async function pickModel(
  page: Page,
  name: string,
  avoid: string[] = [],
): Promise<{ model: string; label: string }> {
  const before = await shownModel(page, name)
  // `force`: the shell keeps several chat panels mounted at the same
  // coordinates, and a sibling panel painted on top intercepts pointer events
  // even though the trigger we scoped to is the right one.
  await (await modelTrigger(page, name)).click({ force: true })
  const rows = page
    .locator('[data-testid^="model-option-"]')
    .filter({ hasNot: page.getByText("requires Pro") })
  await expect(rows.first()).toBeVisible({ timeout: 15_000 })

  const skipped: string[] = []
  let pick: { testId: string; text: string } | null = null
  for (const row of await rows.all()) {
    const testId = (await row.getAttribute("data-testid")) ?? ""
    const text = (((await row.innerText()) ?? "").trim().split("\n")[0] ?? "").trim()
    if (!testId || !text) continue
    if (text.toLowerCase().startsWith(before.toLowerCase())) continue
    if (avoid.some((label) => text.toLowerCase().startsWith(label.toLowerCase()))) {
      skipped.push(text)
      continue
    }
    pick = { testId, text }
    break
  }
  expect(
    pick,
    `no selectable model besides "${before}" (avoided: ${avoid.join(", ")}; skipped: ${skipped.join(", ")})`,
  ).not.toBeNull()

  await page.getByTestId(pick!.testId).click({ force: true })
  const label = await expect
    .poll(() => shownModel(page, name), { timeout: 15_000 })
    .not.toBe(before)
    .then(() => shownModel(page, name))
  return { model: pick!.testId.replace("model-option-", ""), label }
}

test.describe("Per-chat composer memory (local)", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 1440, height: 900 } })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000)
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await stubProjectRuntime(page)
    await page.goto("/")
    await page.getByRole("navigation", { name: "App sidebar" }).first().waitFor({ timeout: 120_000 })

    const suffix = Date.now().toString(36)
    const workspace = await apiJson(page, "POST", "/api/workspaces", {
      name: `QA composer memory ${suffix}`,
      kind: "team",
    })
    workspaceId = workspace.json?.data?.id ?? workspace.json?.id
    expect(workspaceId, JSON.stringify(workspace.json)).toBeTruthy()

    // Distinct, non-prefix names: the sidebar truncates them, and a label that
    // is a prefix of its sibling would match both rows.
    projectName = `QA composer alpha ${suffix}`
    const project = await apiJson(page, "POST", "/api/projects", {
      name: projectName,
      workspaceId,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
      schemas: [],
      settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
    })
    projectId = project.json?.data?.id ?? project.json?.id
    expect(projectId, JSON.stringify(project.json)).toBeTruthy()

    // A second project: the in-app "navigate away and come back" path of AC2 is
    // a project switch, which unmounts the chat panel for real.
    otherProjectName = `QA composer bravo ${suffix}`
    const other = await apiJson(page, "POST", "/api/projects", {
      name: otherProjectName,
      workspaceId,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
      schemas: [],
      settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
    })
    otherProjectId = other.json?.data?.id ?? other.json?.id
    expect(otherProjectId, JSON.stringify(other.json)).toBeTruthy()

    await page.close()
  })

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage()
    if (projectId) await page.request.delete(`${API}/api/projects/${projectId}`).catch(() => {})
    if (otherProjectId) await page.request.delete(`${API}/api/projects/${otherProjectId}`).catch(() => {})
    if (workspaceId) await page.request.delete(`${API}/api/workspaces/${workspaceId}`).catch(() => {})
    await page.close()
  })

  test("AC 1-2: each chat keeps its own unsent text, in place and across navigation", async ({
    page,
  }) => {
    test.setTimeout(240_000)
    await mockChatTurns(page)
    await prepare(page)
    const stamp = Date.now().toString(36)
    const alpha = `Chat Alpha draft ${stamp}`
    const bravo = `Chat Bravo draft ${stamp}`
    // The sidebar list is rendered per page load, so the chats exist before the
    // page that lists them opens.
    const alphaChat = await makeChat(page, "Chat Alpha")
    const bravoChat = await makeChat(page, "Chat Bravo")
    await openProject(page)

    await openChat(page, alphaChat.name, alphaChat.id, "")
    await typeDraft(page, alphaChat.name, alpha)
    // No debounce wait: navigating away must flush the pending write.
    await page.getByLabel(`Project: ${otherProjectName}`, { exact: true }).first().click()
    await page.waitForURL(new RegExp(`/projects/${otherProjectId}`), { timeout: 60_000 })

    // AC2: back on the first project, chat A still holds the text. The sidebar
    // row is the in-app path; a goto would be the reload case in the next test.
    await page.getByLabel(`Project: ${projectName}`, { exact: true }).first().click()
    await page.waitForURL(new RegExp(`/projects/${projectId}`), { timeout: 60_000 })
    await anyComposer(page).waitFor({ state: "visible", timeout: 120_000 })
    await openChat(page, alphaChat.name, alphaChat.id, alpha)

    // AC1: chat B is its own box — never A's text.
    await openChat(page, bravoChat.name, bravoChat.id, "")
    await typeDraft(page, bravoChat.name, bravo)

    await openChat(page, alphaChat.name, alphaChat.id, alpha)
    await openChat(page, bravoChat.name, bravoChat.id, bravo)
  })

  test("AC 3-4: the draft survives a reload, and a sent message leaves nothing behind", async ({
    page,
  }) => {
    test.setTimeout(240_000)
    const sent = await mockChatTurns(page)
    await prepare(page)
    const alpha = `Chat Alpha reload ${Date.now().toString(36)}`
    const alphaChat = await makeChat(page, "Chat Alpha")
    const bravoChat = await makeChat(page, "Chat Bravo")
    await openProject(page)

    await openChat(page, alphaChat.name, alphaChat.id, "")
    await typeDraft(page, alphaChat.name, alpha)
    // Give the debounced write its window, then reload: a reload is exactly the
    // restart AC3 is about, and it re-reads the device cache from scratch.
    await expectStoredDraft(page, alpha)
    await page.reload()
    await anyComposer(page).waitFor({ state: "visible", timeout: 120_000 })
    await openChat(page, alphaChat.name, alphaChat.id)
    await expectRestoredDraft(page, alphaChat.name, alpha)

    // AC4: sending empties the box, and a reload does not resurrect the text.
    await (await composer(page, alphaChat.name)).press("Enter")
    await expectDraft(page, alphaChat.name, "")
    await expect.poll(() => sent.length, { timeout: 30_000 }).toBeGreaterThan(0)
    await page.reload()
    await anyComposer(page).waitFor({ state: "visible", timeout: 120_000 })
    await openChat(page, alphaChat.name, alphaChat.id, "")

    // The other chat is untouched by any of it.
    await openChat(page, bravoChat.name, bravoChat.id, "")
  })

  /**
   * AC3 with the first paint starved of CPU. The restore races the panel's
   * mount, so a run that passes on a fast machine can fail on a slow one; this
   * makes that race deterministic instead of leaving it to luck (QA's round-2
   * report: "the rate rises with any render slowdown").
   */
  test("AC 3 stress: a slow first paint still restores the draft", async ({ page }) => {
    test.setTimeout(240_000)
    await mockChatTurns(page)
    await prepare(page)
    const alpha = `Chat Alpha slow ${Date.now().toString(36)}`
    const alphaChat = await makeChat(page, "Chat Alpha")
    await openProject(page)

    await openChat(page, alphaChat.name, alphaChat.id, "")
    await typeDraft(page, alphaChat.name, alpha)
    await expectStoredDraft(page, alpha)

    const cdp = await page.context().newCDPSession(page)
    try {
      for (const rate of [8, 20]) {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate })
        await page.reload()
        await anyComposer(page).waitFor({ state: "visible", timeout: 120_000 })
        await openChat(page, alphaChat.name, alphaChat.id)
        await expectRestoredDraft(page, alphaChat.name, alpha)
      }
    } finally {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {})
    }
  })

  test("AC 5-8: a model pick belongs to its chat, and a newer stamped message wins", async ({
    page,
  }) => {
    test.setTimeout(240_000)
    const sent = await mockChatTurns(page)
    await prepare(page)
    const alphaChat = await makeChat(page, "Chat Alpha")
    const bravoChat = await makeChat(page, "Chat Bravo")
    await openProject(page)
    const stamp = Date.now().toString(36)

    await openChat(page, alphaChat.name, alphaChat.id, "")
    const initialLabel = await shownModel(page, alphaChat.name)
    const { model: modelX, label: labelX } = await pickModel(page, alphaChat.name, [initialLabel])
    expect(labelX).not.toBe(initialLabel)

    // AC5/AC6: chat B is "on model Y" — a chat with no pick of its own follows
    // the last pick anywhere (AC7), so give B its own before A can be blamed
    // for what B shows. Then A's pick must not have moved B.
    await openChat(page, bravoChat.name, bravoChat.id, "")
    const { model: modelY, label: labelY } = await pickModel(page, bravoChat.name, [labelX])
    expect(labelY).not.toBe(labelX)
    await openChat(page, alphaChat.name, alphaChat.id)
    expect(await shownModel(page, alphaChat.name)).toBe(labelX)
    await openChat(page, bravoChat.name, bravoChat.id)
    expect(await shownModel(page, bravoChat.name)).toBe(labelY)

    // Back in A the pick is still there, unsent — and it is what A sends.
    await openChat(page, alphaChat.name, alphaChat.id)
    expect(await shownModel(page, alphaChat.name)).toBe(labelX)
    await typeDraft(page, alphaChat.name, `model pick message ${stamp}`)
    await (await composer(page, alphaChat.name)).press("Enter")
    await expect.poll(() => sent.length, { timeout: 30_000 }).toBeGreaterThan(0)
    expect(sent[0]?.agentMode).toBe(modelX)

    // AC8: a model-stamped message newer than the pick (e.g. sent from another
    // device) wins over it. `parts` is the shape a real turn writes: an
    // assistant row with a null `parts` trips an unguarded `.parts.map` in
    // ChatPanel's island preview (pre-existing on main, tracked separately).
    const stamped = `stamped from another device ${stamp}`
    const seeded = await apiJson(page, "POST", "/api/chat-messages", {
      sessionId: alphaChat.id,
      role: "assistant",
      content: stamped,
      parts: JSON.stringify([{ type: "text", text: stamped }]),
      model: modelY,
    })
    expect(seeded.status, JSON.stringify(seeded.json)).toBeLessThan(300)
    // The pick is already in the cache (model writes are immediate); wait for it
    // rather than for a wall-clock guess before reloading.
    await expectStoredDraft(page, modelX)
    await page.reload()
    await anyComposer(page).waitFor({ state: "visible", timeout: 120_000 })
    await openChat(page, alphaChat.name, alphaChat.id)
    await expect.poll(() => shownModel(page, alphaChat.name), { timeout: 30_000 }).toBe(labelY)
  })
})
