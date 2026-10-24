// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tagging another chat from the workspace composer (SHO-52 → SHO-191).
 *
 * In the **workspace chat** a tag is context, not a send. The acceptance path
 * this spec owns — the one the API suites cannot see:
 *
 *   1. typing `@` in the composer offers a chat that lives in **another
 *      workspace** (the `GET /api/chat-mentionables` picker, not the
 *      current-workspace-only history search);
 *   2. the sent message renders a chip with that chat's title, instead of the
 *      raw `<@c:…>` wire token, and **no delivery state** — nothing was sent;
 *   3. nothing reaches the tagged chat: no queue row, no message, no turn;
 *   4. pressing the chip opens that chat **in its own workspace**, which is
 *      what `openInWorkspace` is for: the chat screens read the active
 *      workspace, so a plain push would land on a chat that cannot be sent to
 *      (`session_not_in_workspace`).
 *
 * The pointer block the agent receives (title, id, where it lives, and the
 * exact `read_history` call, with no transcript) is built server-side and never
 * persists, so it is pinned by unit tests instead:
 * `apps/api/src/__tests__/chat-pointer-references.test.ts` (the reference and
 * the cross-workspace `read_history`) and
 * `packages/agent-runtime/src/__tests__/reference-context-history.test.ts`
 * (the rendered prompt block).
 *
 * Local mode seeds one personal and one team workspace, so the second
 * workspace exists without this spec creating (and having to delete) one. The
 * target chat is created through the API and removed again at the end:
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test \
 *     --config e2e/local/playwright.config.ts chat-mention-chat --project chromium
 */
import { expect, test, type Page } from "@playwright/test"

const API =
  process.env.E2E_API_URL || process.env.STAGING_API_URL || "http://localhost:8002"

test.setTimeout(300_000)

type WorkspaceRow = { id: string; name?: string; kind?: string }
type SessionRow = { id: string; workspaceId: string }

// `statusLabel()` renders these lower-case ("replied 3:42 PM"); match either
// case so a copy change does not silently skip the assertion.
const TAG_STATUS = /(queued|delivered|working|replied)/i

/** Local mode auto-signs in; onboarding has to be complete before workspaces list. */
async function establishLocalSession(page: Page): Promise<void> {
  await page.goto("/")
  await page.evaluate(async (apiBase) => {
    const signIn = await fetch(`${apiBase}/api/local/auto-sign-in`, {
      method: "POST",
      credentials: "include",
    })
    if (!signIn.ok) {
      throw new Error(`Local auto-sign-in failed (${signIn.status()}): ${await signIn.text()}`)
    }
    await fetch(`${apiBase}/api/onboarding/complete`, {
      method: "POST",
      credentials: "include",
    })
  }, API)
}

async function listWorkspaces(page: Page): Promise<WorkspaceRow[]> {
  return page.evaluate(async (apiBase) => {
    const response = await fetch(`${apiBase}/api/workspaces`, { credentials: "include" })
    if (!response.ok) {
      throw new Error(`Loading workspaces failed (${response.status()})`)
    }
    const body = await response.json()
    return (body?.items ?? body?.data?.items ?? []) as WorkspaceRow[]
  }, API)
}

async function createChatInWorkspace(
  page: Page,
  workspaceId: string,
  inferredName: string,
): Promise<SessionRow> {
  return page.evaluate(
    async ({ apiBase, wsId, title }) => {
      const response = await fetch(
        `${apiBase}/api/workspaces/${encodeURIComponent(wsId)}/sessions`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inferredName: title }),
        },
      )
      if (!response.ok) {
        throw new Error(`Creating a chat failed (${response.status()}): ${await response.text()}`)
      }
      const body = await response.json()
      const session = body?.session ?? body?.data?.session
      if (!session?.id) throw new Error(`No session in create response: ${JSON.stringify(body)}`)
      return session as { id: string; workspaceId: string }
    },
    { apiBase: API, wsId: workspaceId, title: inferredName },
  )
}

/** The active workspace's name, read off the account trigger's accessible name. */
async function activeWorkspaceName(page: Page): Promise<string | null> {
  const label = await page
    .getByRole("button", { name: /— open account/ })
    .first()
    .getAttribute("aria-label", { timeout: 30_000 })
    .catch(() => null)
  if (!label) return null
  return label.split(",")[0]?.trim() ?? null
}

const composer = (page: Page) =>
  page.getByTestId("project-composer-input").filter({ visible: true }).first()

