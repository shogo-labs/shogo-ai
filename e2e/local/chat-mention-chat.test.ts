// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tagging another chat from the composer (SHO-52).
 *
 * The acceptance path this spec owns — the one the API suites cannot see:
 *
 *   1. typing `@` in the composer offers a chat that lives in **another
 *      workspace** (the `GET /api/chat-mentionables` picker, not the
 *      current-workspace-only history search);
 *   2. the sent message renders a chip with that chat's title and a delivery
 *      state, instead of the raw `<@c:…>` wire token;
 *   3. the tag actually reaches the target chat — a queue row / message lands
 *      in the target session, which is the thing `Queued`/`Working`/`Replied`
 *      is derived from;
 *   4. pressing the chip opens that chat **in its own workspace**, which is
 *      what `openInWorkspace` is for: the chat screens read the active
 *      workspace, so a plain push would land on a chat that cannot be sent to
 *      (`session_not_in_workspace`).
 *
 * Local mode seeds one personal and one team workspace, so the second
 * workspace exists without this spec creating (and having to delete) one. The
 * target chat is created through the API and removed again at the end. The
 * handoff is delivered without needing a model reply, so this runs on the plain
 * local stack:
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
// case so a copy change does not silently skip the assertion. `delivered` is
// the durable one — it survives a target turn that never answers.
const TAG_LINE = /(queued|delivered|working|replied)/i

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

/** True once a line of the visible chat shows the tagged chat and its state. */
async function chipShowsStatus(page: Page, title: string): Promise<boolean> {
  const text = await page.evaluate(() => document.body.innerText)
  return text
    .split("\n")
    .some((line) => line.includes(`@${title}`) && TAG_LINE.test(line))
}

type TagStatus = { queued: number; working: boolean; delivered: boolean; replied: number }

/** What the chip's suffix is derived from, read from the same route it uses. */
async function chatMentionStatus(
  page: Page,
  sessionId: string,
  sinceMs: number,
): Promise<TagStatus> {
  return page.evaluate(async ({ apiBase, id, since }) => {
    const params = new URLSearchParams({ ids: id, since })
    const response = await fetch(`${apiBase}/api/chat-mention-status?${params}`, {
      credentials: "include",
    })
    const body = await response.json().catch(() => null)
    const status = body?.statuses?.[id] ?? {}
    return {
      queued: Number(status.queued ?? 0),
      working: Boolean(status.working),
      delivered: Boolean(status.deliveredAt),
      replied: status.repliedAt ? 1 : 0,
    }
  }, { apiBase: API, id: sessionId, since: new Date(sinceMs).toISOString() })
}

/**
 * Everything the server holds for `sessionId` that proves delivery: the queue
 * row while it waits, or the persisted message once its turn started.
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

test.describe("SHO-52 — a chat tag is an address", () => {
  test("a chat from another workspace is offered, delivered to, and opens in that workspace", async ({
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
    // The title identifies the chat in the picker; the body is what has to
    // arrive in the other workspace (the title of the *target* chat is the one
    // thing a delivered message never contains).
    const title = `SHO-52 ${stamp}`
    const body = `please pick this up ${stamp}`
    const targetChat = await createChatInWorkspace(page, target.id, title)

    try {
      // The title is unique to this run, so the picker cannot be showing a
      // chat that was already there.
      const input = composer(page)
      await input.click()
      await input.fill("@SHO-52")
      const option = page.getByText(title, { exact: false }).first()
      await expect(option).toBeVisible({ timeout: 30_000 })

      await option.click()
      await page.keyboard.type(` ${body}`)
      await page.keyboard.press("Enter")

      // (2) a chip with the tagged chat's title, not the wire token
      const chip = page.getByText(`@${title}`, { exact: false }).first()
      await expect(chip).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText("<@c:", { exact: false })).toHaveCount(0)

      // (3) it reached the other workspace's chat
      await expect
        .poll(() => deliveredText(page, targetChat.id), { timeout: 90_000 })
        .toContain(body)

      // The suffix mirrors `/api/chat-mention-status`: whatever state the
      // server reports, the chip has to be showing it.
      const status = await chatMentionStatus(page, targetChat.id, stamp)
      if (status.queued > 0 || status.working || status.delivered || status.replied > 0) {
        await expect.poll(() => chipShowsStatus(page, title), { timeout: 30_000 }).toBe(true)
      }

      // (4) pressing the chip opens it there
      await chip.click()
      await expect(page).toHaveURL(new RegExp(`/agent\\?chatSessionId=${targetChat.id}`), {
        timeout: 60_000,
      })
      await expect(page.getByText(body, { exact: false }).first()).toBeVisible({
        timeout: 90_000,
      })
      await expect
        .poll(() => activeWorkspaceName(page), { timeout: 30_000 })
        .toBe(target.name ?? "")
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
