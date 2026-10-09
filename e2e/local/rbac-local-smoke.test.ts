// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local (desktop) mode wires the RBAC routes and the `myPermissions` response
 * middleware into its own app (apps/api/src/app/create-local-app.ts), apart
 * from the cloud server. The auto-signed-in local user owns its workspaces, so
 * this smoke checks the owner path end to end: permissions endpoints, project
 * visibility, the project members endpoint, and that restricting a project
 * keeps it in the owner's list and project screen.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts rbac-local-smoke
 */
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { api, signIn, teamWorkspaceId } from "./team-nav-seed"

test.describe("RBAC in local mode", () => {
  test.describe.configure({ mode: "serial" })

  const name = `RBAC Smoke ${Date.now().toString(36)}`
  let page: Page
  let workspaceId: string
  let projectId: string

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signIn(page)
    workspaceId = await teamWorkspaceId(page)
    const session = await (await page.request.get(`${LOCAL_API_BASE}/api/auth/get-session`)).json()
    const created = await api(page, "POST", "/api/projects", {
      name,
      workspaceId,
      createdBy: session?.user?.id,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
      schemas: [],
    })
    projectId = created.json?.data?.id ?? created.json?.id
    if (!projectId) throw new Error(`project create failed: ${JSON.stringify(created.json)}`)
  })

  test.afterAll(async () => {
    if (projectId) await api(page, "DELETE", `/api/projects/${projectId}`).catch(() => {})
    await page?.close()
  })

  test("the local user is the workspace owner", async () => {
    const res = await api(page, "GET", `/api/workspaces/${workspaceId}/permissions`)
    expect(res.status).toBe(200)
    expect(res.json.data.role).toBe("owner")
    expect(res.json.data.permissions).toEqual(expect.arrayContaining(["workspace.members:manage", "project:create"]))
  })

  test("project payloads carry myPermissions", async () => {
    const one = await api(page, "GET", `/api/projects/${projectId}`)
    expect(one.status).toBe(200)
    const mine: string[] = one.json?.data?.myPermissions ?? []
    expect(mine).toEqual(expect.arrayContaining(["project:read", "project:update", "project.members:manage"]))

    const list = await api(page, "GET", `/api/projects?workspaceId=${workspaceId}`)
    const row = (list.json?.items ?? []).find((p: { id: string }) => p.id === projectId)
    expect(row?.myPermissions).toEqual(expect.arrayContaining(["project:read"]))

    const perms = await api(page, "GET", `/api/projects/${projectId}/permissions`)
    expect(perms.status).toBe(200)
    expect(perms.json.data.permissions).toEqual(expect.arrayContaining(["project:delete"]))
  })

  test("restricting a project keeps it visible to the owner", async () => {
    const restrict = await api(page, "PATCH", `/api/projects/${projectId}/visibility`, { visibility: "restricted" })
    expect(restrict.status, JSON.stringify(restrict.json)).toBe(200)

    const members = await api(page, "GET", `/api/projects/${projectId}/members`)
    expect(members.status).toBe(200)
    expect(members.json.data.visibility).toBe("restricted")
    expect(members.json.data.workspaceMembers.length).toBeGreaterThan(0)

    const list = await api(page, "GET", `/api/projects?workspaceId=${workspaceId}`)
    expect((list.json?.items ?? []).map((p: { id: string }) => p.id)).toContain(projectId)

    const invalid = await api(page, "PATCH", `/api/projects/${projectId}/visibility`, { visibility: "secret" })
    expect(invalid.status).toBe(400)
  })
})
