// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Browser, type BrowserContext, type Page } from "./fixtures"
import { makeTestUser, signUpAndOnboard, type TestUser } from "./helpers"

/**
 * Inviting people, end to end on a hosted deployment (SHO-454).
 *
 * The card's acceptance criteria are about the *dialog*, and the dialog only
 * renders where a server can actually deliver an invite: on the web, and on the
 * desktop for a cloud workspace. `canInviteHere` hides it in local mode, so the
 * local suite cannot reach it — this spec is the one that drives it.
 *
 * Four real accounts:
 *   - owner:    creates the team workspace through onboarding.
 *   - editor:   joins through a `member` link, so it may invite under the
 *               default policy and must lose the entry point under `admins`.
 *   - viewer:   joins through a `viewer` link and must never see the entry point.
 *   - invitee:  accepts the link the dialog copied.
 *
 * The permission matrix itself is covered in-process by
 * `apps/api/src/__tests__/rbac/guests.integration.test.ts`; this spec proves the
 * deployed stack renders the right entry points and that the link the dialog
 * hands out really joins someone.
 *
 * Run:
 *   npx playwright test --config e2e/playwright.config.ts invite-dialog
 */

interface Actor {
  user: TestUser
  context: BrowserContext
  page: Page
}

interface ApiResult {
  status: number
  body: any
}

const API_BASE = process.env.E2E_API_URL || process.env.STAGING_API_URL || ""

