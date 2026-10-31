// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A crash or a restart must not take away what the person already saw (SHO-274).
 *
 * The invariant the card enforces: *the person's message is durable before the
 * turn starts, and a frame reaches the client only after it is durable*. Two of
 * its acceptance criteria can be driven end to end against the real local API +
 * agent runtime and the scripted fake model:
 *
 *   1. **Kill right after Send, before any reply frame** — the message the
 *      person typed is in the history. Here: the moment the model receives the
 *      turn, the user row is already committed, and there is exactly one of it
 *      (the client used to write a second copy from a fire-and-forget POST).
 *   2. **A reply the person was reading is still there after the window
 *      reloads** — the reload is a resume replay, and it used to drop the
 *      unfinished assistant tail (`dropUnfinishedAssistantTail`). Here: every
 *      token that was on screen before the reload is on screen after it, in
 *      order, with no gap, and the persisted row has all of them too.
 *
 * The kill-the-process legs of the card (SIGKILL of the runtime, of the API)
 * need a stack supervisor the local lane does not have: in local mode nothing
 * recovers a dead turn until the API boots (`sweepDeadTurnsOnLocalBoot`), and
 * Playwright's `webServer` does not respawn a killed API. Those legs are proven
 * at unit level (apps/api `chat-turn-journal`, `chat-turn-recovery`,
 * `chat-turn-state.service`; packages/agent-runtime
 * `session-partial-reply-recovery`) and are tracked on the card.
 *
 * Runs the real local API + agent runtime against the scripted fake model:
 *
 *   E2E_LOCAL_START_STACK=1 E2E_FAKE_LLM_STACK=1 \
 *   LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 \
 *   LOCAL_LLM_BASIC_MODEL=fake-stream LOCAL_LLM_ADVANCED_MODEL=fake-stream \
 *   npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-crash-keeps-what-was-seen --project chromium --retries 0
 *
 * Checks are soft, so one run lists every way the scenario goes wrong.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { FakeLlmServer, marker } from "../../apps/desktop/e2e/streaming/fake-llm-server"

const API = process.env.E2E_API_URL || "http://localhost:8002"
const LLM_PORT = Number(process.env.E2E_FAKE_LLM_PORT || 18765)
const soft = expect.configure({ soft: true })

// Needs the API pointed at the fake model, which would change every other
// local spec; CI gives it its own matrix entry with E2E_FAKE_LLM_STACK=1.
test.skip(
  process.env.E2E_FAKE_LLM_STACK !== "1",
  "needs an API started with LOCAL_LLM_BASE_URL pointing at the fake model (see the header); set E2E_FAKE_LLM_STACK=1",
)

test.setTimeout(300_000)

let llm: FakeLlmServer
let context: BrowserContext
let workspaceId: string
/** Chat session of each project: a project has exactly one pinned chat. */
const projectOf = new Map<string, string>()

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(300_000)
  llm = new FakeLlmServer()
  await llm.start(LLM_PORT)
  context = await browser.newContext({ baseURL: String(info.project.use.baseURL) })
  const signIn = await context.request.post(`${API}/api/local/auto-sign-in`)
  if (!signIn.ok()) throw new Error(`auto-sign-in failed (${signIn.status()}): ${await signIn.text()}`)
  await context.request.post(`${API}/api/onboarding/complete`)

  const models = await apiJson<any>("GET", "/api/local/models")
  if (!models?.ok || !(models.models ?? []).some((m: any) => m?.id === "fake-stream")) {
    throw new Error(
      `the API is not using the fake model on :${LLM_PORT} (GET /api/local/models: ${JSON.stringify(models).slice(0, 200)}); ` +
        `start it with LOCAL_LLM_BASE_URL=http://127.0.0.1:${LLM_PORT} LOCAL_LLM_BASIC_MODEL=fake-stream LOCAL_LLM_ADVANCED_MODEL=fake-stream`,
    )
  }

  const workspaces = await apiJson<any>("GET", "/api/workspaces")
  const list: any[] = workspaces?.items ?? workspaces?.data ?? workspaces ?? []
  const workspace = list.find((w) => w?.kind === "team") ?? list[0]
  if (!workspace?.id) throw new Error(`no workspace: ${JSON.stringify(workspaces).slice(0, 300)}`)
  workspaceId = workspace.id
})

