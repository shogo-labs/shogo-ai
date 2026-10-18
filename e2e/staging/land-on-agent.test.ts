// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test, type Page } from "./fixtures"
import { APP_HOME_PATH, gotoAppHome, makeTestUser, signUpAndOnboard, type TestUser } from "./helpers"

/**
 * SHO-4 + SHO-19: a cold start lands on the workspace agent with an empty chat.
 *
 *   - team workspace: `/` opens the agent on an empty chat and **reuses that
 *     one** until it has a message in it, so reloading ten times does not leave
 *     ten empty chats behind, while a chat with a conversation is never
 *     reopened (it stays in history);
 *   - the old team home (builder / phone feed) is at `/home`;
 *   - an explicit `?chatSessionId=` still wins and mints nothing;
 *   - personal workspaces are untouched: `/` keeps resuming the primary chat.
 *
 *   E2E_TARGET_URL=https://studio.staging.shogo.ai \
 *     npx playwright test --config e2e/playwright.config.ts land-on-agent
 */

const TEAM_USER: TestUser = makeTestUser("LandOnAgentTeam")
const PERSONAL_USER: TestUser = makeTestUser("LandOnAgentPersonal")
const SESSIONS_API = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`

/** The workspace agent's composer (ChatInput's default accessibility label). */
function composer(page: Page) {
  return page
    .getByRole("textbox", { name: "Chat message input" })
    .filter({ visible: true })
    .first()
}

async function workspaces(page: Page) {
  return page.evaluate(async () => {
    const res = await fetch("/api/workspaces", { credentials: "include" })
    if (!res.ok) throw new Error(`list workspaces failed: ${res.status}`)
    const json = await res.json()
    return ((json?.items ?? json?.data?.items ?? []) as Array<{ id: string; kind?: string }>).map((w) => ({
      id: w.id,
      kind: w.kind,
    }))
  })
}

async function sessionIds(page: Page, workspaceId: string): Promise<string[]> {
  return page.evaluate(async (path) => {
    const res = await fetch(path, { credentials: "include" })
    if (!res.ok) throw new Error(`list sessions failed: ${res.status}`)
    const json = await res.json()
    const rows = (json?.sessions ?? json?.items ?? []) as Array<{ id: string }>
    return rows.map((row) => row.id)
  }, SESSIONS_API(workspaceId))
}

/**
 * Give a chat a message without running a model turn: the landing keys off the
 * message count, and this writes the same row the chat path writes.
 */
async function sendFirstMessage(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const res = await fetch("/api/chat-messages", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, role: "user", content: "hello from the land-on-agent e2e" }),
    })
    if (!res.ok) throw new Error(`create chat message failed: ${res.status} ${await res.text()}`)
  }, sessionId)
}

/** Switches the active workspace the way the product does (persisted pointer). */
async function activateWorkspace(page: Page, id: string, kind: string) {
  await page.evaluate(
    ({ id, kind }) => {
      localStorage.setItem("shogo:active-workspace-id", id)
      localStorage.setItem("shogo:active-workspace-kind", kind)
    },
    { id, kind },
  )
}

test.describe("Land on the workspace agent", () => {
  test("a team cold start reuses one empty chat until it has a message", async ({ page }) => {
    await signUpAndOnboard(page, TEAM_USER)

    const team = (await workspaces(page)).find((w) => w.kind !== "personal")
    expect(team, "sign-up created no team workspace").toBeTruthy()
    const workspaceId = team!.id
    const before = await sessionIds(page, workspaceId)

    // ── Ten cold starts leave one empty chat, not ten ───────────────────────
    for (let load = 0; load < 10; load += 1) {
      await page.goto("/")
      await expect(composer(page)).toBeVisible({ timeout: 60_000 })
      expect(new URL(page.url()).pathname).toBe("/")
      // The old team home must not flash or stick.
      await expect(page.getByText("What are we building", { exact: false })).toHaveCount(0)
    }

    const afterTen = await sessionIds(page, workspaceId)
    const minted = afterTen.filter((id) => !before.includes(id))
    expect(minted, "ten cold starts must leave exactly one empty landing chat").toHaveLength(1)
    const landing = minted[0]

    // ── The first message stays in that chat ───────────────────────────────
    await sendFirstMessage(page, landing)
    expect((await sessionIds(page, workspaceId)).sort()).toEqual([...afterTen].sort())

    // ── A chat with a conversation is never reopened ───────────────────────
    await page.goto("/")
    await expect(composer(page)).toBeVisible({ timeout: 60_000 })
    const afterNext = await sessionIds(page, workspaceId)
    const mintedNext = afterNext.filter((id) => !afterTen.includes(id))
    expect(mintedNext, "the landing reopened the previous conversation").toHaveLength(1)
    expect(mintedNext[0]).not.toBe(landing)

    // ── An explicit session in the URL still wins, and mints nothing ────────
    await page.goto(`/agent?chatSessionId=${landing}`)
    await expect(composer(page)).toBeVisible({ timeout: 60_000 })
    expect(new URL(page.url()).searchParams.get("chatSessionId")).toBe(landing)
    const afterExplicit = await sessionIds(page, workspaceId)
    expect(afterExplicit.sort()).toEqual(afterNext.sort())

    // ── The old team home is one route away ────────────────────────────────
    await gotoAppHome(page)
    expect(new URL(page.url()).pathname).toBe(APP_HOME_PATH)
    await expect(page.getByText("What are we building", { exact: false }).first()).toBeVisible()
  })

  test("a personal cold start keeps resuming its last chat", async ({ page }) => {
    await signUpAndOnboard(page, PERSONAL_USER)

    const personal = (await workspaces(page)).find((w) => w.kind === "personal")
    expect(personal, "sign-up created no personal workspace").toBeTruthy()
    const workspaceId = personal!.id
    await activateWorkspace(page, workspaceId, "personal")

    // The first load may create the workspace's primary session; after that the
    // count must not grow — personal never mints a landing chat.
    await page.goto("/")
    await expect(composer(page)).toBeVisible({ timeout: 60_000 })
    const settled = await sessionIds(page, workspaceId)

    await page.reload()
    await expect(composer(page)).toBeVisible({ timeout: 60_000 })
    await page.goto("/")
    await expect(composer(page)).toBeVisible({ timeout: 60_000 })

    expect(await sessionIds(page, workspaceId)).toEqual(settled)
    expect(new URL(page.url()).pathname).toBe("/")
  })
})
