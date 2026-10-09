// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Browser, type BrowserContext, type Page } from "./fixtures"
import { makeTestUser, signUpAndOnboard, type TestUser } from "./helpers"

/**
 * Workspace and project access control against a hosted deployment.
 *
 * Three real accounts, each in its own browser context:
 *   - owner:    creates the team workspace (onboarding), an open project and a
 *               project that is later made Restricted.
 *   - teammate: joins the workspace through a `member` invite link.
 *   - guest:    joins only the open project through a project `viewer` link,
 *               so it never becomes a workspace member.
 *
 * Most checks go through `page.request`, which carries the context's session
 * cookie, so they hit the same auth path as the app. The in-process suites in
 * apps/api/src/__tests__/rbac cover the full permission matrix; this spec
 * proves the deployed stack (proxy, cookies, real Postgres) enforces it.
 *
 * Set `E2E_RBAC_ENFORCE=on` when the target runs `RBAC_ENFORCE=on` to also
 * assert denials that shadow mode deliberately lets through.
 *
 * Run:
 *   npx playwright test --config e2e/playwright.config.ts rbac
 */

const ENFORCED = process.env.E2E_RBAC_ENFORCE === "on"

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
  const page = await context.newPage()
  await signUpAndOnboard(page, user)
  return { user, context, page }
}

async function teamWorkspaceId(page: Page): Promise<string> {
  const res = await api(page, "GET", "/api/workspaces")
  const rows = (res.body?.items ?? res.body?.data?.items ?? res.body?.data ?? []) as Array<{ id: string; kind?: string }>
  const id = rows.find((w) => w.kind === "team")?.id ?? rows.find((w) => w.kind !== "personal")?.id
  if (!id) throw new Error(`no team workspace: ${JSON.stringify(res.body)}`)
  return id
}

function projectIds(res: ApiResult): string[] {
  const rows = (res.body?.items ?? res.body?.data?.items ?? res.body?.data ?? []) as Array<{ id: string }>
  return rows.map((p) => p.id)
}

async function createProject(page: Page, workspaceId: string, name: string): Promise<string> {
  const res = await api(page, "POST", "/api/projects", { name, workspaceId })
  const id = res.body?.data?.id ?? res.body?.id
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
  expect(id).toBeTruthy()
  return id
}

async function acceptLink(page: Page, token: string): Promise<ApiResult> {
  return api(page, "POST", `/api/invite-links/${token}/accept`)
}