async function api(page: Page, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const origin = new URL(page.url()).origin
  const res = await page.request.fetch(`${API_BASE}${path}`, {
    method,
    headers: { Origin: origin, ...(body ? { "content-type": "application/json" } : {}) },
    data: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status(), body: await res.json().catch(() => null) }
}

async function newActor(browser: Browser, prefix: string): Promise<Actor> {
  const user = makeTestUser(prefix)
  const context = await browser.newContext()
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  const page = await context.newPage()
  await signUpAndOnboard(page, user)
  return { user, context, page }
}

async function teamWorkspaceId(page: Page): Promise<string> {
  const res = await api(page, "GET", "/api/workspaces")
  const rows = (res.body?.items ?? res.body?.data?.items ?? []) as Array<{ id: string; kind?: string }>
  const id = rows.find((w) => w.kind !== "personal")?.id
  if (!id) throw new Error(`no team workspace: ${JSON.stringify(res.body)}`)
  return id
}

/** The rail button is the one entry point that is always mounted. */
function inviteEntryPoint(page: Page) {
  return page.getByTestId("rail-invite-people")
}

async function openInviteDialog(page: Page): Promise<void> {
  await inviteEntryPoint(page).click()
  await expect(page.getByText("Invite people", { exact: true }).first()).toBeVisible({ timeout: 15_000 })
}

async function closeInviteDialog(page: Page): Promise<void> {
  await page.getByLabel("Close").first().click()
  await expect(page.getByLabel("Email addresses to invite")).toHaveCount(0)
}

/** The dialog's own view of the workspace's links, read the way it reads them. */
async function links(page: Page, workspaceId: string): Promise<any[]> {
  const res = await api(page, "GET", `/api/invite-links?workspaceId=${workspaceId}`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body?.items ?? []
}

async function pendingInvitations(page: Page, workspaceId: string): Promise<any[]> {
  const res = await api(page, "GET", `/api/invitations?workspaceId=${workspaceId}`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return (res.body?.items ?? res.body?.data?.items ?? []).filter((i: any) => i.status === "pending")
}

test.describe("Invite people (SHO-454)", () => {
  test.describe.configure({ mode: "serial" })

  const suffix = Date.now().toString(36)
  const PENDING = `already-${suffix}@mailnull.com`
  const SENT_A = `sent-a-${suffix}@mailnull.com`
  const SENT_C = `sent-c-${suffix}@mailnull.com`

  let owner: Actor
  let workspaceId: string

  test.beforeAll(async ({ browser }) => {
    owner = await newActor(browser, "invite-owner")
    workspaceId = await teamWorkspaceId(owner.page)
  })

  test.afterAll(async () => {
    await owner?.context.close()
  })

  test("the sidebar opens the dialog in one click, without leaving the app", async () => {
    const { page, context } = owner
    const before = context.pages().length
    const url = page.url()

    await openInviteDialog(page)

    // One click, in place: no trip through Settings, no second window.
    expect(page.url()).toBe(url)
    expect(page.url()).not.toContain("settings")
    expect(context.pages().length).toBe(before)
    await expect(page.getByLabel("Email addresses to invite")).toBeVisible()

    await closeInviteDialog(page)
  })

  test("a pasted list becomes chips, and a bad address stays visible", async () => {
    const { page } = owner
    await openInviteDialog(page)

    const input = page.getByLabel("Email addresses to invite")
    await input.click()
    // Typed, not filled: the field commits a chip on every separator keystroke.
    await input.pressSequentially(`${SENT_A}, ${PENDING} bad ${SENT_C}`, { delay: 10 })
    await input.press("Enter")

    await expect(page.getByTestId(`invite-chip-${SENT_A}`)).toBeVisible()
    await expect(page.getByTestId(`invite-chip-${PENDING}`)).toBeVisible()
    await expect(page.getByTestId(`invite-chip-${SENT_C}`)).toBeVisible()
    // The malformed address is kept, not silently dropped.
    await expect(page.getByTestId("invite-chip-bad")).toBeVisible()

    await closeInviteDialog(page)
  })

  test("sending skips a pending address, offers Resend, and Resend extends the expiry", async () => {
    const { page } = owner

    // Make PENDING already invited, so the dialog has something to skip.
    const seeded = await api(page, "POST", "/api/invitations", {
      workspaceId,
      email: PENDING,
      role: "member",
      status: "pending",
    })
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200)

    await openInviteDialog(page)
    const input = page.getByLabel("Email addresses to invite")
    await input.click()
    await input.pressSequentially(`${SENT_A}, ${PENDING} ${SENT_C}`, { delay: 10 })
    await input.press("Enter")

    // The pending address is recognised before anything is sent.
    await expect(page.getByLabel(`Resend invitation to ${PENDING}`)).toBeVisible()

    await page.getByLabel("Send invitations").click()

    // Both fresh addresses went out; the pending one did not fail the batch.
    await expect
      .poll(async () => (await pendingInvitations(page, workspaceId)).map((i) => i.email), { timeout: 30_000 })
      .toEqual(expect.arrayContaining([SENT_A, SENT_C, PENDING]))

    const before = (await pendingInvitations(page, workspaceId)).find((i) => i.email === PENDING)
    expect(before?.expiresAt).toBeTruthy()

    // Resend pushes the expiry out again.
    await page.getByLabel(`Resend invitation to ${PENDING}`).click()
    await expect
      .poll(
        async () => {
          const now = (await pendingInvitations(page, workspaceId)).find((i) => i.email === PENDING)
          return now?.expiresAt ? new Date(now.expiresAt).getTime() : 0
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(new Date(before.expiresAt).getTime())

    await closeInviteDialog(page)
  })

  test("Copy link hands out a /invite/<token> URL that a second person can accept", async () => {
    const { page } = owner
    await openInviteDialog(page)

    // No link yet: create one as Editor with the default 7-day expiry.
    const create = page.getByLabel("Create invite link")
    if (await create.isVisible().catch(() => false)) await create.click()
    await expect(page.getByLabel("Copy invite link")).toBeVisible({ timeout: 15_000 })

    const [link] = await links(page, workspaceId)
    expect(link.role).toBe("member")
    const days = (new Date(link.expiresAt).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.5)
    expect(days).toBeLessThan(7.5)

    await page.getByLabel("Copy invite link").click()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toContain(`/invite/${link.token}`)
    expect(copied).toMatch(/^https?:\/\//)

    await closeInviteDialog(page)

    // A second person opens the copied link and joins with that role.
    const invitee = await newActor(page.context().browser()!, "invite-accept")
    try {
      const accepted = await api(invitee.page, "POST", `/api/invite-links/${link.token}/accept`)
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)

      const perms = await api(invitee.page, "GET", `/api/workspaces/${workspaceId}/permissions`)
      expect(perms.status).toBe(200)
      expect(perms.body.data.role).toBe("member")
    } finally {
      await invitee.context.close()
    }
  })

  test("Reset invalidates the link that was already copied", async () => {
    const { page } = owner
    const [old] = await links(page, workspaceId)
    expect(old).toBeTruthy()

    await openInviteDialog(page)
    await page.getByLabel("Reset invite link").click()
    await expect
      .poll(async () => (await links(page, workspaceId)).map((l) => l.token), { timeout: 30_000 })
      .not.toContain(old.token)
    await closeInviteDialog(page)

    // The old token is dead: the accept page cannot resolve it any more.
    const stale = await api(page, "GET", `/api/invite-links/${old.token}/info`)
    expect([404, 410]).toContain(stale.status)
  })

  test("an Editor sees the entry point under the default policy and loses it under admins-only", async () => {
    const { page } = owner
    const [link] = await links(page, workspaceId)

    const editor = await newActor(page.context().browser()!, "invite-editor")
    try {
      const accepted = await api(editor.page, "POST", `/api/invite-links/${link.token}/accept`)
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)

      // Default policy: an Editor may invite, and may not mint an admin.
      await editor.page.goto("/")
      await expect(inviteEntryPoint(editor.page)).toBeVisible({ timeout: 30_000 })
      const escalate = await api(editor.page, "POST", "/api/invite-links", { workspaceId, role: "admin" })
      expect(escalate.status).toBe(403)

      // Admins-only: the entry point goes away and the API refuses too.
      const restrict = await api(page, "PATCH", `/api/workspaces/${workspaceId}/invite-policy`, {
        invitePolicy: "admins",
      })
      expect(restrict.status, JSON.stringify(restrict.body)).toBe(200)
      try {
        await editor.page.reload()
        await expect(inviteEntryPoint(editor.page)).toHaveCount(0, { timeout: 30_000 })
        const refused = await api(editor.page, "POST", "/api/invite-links", { workspaceId, role: "viewer" })
        expect(refused.status).toBe(403)
      } finally {
        await api(page, "PATCH", `/api/workspaces/${workspaceId}/invite-policy`, { invitePolicy: "members" })
      }
    } finally {
      await editor.context.close()
    }
  })

  test("a Viewer never sees the entry point", async () => {
    const { page } = owner
    const viewerLink = await api(page, "POST", "/api/invite-links", { workspaceId, role: "viewer" })
    expect(viewerLink.status, JSON.stringify(viewerLink.body)).toBe(200)

    const viewer = await newActor(page.context().browser()!, "invite-viewer")
    try {
      const accepted = await api(viewer.page, "POST", `/api/invite-links/${viewerLink.body.data.token}/accept`)
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)

      await viewer.page.goto("/")
      await expect(inviteEntryPoint(viewer.page)).toHaveCount(0, { timeout: 30_000 })

      const refused = await api(viewer.page, "POST", "/api/invite-links", { workspaceId, role: "viewer" })
      expect(refused.status).toBe(403)
    } finally {
      await viewer.context.close()
    }
  })
})
