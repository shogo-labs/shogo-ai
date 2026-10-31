// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Edit & resend a past message (SHO-263).
 *
 * Cursor/Lovable model: clicking a past user message opens an editor right
 * where it sits, every later turn dims under a "N messages below will be
 * replaced" divider, the revert/keep choice is inline in the footer, and no
 * modal appears. Sending drops the later turns immediately and starts a new
 * run.
 *
 * Runs the real local API + agent runtime against the scripted fake model from
 * apps/desktop/e2e/streaming:
 *
 *   LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 LOCAL_LLM_BASIC_MODEL=fake-stream \
 *   LOCAL_LLM_ADVANCED_MODEL=fake-stream SHOGO_LOCAL_MODE=true bun --no-env-file apps/api/src/entry.ts
 *   EXPO_PUBLIC_LOCAL_MODE=true EXPO_PUBLIC_API_URL=http://localhost:8002 bun run web:dev
 *
 *   E2E_FAKE_LLM_STACK=1 E2E_API_URL=http://localhost:8002 npx playwright test --config e2e/local/playwright.config.ts \
 *     chat-edit-resend --project chromium --retries 0
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { FakeLlmServer } from "../../apps/desktop/e2e/streaming/fake-llm-server"

const API = process.env.E2E_API_URL || "http://localhost:8002"
const LLM_PORT = Number(process.env.E2E_FAKE_LLM_PORT || 18765)

const soft = expect.configure({ soft: true })

test.skip(
  process.env.E2E_FAKE_LLM_STACK !== "1",
  "needs an API started with LOCAL_LLM_BASE_URL pointing at the fake model (see the header); set E2E_FAKE_LLM_STACK=1",
)

test.setTimeout(240_000)

let llm: FakeLlmServer
let context: BrowserContext
let workspaceId: string
let projectId: string

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(300_000)
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
    name: `edit-resend ${Date.now()}`,
    workspaceId,
    tier: "starter",
    status: "draft",
    accessLevel: "anyone",
  })
  projectId = created?.data?.id ?? created?.id
  if (!projectId) throw new Error(`project create failed: ${JSON.stringify(created).slice(0, 300)}`)
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

const composer = (page: Page) =>
  page.getByTestId("project-composer-input").filter({ visible: true }).first()
const inlineEditor = (page: Page) => page.getByPlaceholder("Edit your message…")

async function openChat(page: Page): Promise<void> {
  await page.goto(`/projects/${encodeURIComponent(projectId)}`)
  const switchToText = page.getByText("Switch to text input", { exact: true })
  if (await switchToText.isVisible().catch(() => false)) await switchToText.click()
  await expect(composer(page)).toBeVisible({ timeout: 120_000 })
}

async function send(page: Page, text: string): Promise<void> {
  const input = composer(page)
  await input.click()
  await input.fill(text)
  await page.keyboard.press("Enter")
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible({ timeout: 30_000 })
}

async function waitIdle(page: Page, timeoutMs = 60_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const streaming = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="stop-streaming"]')).some((el) => {
        let node: Element | null = el
        while (node) {
          if (getComputedStyle(node).opacity === "0") return false
          node = node.parentElement
        }
        return true
      }),
    )
    if (!streaming) return
    await page.waitForTimeout(200)
  }
}

test("editing a past message dims what follows, shows the inline choice, and resends", async () => {
  const page = await context.newPage()
  await openChat(page)

  await send(page, "alpha message one")
  await waitIdle(page)
  await send(page, "beta message two")
  await waitIdle(page)

  // Open the editor from the hover action row on the FIRST message.
  const first = page.getByText("alpha message one", { exact: false }).first()
  await first.hover()
  await page.getByRole("button", { name: "Edit message" }).first().click()

  // In place: same text, a Cancel/Send footer and the keyboard hint — no modal.
  await expect(inlineEditor(page)).toBeVisible({ timeout: 10_000 })
  soft(await page.getByText("Esc to cancel · ⏎ to send").isVisible()).toBe(true)
  soft(await page.getByText("Edit message?", { exact: true }).isVisible().catch(() => false)).toBe(false)

  // Everything below dims under the divider.
  soft(await page.getByText(/messages? below will be replaced/).first().isVisible()).toBe(true)

  // Change the text and resend; the revert choice is inline, never a dialog.
  await inlineEditor(page).fill("alpha message one edited")
  const sendButton = page.getByRole("button", { name: /^(Send|Resend|Revert & resend)$/ }).first()
  await expect(sendButton).toBeVisible({ timeout: 10_000 })
  await sendButton.click()

  // The later turn is gone and the edit starts a new run.
  await expect(page.getByText("alpha message one edited", { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByText("beta message two", { exact: false })).toHaveCount(0, { timeout: 30_000 })
  soft(await page.getByText(/messages? below will be replaced/).count()).toBe(0)

  await waitIdle(page)
  await page.close()
})

test("an edit made while the agent is running stops the run first", async () => {
  const page = await context.newPage()
  await openChat(page)

  await send(page, "gamma message three")
  await waitIdle(page)
  await send(page, "delta message four")

  // While the second turn streams, edit the first one.
  const first = page.getByText("gamma message three", { exact: false }).first()
  await first.hover()
  await page.getByRole("button", { name: "Edit message" }).first().click()
  await expect(inlineEditor(page)).toBeVisible({ timeout: 10_000 })
  soft(await page.getByText(/Stops the current run/).isVisible()).toBe(true)

  await inlineEditor(page).fill("gamma message three edited")
  await page.getByRole("button", { name: /^(Send|Resend|Revert & resend)$/ }).first().click()

  await expect(page.getByText("gamma message three edited", { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  })
  await waitIdle(page)
  const streaming = await page.evaluate(() =>
    document.querySelectorAll('[data-testid="stop-streaming"]').length,
  )
  soft(streaming === 0).toBe(true)

  await page.close()
})