test.afterAll(async () => {
  await context?.close()
  await llm?.stop()
})

// ── API + window helpers ────────────────────────────────────────────────────

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

async function transcript(sessionId: string): Promise<any[]> {
  const res = await apiJson<any>("GET", `/api/chat-messages?sessionId=${encodeURIComponent(sessionId)}&limit=100`)
  return res?.items ?? res?.data ?? (Array.isArray(res) ? res : [])
}

/** A new project, opened once so the app creates its chat, then closed again. */
async function createChat(name: string): Promise<string> {
  const created = await apiJson<any>("POST", "/api/projects", {
    name: `${name} ${Date.now()}`,
    workspaceId,
    tier: "starter",
    status: "draft",
    accessLevel: "anyone",
  })
  const projectId: string | undefined = created?.data?.id ?? created?.id
  if (!projectId) throw new Error(`project create failed: ${JSON.stringify(created).slice(0, 300)}`)
  const page = await context.newPage()
  await page.goto(`/projects/${encodeURIComponent(projectId)}`)
  await expect(composer(page)).toBeVisible({ timeout: 120_000 })
  const deadline = Date.now() + 60_000
  let sessionId: string | undefined
  while (!sessionId && Date.now() < deadline) {
    const res = await apiJson<any>("GET", `/api/chat-sessions?contextId=${encodeURIComponent(projectId)}`)
    sessionId = (res?.items ?? []).find((s: any) => s.contextType === "workspace" && s.workspaceId)?.id
    if (!sessionId) await page.waitForTimeout(500)
  }
  await page.close()
  if (!sessionId) throw new Error(`project ${projectId} never got a chat`)
  projectOf.set(sessionId, projectId)
  return sessionId
}

const composer = (page: Page) => page.getByTestId("project-composer-input").filter({ visible: true }).first()