/** True when a visible line shows the tagged chat **and** a delivery state. */
async function chipShowsStatus(page: Page, title: string): Promise<boolean> {
  const text = await page.evaluate(() => document.body.innerText)
  return text
    .split("\n")
    .some((line) => line.includes(`@${title}`) && TAG_STATUS.test(line))
}

/**
 * Everything the server holds for `sessionId` that would prove a delivery: the
 * queue row while it waits, or the persisted message once a turn started.
 */
async function deliveredText(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(
    async ({ apiBase, id }) => {
      const read = async (url: string): Promise<string> => {
        const response = await fetch(url, { credentials: "include" })
        if (!response.ok) return ""
        const body = await response.json().catch(() => null)
        const items = Array.isArray(body) ? body : (body?.items ?? body?.data ?? [])
        return JSON.stringify(items)
      }
      const queued = await read(
        `${apiBase}/api/chat-queued-messages?sessionId=${encodeURIComponent(id)}`,
      )
      const messages = await read(
        `${apiBase}/api/chat-messages?sessionId=${encodeURIComponent(id)}&limit=20`,
      )
      return `${queued}\n${messages}`
    },
    { apiBase: API, id: sessionId },
  )
}

test.describe("SHO-191 — a chat tag in the workspace chat is a reference", () => {
  test("a chat from another workspace is offered, rendered as a chip, sent nothing, and opens in that workspace", async ({
    page,
  }) => {
    await establishLocalSession(page)

    const workspaces = await listWorkspaces(page)
    expect(workspaces.length, "local mode must seed two workspaces").toBeGreaterThan(1)

    // The chat has to live somewhere other than where we are typing.
    await page.goto("/agent")
    await composer(page).waitFor({ state: "visible", timeout: 90_000 })
    const activeName = await activeWorkspaceName(page)
    const source = workspaces.find((workspace) => workspace.name === activeName) ?? workspaces[0]
    const target = workspaces.find((workspace) => workspace.id !== source.id)!
    expect(target, "need a second workspace to tag into").toBeTruthy()

    const stamp = Date.now()
    // The title identifies the chat in the picker; the body is the phrase that
    // must never arrive in the other workspace.
    const title = `SHO-191 ${stamp}`
    const body = `just reading this ${stamp}`
    const targetChat = await createChatInWorkspace(page, target.id, title)

    try {
      // The title is unique to this run, so the picker cannot be showing a
      // chat that was already there.
      const input = composer(page)
      await input.click()
      await input.fill("@SHO-191")
      const option = page.getByText(title, { exact: false }).first()
      await expect(option).toBeVisible({ timeout: 30_000 })

      await option.click()
      await page.keyboard.type(` ${body}`)
      await page.keyboard.press("Enter")

      // (2) a chip with the tagged chat's title, not the wire token
      const chip = page.getByText(`@${title}`, { exact: false }).first()
      await expect(chip).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText("<@c:", { exact: false })).toHaveCount(0)

      // (3) nothing was posted to the tagged chat: no queue row, no message,
      // and therefore no turn. Give the (now removed) delivery path room to
      // have raced us, then assert it stayed empty.
      const sourceChatBefore = await deliveredText(page, targetChat.id)
      await page.waitForTimeout(5_000)
      expect(await deliveredText(page, targetChat.id)).toBe(sourceChatBefore)
      expect(sourceChatBefore).not.toContain(body)
      // AC 7: a reference has no delivery state to show.
      expect(await chipShowsStatus(page, title)).toBe(false)

      // (4) pressing the chip opens it there
      await chip.click()
      await expect(page).toHaveURL(new RegExp(`/agent\\?chatSessionId=${targetChat.id}`), {
        timeout: 60_000,
      })
      await expect
        .poll(() => activeWorkspaceName(page), { timeout: 30_000 })
        .toBe(target.name ?? "")
      // The tagged chat is empty: the phrase we wrote never got here.
      await expect(page.getByText(body, { exact: false })).toHaveCount(0)
    } finally {
      if (process.env.E2E_KEEP_TARGET !== "1") {
        await page.evaluate(
          async ({ apiBase, id }) => {
            await fetch(`${apiBase}/api/chat-sessions/${encodeURIComponent(id)}`, {
              method: "DELETE",
              credentials: "include",
            }).catch(() => undefined)
          },
          { apiBase: API, id: targetChat.id },
        )
      }
    }
  })
})
