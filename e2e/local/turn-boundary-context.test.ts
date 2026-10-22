// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-122 — the previous turn survives a turn boundary, structured.
 *
 * Turn 1 drives six tool rounds through the fake model. Turn 2 then starts, and
 * the request the model receives must still contain turn 1's tool calls (by
 * real name) and its tool results with their original content. On `origin/main`
 * the same spec fails: turn 2's request carries `[Tool output processed — N
 * chars, see assistant response]` where the results used to be, and no
 * `tool_calls` from turn 1 at all.
 *
 *   LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 LOCAL_LLM_BASIC_MODEL=fake-stream \
 *   LOCAL_LLM_ADVANCED_MODEL=fake-stream E2E_LOCAL_START_STACK=1 \
 *   E2E_FAKE_LLM_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     turn-boundary-context --project chromium --retries 0
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { FakeLlmServer, marker, type FakeTurn } from "../../apps/desktop/e2e/streaming/fake-llm-server"

const API = process.env.E2E_API_URL || "http://localhost:8002"
const LLM_PORT = Number(process.env.E2E_FAKE_LLM_PORT || 18765)

const soft = expect.configure({ soft: true })

test.skip(
  process.env.E2E_FAKE_LLM_STACK !== "1",
  "needs an API started with LOCAL_LLM_BASE_URL pointing at the fake model (see the header); set E2E_FAKE_LLM_STACK=1",
)

test.setTimeout(300_000)

let llm: FakeLlmServer
let context: BrowserContext
let workspaceId: string
let projectId: string
let sessionId: string

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(360_000)
  llm = new FakeLlmServer()
  await llm.start(LLM_PORT)
  const baseURL = String(info.project.use.baseURL)
  context = await browser.newContext({ baseURL })
  const signIn = await context.request.post(`${API}/api/local/auto-sign-in`)
  if (!signIn.ok()) throw new Error(`auto-sign-in failed (${signIn.status()}): ${await signIn.text()}`)
  await context.request.post(`${API}/api/onboarding/complete`)

  const workspaces = await apiJson<any>("GET", "/api/workspaces")
  const list: any[] = workspaces?.items ?? workspaces?.data ?? workspaces ?? []
  const workspace = list.find((w) => w?.kind === "team") ?? list[0]
  if (!workspace?.id) throw new Error(`no workspace: ${JSON.stringify(workspaces).slice(0, 300)}`)
  workspaceId = workspace.id

  const created = await apiJson<any>("POST", "/api/projects", {
    name: `turn boundary ${Date.now()}`,
    workspaceId,
    tier: "starter",
    status: "draft",
    accessLevel: "anyone",
  })
  projectId = created?.data?.id ?? created?.id
  if (!projectId) throw new Error(`project create failed: ${JSON.stringify(created).slice(0, 300)}`)

  const page = await context.newPage()
  await page.goto(`/projects/${encodeURIComponent(projectId)}`)
  await expect(composer(page)).toBeVisible({ timeout: 120_000 })
  const deadline = Date.now() + 60_000
  while (!sessionId && Date.now() < deadline) {
    const res = await apiJson<any>("GET", `/api/chat-sessions?contextId=${encodeURIComponent(projectId)}`)
    sessionId = (res?.items ?? []).find((s: any) => s.contextType === "workspace" && s.workspaceId)?.id
    if (!sessionId) await page.waitForTimeout(500)
  }
  await page.close()
  if (!sessionId) throw new Error(`project ${projectId} never got a chat`)
})

test.afterAll(async () => {
  await context?.close()
  await llm?.stop()
})

async function apiJson<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await context.request.fetch(`${API}${route}`, {
    method,
    data: body,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
  })
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

const composer = (page: Page) => page.getByTestId("project-composer-input").filter({ visible: true }).first()

async function send(page: Page, text: string): Promise<void> {
  const input = composer(page)
  await input.click()
  await input.fill(text)
  await page.keyboard.press("Enter")
}

async function stopShown(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('[data-testid="stop-streaming"]'))) {
      let node: Element | null = el
      let hidden = false
      while (node) {
        const style = getComputedStyle(node)
        if (style.opacity === "0" || style.display === "none" || style.visibility === "hidden") {
          hidden = true
          break
        }
        node = node.parentElement
      }
      if (!hidden) return true
    }
    return false
  })
}

async function waitForIdle(page: Page, timeoutMs = 90_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs && (await stopShown(page))) await page.waitForTimeout(200)
}

/**
 * The first request of the SECOND turn.
 *
 * Selected from the request body itself rather than from `userText`: `userText`
 * is only the *last* user message, and the runtime may append a note after the
 * prompt, which would hide it. Every request of turn 2 carries the new prompt
 * somewhere in `messages`, and no request of turn 1 does.
 */
function secondTurnFirstRequest(): FakeTurn | undefined {
  return llm.turns.find((t) =>
    t.messages.some(
      (m) => m.role === "user" && (m.preview.includes("second turn") || m.tail.includes("second turn")),
    ),
  )
}

/** What the fake model was asked, for a failure that explains itself. */
function turnList(): string {
  return JSON.stringify(
    llm.turns.map((t) => ({ id: t.id, tag: t.tag, round: t.round, userText: t.userText.slice(0, 60) })),
    null,
    1,
  )
}

test.describe("turn boundary", () => {
  test("turn 2 carries turn 1's tool calls and results, not placeholders", async () => {
    const page = await context.newPage()
    await page.goto(`/projects/${encodeURIComponent(projectId)}`)
    await expect(composer(page)).toBeVisible({ timeout: 120_000 })

    const tag = "tb"
    // Six tool rounds in one turn, then a second turn.
    await send(page, `${marker("tool", tag, 60, { ms: 2, rounds: 6 })} run the six rounds`)
    await llm.waitForTurn(tag, 120_000)
    await waitForIdle(page)

    const turnOne = llm.turns.filter((t) => t.tag === tag)
    soft(turnOne.length, "turn 1 drove several model calls (one per tool round)").toBeGreaterThanOrEqual(6)

    await send(page, "second turn: what did you just do?")
    const started = Date.now()
    let request: FakeTurn | undefined
    while (!request && Date.now() - started < 120_000) {
      request = secondTurnFirstRequest()
      if (!request) await page.waitForTimeout(200)
    }
    soft(request, `turn 2's first model request was captured — turns seen: ${turnList()}`).toBeDefined()

    const messages = request?.messages ?? []
    const toolResults = messages.filter((m) => m.role === "tool")
    const assistantCalls = messages.flatMap((m) => (m.role === "assistant" ? m.toolNames : []))

    // The turn's tool calls are still there, with real names.
    soft(assistantCalls.length, "turn 1's tool_calls survive into turn 2").toBeGreaterThanOrEqual(6)
    soft(assistantCalls.includes("read_file"), "the tool name is the real one").toBe(true)

    // The results are the originals — no placeholder anywhere in the request.
    soft(toolResults.length, "turn 1's tool messages survive into turn 2").toBeGreaterThanOrEqual(6)
    for (const result of toolResults) {
      soft(result.preview.includes("Tool output processed"), "no `[Tool output processed]` placeholder").toBe(false)
      soft(result.preview.includes("Tool result cleared"), "no `[Tool result cleared]` placeholder").toBe(false)
      soft(result.preview.includes("result cleared"), "no `[Earlier … result cleared]` placeholder").toBe(false)
      // AC1 names this one too, and it is the placeholder a turn-anchored
      // boundary still let through: microcompact's read_file collapse, which
      // the gateway applies to the previous turn before the new prompt exists.
      soft(
        result.preview.includes("File content read"),
        `no [File content read] placeholder — ${result.preview.slice(0, 80)}`,
      ).toBe(false)
      soft(result.chars, "the result still carries its content").toBeGreaterThan(0)
    }

    // And the turn's own user message is in the request.
    soft(
      messages.some(
        (m) => m.role === "user" && (m.preview.includes("run the six rounds") || m.tail.includes("run the six rounds")),
      ),
      `turn 1's user message is still in the request — request was: ${JSON.stringify(
        messages.map((m) => `${m.role}:${m.preview.slice(0, 70)}`),
        null,
        1,
      ).slice(0, 3000)}`,
    ).toBe(true)

    await page.close()
  })
})