async function openChat(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/projects/${encodeURIComponent(projectOf.get(sessionId)!)}`)
  const switchToText = page.getByText("Switch to text input", { exact: true })
  if (await switchToText.isVisible().catch(() => false)) await switchToText.click()
  await expect(composer(page)).toBeVisible({ timeout: 120_000 })
}

async function send(page: Page, text: string): Promise<void> {
  const input = composer(page)
  await input.click()
  await input.fill(text)
  await page.keyboard.press("Enter")
}

/** Token numbers of turn `tag` in the rendered transcript, in DOM order. */
async function tokensOnScreen(page: Page, tag: string): Promise<number[]> {
  return page.evaluate((t) => {
    const re = new RegExp(`t${t}w(\\d{4})`, "g")
    const out: number[] = []
    let m: RegExpExecArray | null
    const text = document.body?.innerText ?? ""
    while ((m = re.exec(text))) out.push(Number(m[1]))
    return out
  }, tag)
}

const maxOf = (seq: number[]) => seq.reduce((a, b) => Math.max(a, b), 0)

/** Token numbers in a stored message, from its text (or its parts if it has none). */
function storedTokens(row: any, tag: string): number[] {
  // `content` and the text part in `parts` hold the same words, so read one of
  // them — concatenating both would report every token twice.
  const content = String(row?.content ?? "")
  const text = content.trim() ? content : String(row?.parts ?? "")
  const re = new RegExp(`t${tag}w(\\d{4})`, "g")
  const out: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(Number(m[1]))
  return out
}

const contiguous = (seq: number[]) => seq.every((v, i) => v === i + 1)

// ── Scenario ────────────────────────────────────────────────────────────────

test.describe("nothing the person saw is lost to a crash or a restart", () => {
  test("the message is already in history when the turn reaches the model", async () => {
    const sid = await createChat("crash durable prompt")
    const page = await context.newPage()
    await openChat(page, sid)

    const tag = "pa"
    const said = `hold-the-model-${Date.now()}`
    // `hold` makes the model wait for `release`, so the turn exists and has
    // produced no frame at all when the assertions below run — the exact
    // "killed right after Send, before any reply frame" shape.
    await send(page, `${marker("hold", tag, 30, { ms: 20 })} ${said}`)

    const request = await llm.waitForTurn(tag, 60_000)
    soft(Boolean(request), "the turn reached the model").toBe(true)

    // The route writes the person's row and waits for the commit *before* it
    // proxies the turn (SHO-274 §2.7), so the request cannot arrive first.
    const rows = await transcript(sid)
    const mine = rows.filter((m) => m?.role === "user" && String(m?.content ?? "").includes(said))
    soft(mine.length, "the person's message is in history before any reply frame").toBe(1)
    soft(Boolean(mine[0]?.id), "that row has an id").toBe(true)

    const assistantText = rows
      .filter((m) => m?.role === "assistant")
      .map((m) => `${m?.content ?? ""}`)
      .join("")
    soft(assistantText.trim(), "no reply text has been written yet (the model is still held)").toBe("")

    llm.release(tag)

    // A retried/reconnected POST must not append a second copy of the question.
    const after = (await transcript(sid)).filter((m) => m?.role === "user" && String(m?.content ?? "").includes(said))
    soft(after.length, "still exactly one copy of the message after the turn runs").toBe(1)

    await page.close()
  })

  test("a reply being read survives a reload mid-stream, on screen and on disk", async () => {
    const sid = await createChat("crash reload mid stream")
    const page = await context.newPage()
    await openChat(page, sid)

    const tag = "rb"
    const n = 900
    await send(page, `${marker("long", tag, n, { ms: 20 })} a-reply-im-reading`)

    await llm.waitForTokens(tag, 40, 90_000)
    // Wait until the window has painted a decent run of it.
    const deadline = Date.now() + 60_000
    let before: number[] = []
    while (Date.now() < deadline) {
      before = await tokensOnScreen(page, tag)
      if (maxOf(before) >= 25) break
      await page.waitForTimeout(150)
    }
    const seenMax = maxOf(before)
    soft(seenMax, "the window painted the reply before the reload").toBeGreaterThan(0)

    // A reload is the resume replay: this used to drop the unfinished
    // assistant tail (SHO-274 C1) and write the shorter array to the cache.
    await page.reload()
    await expect(composer(page)).toBeVisible({ timeout: 120_000 })

    const repaintDeadline = Date.now() + 60_000
    let after: number[] = []
    while (Date.now() < repaintDeadline) {
      after = await tokensOnScreen(page, tag)
      if (maxOf(after) >= seenMax) break
      await page.waitForTimeout(200)
    }
    soft(
      maxOf(after) >= seenMax,
      `every token that was on screen (up to ${seenMax}) is still on screen (shows up to ${maxOf(after)})`,
    ).toBe(true)
    soft(contiguous(after.slice(0, Math.min(after.length, seenMax))), "the repainted reply has no gap in it").toBe(true)

    // …and the stored row holds it too, not just the paint. The snapshot is
    // throttled (≤2 s behind a live turn), so give it a moment to catch up.
    const storedDeadline = Date.now() + 30_000
    let persisted: number[] = []
    while (Date.now() < storedDeadline) {
      const rows = await transcript(sid)
      const reply = rows.filter((m) => m?.role === "assistant" && storedTokens(m, tag).length > 0).pop()
      persisted = storedTokens(reply, tag)
      if (maxOf(persisted) >= seenMax) break
      await page.waitForTimeout(500)
    }
    soft(persisted.length, "the partial reply is persisted, not only painted").toBeGreaterThan(0)
    soft(
      maxOf(persisted) >= seenMax,
      `the stored row reaches as far as the paint (stored up to ${maxOf(persisted)}, painted up to ${seenMax})`,
    ).toBe(true)
    soft(
      contiguous(persisted),
      `the stored reply has no gap in it (n=${persisted.length}, first=${persisted.slice(0, 5).join(",")}, last=${persisted.slice(-5).join(",")}, repeats=${persisted.length - new Set(persisted).size})`,
    ).toBe(true)

    await page.close()
  })
})
