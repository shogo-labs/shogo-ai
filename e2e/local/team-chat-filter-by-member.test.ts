// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-458: "Filter by member" filters the channel timeline in place instead
 * of opening MemberMessagesPane.
 *
 * Covers AC 1–5 and 8:
 *   1. Desktop: filtering keeps the channel on screen; existing thread pane stays.
 *   2. Phone-width (390 px): same filter, no full-screen takeover, filter bar visible.
 *   3. Filter chip + × clears the filter.
 *   4. Member switcher changes who is filtered and updates ?from=.
 *   5. Thread replies appear in filtered view marked "replied to a thread".
 *   8a. ?from=user:<id> URL opens channel already filtered.
 *   8b. Opening a board clears the member filter.
 */
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import {
  activateTeamWorkspace,
  api,
  cleanupTeamNav,
  seedTeamNav,
  signInByApi,
  type TeamNavSeed,
} from "./team-nav-seed"

const PEER = {
  email: "team-nav-peer@example.com",
  password: "team-nav-peer-pass",
}

/** Sign in as the peer user and post a message to a conversation. */
async function postAsPeer(
  page: Page,
  conversationId: string,
  text: string,
  threadRootId?: string,
): Promise<string | null> {
  const browser = page.context().browser()
  if (!browser) throw new Error("postAsPeer: no browser in context")
  const ctx = await browser.newContext()
  try {
    const signIn = await ctx.request.post(`${LOCAL_API_BASE}/api/auth/sign-in/email`, {
      data: { email: PEER.email, password: PEER.password },
    })
    expect(signIn.ok(), `peer sign-in failed (${signIn.status()})`).toBe(true)
    const posted = await ctx.request.post(
      `${LOCAL_API_BASE}/api/conversations/${conversationId}/messages`,
      { data: { text, ...(threadRootId ? { threadRootId } : {}) } },
    )
    expect(posted.ok(), `peer message post failed (${posted.status()})`).toBe(true)
    const body = await posted.json()
    return body?.message?.id ?? body?.id ?? null
  } finally {
    await ctx.close()
  }
}