test.describe("RBAC: workspace and project access", () => {
  test.describe.configure({ mode: "serial" })

  const suffix = Date.now().toString(36)
  const OPEN_NAME = `RBAC Open ${suffix}`
  const RESTRICTED_NAME = `RBAC Restricted ${suffix}`

  let owner: Actor
  let teammate: Actor
  let guest: Actor
  let workspaceId: string
  let openId: string
  let restrictedId: string

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(420_000)
    owner = await newActor(browser, "RbacOwner")
    teammate = await newActor(browser, "RbacMate")
    guest = await newActor(browser, "RbacGuest")

    workspaceId = await teamWorkspaceId(owner.page)
    openId = await createProject(owner.page, workspaceId, OPEN_NAME)
    restrictedId = await createProject(owner.page, workspaceId, RESTRICTED_NAME)
  })

  test.afterAll(async () => {
    if (owner?.page) {
      for (const id of [openId, restrictedId].filter(Boolean)) {
        await api(owner.page, "DELETE", `/api/projects/${id}`).catch(() => {})
      }
    }
    for (const actor of [owner, teammate, guest]) await actor?.context.close().catch(() => {})
  })

  test("owner holds the full workspace permission set", async () => {
    const res = await api(owner.page, "GET", `/api/workspaces/${workspaceId}/permissions`)
    expect(res.status).toBe(200)
    expect(res.body.data.role).toBe("owner")
    expect(res.body.data.permissions).toEqual(expect.arrayContaining(["workspace.members:manage", "workspace.billing:manage", "project:create"]))
  })

  test("non-members cannot read the workspace or its projects", async () => {
    const perms = await api(teammate.page, "GET", `/api/workspaces/${workspaceId}/permissions`)
    expect([403, 404]).toContain(perms.status)

    const project = await api(teammate.page, "GET", `/api/projects/${openId}`)
    expect([403, 404]).toContain(project.status)

    const list = await api(teammate.page, "GET", `/api/projects?workspaceId=${workspaceId}`)
    expect(projectIds(list)).not.toContain(openId)
  })

  test("a workspace invite link makes the teammate a member", async () => {
    const link = await api(owner.page, "POST", "/api/invite-links", { workspaceId, role: "member" })
    expect(link.status, JSON.stringify(link.body)).toBe(200)

    const accepted = await acceptLink(teammate.page, link.body.data.token)
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)

    const perms = await api(teammate.page, "GET", `/api/workspaces/${workspaceId}/permissions`)
    expect(perms.status).toBe(200)
    expect(perms.body.data.role).toBe("member")
    expect(perms.body.data.permissions).toContain("project:create")
    expect(perms.body.data.permissions).not.toContain("workspace.members:manage")

    const list = await api(teammate.page, "GET", `/api/projects?workspaceId=${workspaceId}`)
    expect(projectIds(list)).toEqual(expect.arrayContaining([openId, restrictedId]))
  })

  test("members cannot escalate or manage invite links", async () => {
    const adminLink = await api(teammate.page, "POST", "/api/invite-links", { workspaceId, role: "admin" })
    expect(adminLink.status).toBe(403)

    const listLinks = await api(teammate.page, "GET", `/api/invite-links?workspaceId=${workspaceId}`)
    expect(listLinks.status).toBe(403)
  })

  test("restricting a project hides it from workspace members", async () => {
    const restrict = await api(owner.page, "PATCH", `/api/projects/${restrictedId}/visibility`, {
      visibility: "restricted",
    })
    expect(restrict.status, JSON.stringify(restrict.body)).toBe(200)

    const direct = await api(teammate.page, "GET", `/api/projects/${restrictedId}`)
    expect(direct.status).toBe(404)

    const list = await api(teammate.page, "GET", `/api/projects?workspaceId=${workspaceId}`)
    const ids = projectIds(list)
    expect(ids).toContain(openId)
    expect(ids).not.toContain(restrictedId)

    // The owner still reaches it.
    const ownerView = await api(owner.page, "GET", `/api/projects/${restrictedId}`)
    expect(ownerView.status).toBe(200)
  })

  test("the teammate's project list in the app hides the restricted project", async () => {
    const page = teammate.page
    await page.addInitScript((id) => {
      localStorage.setItem("shogo:active-workspace-id", id)
      localStorage.setItem("shogo:active-workspace-kind", JSON.stringify({ id, kind: "team" }))
    }, workspaceId)
    await page.goto("/")
    await page.getByRole("tab", { name: "Projects" }).click()
    await expect(page.getByText(OPEN_NAME).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(RESTRICTED_NAME)).toHaveCount(0)
  })

  test("granting a project role restores access at that role", async () => {
    const teammateId = (await api(teammate.page, "GET", "/api/auth/get-session")).body?.user?.id
    expect(teammateId).toBeTruthy()

    const grant = await api(owner.page, "POST", `/api/projects/${restrictedId}/members`, {
      userId: teammateId,
      role: "viewer",
    })
    expect(grant.status, JSON.stringify(grant.body)).toBe(201)

    const view = await api(teammate.page, "GET", `/api/projects/${restrictedId}`)
    expect(view.status).toBe(200)
    const myPermissions: string[] = view.body?.data?.myPermissions ?? view.body?.myPermissions ?? []
    expect(myPermissions).toContain("project:read")
    expect(myPermissions).not.toContain("project:update")

    // Workspace members keep their legacy write access while the target runs
    // RBAC_ENFORCE=shadow, so only assert the denial where enforcement is on.
    if (ENFORCED) {
      const rename = await api(teammate.page, "PATCH", `/api/projects/${restrictedId}`, { name: "renamed by viewer" })
      expect(rename.status).toBe(403)
    }
  })

  test("a project link makes a guest who sees only that project", async () => {
    const link = await api(owner.page, "POST", "/api/invite-links", { projectId: openId, role: "viewer" })
    expect(link.status, JSON.stringify(link.body)).toBe(200)

    const accepted = await acceptLink(guest.page, link.body.data.token)
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    expect(accepted.body.data.projectId).toBe(openId)

    // Project access does not make the guest a workspace member.
    const perms = await api(guest.page, "GET", `/api/workspaces/${workspaceId}/permissions`)
    expect([403, 404]).toContain(perms.status)
    const workspaces = await api(guest.page, "GET", "/api/workspaces")
    const wsIds = ((workspaces.body?.items ?? workspaces.body?.data ?? []) as Array<{ id: string }>).map((w) => w.id)
    expect(wsIds).not.toContain(workspaceId)

    const open = await api(guest.page, "GET", `/api/projects/${openId}`)
    expect(open.status).toBe(200)
    const restricted = await api(guest.page, "GET", `/api/projects/${restrictedId}`)
    expect(restricted.status).toBe(404)

    const create = await api(guest.page, "POST", "/api/projects", { name: "guest project", workspaceId })
    expect(create.status).toBe(403)
  })

  test("the project members endpoint shows the guest and the restricted grant", async () => {
    const openMembers = await api(owner.page, "GET", `/api/projects/${openId}/members`)
    expect(openMembers.status).toBe(200)
    const guestRow = (openMembers.body.data.members as Array<{ isGuest: boolean; role: string; user?: { email?: string } }>).find(
      (m) => m.user?.email === guest.user.email,
    )
    expect(guestRow).toMatchObject({ isGuest: true, role: "viewer" })

    const restrictedMembers = await api(owner.page, "GET", `/api/projects/${restrictedId}/members`)
    expect(restrictedMembers.status).toBe(200)
    expect(restrictedMembers.body.data.visibility).toBe("restricted")

    // Members of the workspace cannot read the project member list.
    const asTeammate = await api(teammate.page, "GET", `/api/projects/${openId}/members`)
    expect(asTeammate.status).toBe(403)
  })
})