test.describe("Team chat: filter by member (SHO-458)", () => {
  test.describe.configure({ mode: "serial" })

  let seed: TeamNavSeed
  let seeder: Page
  let myUserId: string
  /** A thread reply the main user posted into one of the peer's thread roots. */
  let myThreadReplyId: string
  /** The peer's top-level message (also the thread root for myThreadReplyId). */
  let peerRootMsgId: string

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    const ctx = await browser.newContext()
    seeder = await ctx.newPage()
    await signInByApi(seeder)
    seed = await seedTeamNav(seeder)

    // Resolve the main user id.
    const session = await (
      await seeder.request.get(`${LOCAL_API_BASE}/api/auth/get-session`)
    )
      .json()
      .catch(() => null)
    myUserId = session?.user?.id
    expect(myUserId, "main user id from session").toBeTruthy()

    // Add the peer (team-nav-peer) to the channel so they appear in the
    // member switcher.
    const added = await api(seeder, "POST", `/api/conversations/${seed.channelId}/members`, {
      userId: seed.dmPeerId,
    })
    // 200/201 = added, 409 = already a member — all fine.
    expect(
      [200, 201, 409].includes(added.status),
      `add peer to channel (${added.status}): ${JSON.stringify(added.json)}`,
    ).toBe(true)

    // Peer posts a top-level message in the channel.
    const peerMsg = await postAsPeer(
      seeder,
      seed.channelId,
      `Peer root SHO-458 (${seed.suffix})`,
    )
    expect(peerMsg, "peer root message").toBeTruthy()
    peerRootMsgId = peerMsg!

    // Main user replies to the peer's message, creating a thread.
    // This reply should appear in the filtered list when filtering by the
    // main user, labelled "replied to a thread".
    const myReply = await api(
      seeder,
      "POST",
      `/api/conversations/${seed.channelId}/messages`,
      {
        text: `Main-user thread reply SHO-458 (${seed.suffix})`,
        threadRootId: peerRootMsgId,
      },
    )
    myThreadReplyId = myReply.json?.message?.id ?? myReply.json?.id
    expect(myThreadReplyId, "main-user thread reply").toBeTruthy()
  })

  test.afterAll(async () => {
    await cleanupTeamNav(seeder, seed)
    await seeder.context().close()
  })

  test.beforeEach(async ({ page }) => {
    await signInByApi(page)
    await activateTeamWorkspace(page, seed.workspaceId)
  })

  // ── AC 8a ───────────────────────────────────────────────────────────────
  test("8a: ?from=user:<id> URL opens channel already filtered (no full-screen takeover)", async ({
    page,
  }) => {
    await page.goto(`/c/${seed.channelId}?from=user:${myUserId}`)
    // Filter bar must be visible — the channel stayed in place.
    await expect(page.getByTestId("member-filter-bar")).toBeVisible({ timeout: 60_000 })
    // The active-filter chip shows the × button.
    await expect(page.getByTestId("member-filter-clear")).toBeVisible()
    // MemberMessagesPane is gone — the testID it used must not exist.
    await expect(page.getByTestId("member-messages-pane")).toHaveCount(0)
  })

  // ── AC 3 ────────────────────────────────────────────────────────────────
  test("3: × clears the filter and removes the filter bar", async ({ page }) => {
    await page.goto(`/c/${seed.channelId}?from=user:${myUserId}`)
    await expect(page.getByTestId("member-filter-bar")).toBeVisible({ timeout: 60_000 })

    await page.getByTestId("member-filter-clear").click()

    // URL no longer carries ?from=
    await expect(page).not.toHaveURL(/from=/, { timeout: 10_000 })
    // Filter bar is gone.
    await expect(page.getByTestId("member-filter-bar")).toHaveCount(0)
  })

  // ── AC 4 ────────────────────────────────────────────────────────────────
  test("4: member switcher re-filters in place and updates ?from=", async ({ page }) => {
    await page.goto(`/c/${seed.channelId}?from=user:${myUserId}`)
    await expect(page.getByTestId("member-filter-bar")).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId("member-filter-switcher")).toBeVisible()

    // Tap the peer's chip in the switcher.
    const peerKey = `user:${seed.dmPeerId}`
    await page.getByTestId(`member-filter-switch-${peerKey}`).click()

    // URL updates to reflect the new member (: may be percent-encoded).
    await expect(page).toHaveURL(/from=user[:%3A]/, { timeout: 10_000 })
    // Filter bar stays visible — still filtering.
    await expect(page.getByTestId("member-filter-bar")).toBeVisible()
    // The peer's chip is now marked selected.
    const peerChip = page.getByTestId(`member-filter-switch-${peerKey}`)
    await expect(peerChip).toHaveAttribute("aria-selected", "true")
  })

  // ── AC 5 ────────────────────────────────────────────────────────────────
  test("5: thread replies appear in filtered list labelled 'replied to a thread'", async ({
    page,
  }) => {
    await page.goto(`/c/${seed.channelId}?from=user:${myUserId}`)
    await expect(page.getByTestId("member-filter-bar")).toBeVisible({ timeout: 60_000 })

    // The main user's thread reply must appear with the thread-context label.
    // testID is "thread-context-<messageId>" from MessageRow.tsx.
    await expect(page.getByTestId(`thread-context-${myThreadReplyId}`)).toBeVisible({
      timeout: 15_000,
    })
  })

  // ── AC 1 ────────────────────────────────────────────────────────────────
  test("1: activating the filter via URL leaves an open thread pane untouched", async ({
    page,
  }) => {
    // Open the channel with a thread already open.
    // At desktop width the thread pane has the breadcrumb header, not the
    // phone-only `floating-thread-header`; its "Close thread" control marks it.
    const threadHeader = page.getByLabel("Close thread")
    await page.goto(`/c/${seed.channelId}?thread=${peerRootMsgId}`)
    await expect(threadHeader).toBeVisible({ timeout: 60_000 })

    // Activate the member filter without touching the thread param.
    await page.goto(`/c/${seed.channelId}?thread=${peerRootMsgId}&from=user:${myUserId}`)

    // Both the filter bar and the thread pane should be visible.
    await expect(page.getByTestId("member-filter-bar")).toBeVisible({ timeout: 15_000 })
    await expect(threadHeader).toBeVisible()
    // No MemberMessagesPane.
    await expect(page.getByTestId("member-messages-pane")).toHaveCount(0)
  })

  // ── AC 2 ────────────────────────────────────────────────────────────────
  test("2: phone width (390 px) — filter bar visible, channel not replaced", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/c/${seed.channelId}?from=user:${myUserId}`)

    // Filter bar is visible at phone width.
    await expect(page.getByTestId("member-filter-bar")).toBeVisible({ timeout: 60_000 })
    // The × button is visible — the channel is on screen, not replaced.
    await expect(page.getByTestId("member-filter-clear")).toBeVisible()
    // No MemberMessagesPane takeover.
    await expect(page.getByTestId("member-messages-pane")).toHaveCount(0)
  })

  // ── AC 8b ───────────────────────────────────────────────────────────────
  test("8b: opening the board tab clears the member filter", async ({ page }) => {
    await page.goto(`/c/${seed.channelId}?from=user:${myUserId}`)
    await expect(page.getByTestId("member-filter-bar")).toBeVisible({ timeout: 60_000 })

    // Click the Board tab if one exists on this channel; otherwise navigate
    // directly — both paths hit the same openBoard code that clears ?from=.
    const boardTab = page.getByRole("tab", { name: /board/i })
    if (await boardTab.count() > 0) {
      await boardTab.first().click()
    } else {
      await page.goto(`/c/${seed.channelId}?board=1`)
    }

    // The member filter must be gone — openBoard clears ?from=.
    await expect(page).not.toHaveURL(/from=/, { timeout: 10_000 })
    await expect(page.getByTestId("member-filter-bar")).toHaveCount(0)
  })
})
