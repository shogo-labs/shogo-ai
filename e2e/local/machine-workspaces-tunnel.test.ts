// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A paired desktop's *own* workspaces, reached over the tunnel (SHO-54).
 *
 * The cloud relay forwards every call to the desktop's `/api/*` as the cloud
 * user, so what it asks for is decided by `workspaceId`. This desktop has more
 * than one workspace, and the tunnel path used to answer every such call with
 * whichever workspace `findFirst()` returned — the machine's second workspace
 * silently served the first one's projects and folders. The tunnel only sends
 * ids the cloud user picked, so both workspaces must answer for themselves.
 *
 * The cloud half (machine list, wake, 503 when offline) is covered by
 * `apps/api/src/__tests__/machines-routes.test.ts`; this spec drives the real
 * local API, middleware and SQLite DB that the relay lands on.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts machine-workspaces-tunnel
 */
import { test, expect, request as playwrightRequest, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:8002"
/** What the cloud relay puts on every forwarded call. */
const TUNNEL_HEADERS = { "x-tunnel-auth-user-id": "cloud-user-sho54" }
const suffix = Date.now().toString(36)

async function api(
  page: Page,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await page.request.fetch(`${API}${path}`, {
    method,
    headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...opts.headers },
    data: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  return { status: res.status(), json: await res.json().catch(() => null) }
}

function ids(json: any, key: string): string[] {
  const list = json?.[key] ?? json?.data?.[key] ?? json?.data ?? json?.items ?? []
  return (Array.isArray(list) ? list : []).map((row: any) => row.id)
}

test.describe("A paired Mac's own workspaces over the tunnel", () => {
  let page: Page
  let personal = ""
  let team = ""
  let personalProject = ""
  let teamProject = ""
  let teamFolder = ""

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    page = await browser.newPage()

    // Local mode signs the desktop in on first load; the cookie is what
    // `page.request` reuses below.
    await page.goto("/", { waitUntil: "domcontentloaded" })
    let workspaces: any = null
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const res = await api(page, "GET", "/api/workspaces")
      if (res.status === 200) {
        workspaces = res.json
        break
      }
      await page.waitForTimeout(1000)
    }
    expect(workspaces, "the local API never answered /api/workspaces").toBeTruthy()

    const rows: Array<{ id: string; kind?: string }> =
      workspaces?.items ?? workspaces?.data?.items ?? (Array.isArray(workspaces) ? workspaces : [])
    personal = rows.find((row) => row.kind === "personal")?.id ?? ""
    team = rows.find((row) => row.kind !== "personal")?.id ?? ""
    expect(personal, "no personal workspace on this machine").toBeTruthy()
    expect(team, "no team workspace on this machine").toBeTruthy()

    for (const [workspaceId, name] of [
      [personal, `Personal work ${suffix}`],
      [team, `Team work ${suffix}`],
    ] as const) {
      const created = await api(page, "POST", "/api/projects", {
        body: {
          name,
          workspaceId,
          tier: "starter",
          status: "draft",
          accessLevel: "anyone",
          schemas: [],
        },
      })
      const id = created.json?.data?.id ?? created.json?.id
      expect(id, `project in ${workspaceId}: ${JSON.stringify(created.json)}`).toBeTruthy()
      if (workspaceId === personal) personalProject = id
      else teamProject = id
    }

    const folder = await api(page, "POST", "/api/folders", {
      body: { name: `QA folder ${suffix}`, workspaceId: team },
    })
    teamFolder = folder.json?.data?.id ?? folder.json?.id ?? ""
    expect(teamFolder, `folder in the team workspace: ${JSON.stringify(folder.json)}`).toBeTruthy()
  })

  test.afterAll(async () => {
    for (const id of [personalProject, teamProject]) {
      if (id) await api(page, "DELETE", `/api/projects/${id}`)
    }
    if (teamFolder) await api(page, "DELETE", `/api/folders/${teamFolder}`)
    await page?.close()
  })

  test("each workspace answers for its own projects", async () => {
    const teamList = await api(page, "GET", `/api/projects?workspaceId=${team}`, {
      headers: TUNNEL_HEADERS,
    })
    expect(teamList.status, JSON.stringify(teamList.json)).toBe(200)
    expect(ids(teamList.json, "projects")).toContain(teamProject)
    expect(ids(teamList.json, "projects")).not.toContain(personalProject)

    const personalList = await api(page, "GET", `/api/projects?workspaceId=${personal}`, {
      headers: TUNNEL_HEADERS,
    })
    expect(personalList.status, JSON.stringify(personalList.json)).toBe(200)
    expect(ids(personalList.json, "projects")).toContain(personalProject)
    expect(ids(personalList.json, "projects")).not.toContain(teamProject)
  })

  test("folders follow the workspace too", async () => {
    const teamFolders = await api(page, "GET", `/api/folders?workspaceId=${team}`, {
      headers: TUNNEL_HEADERS,
    })
    expect(teamFolders.status, JSON.stringify(teamFolders.json)).toBe(200)
    expect(ids(teamFolders.json, "folders")).toContain(teamFolder)

    const personalFolders = await api(page, "GET", `/api/folders?workspaceId=${personal}`, {
      headers: TUNNEL_HEADERS,
    })
    expect(ids(personalFolders.json, "folders")).not.toContain(teamFolder)
  })

  test("the machine snapshot lists both workspaces and their counts", async () => {
    const snapshot = await api(page, "GET", "/api/local/machine", { headers: TUNNEL_HEADERS })
    expect(snapshot.status, JSON.stringify(snapshot.json)).toBe(200)
    const workspaces: Array<{ id: string; projectCount: number }> =
      snapshot.json?.workspaces ?? snapshot.json?.data?.workspaces ?? []
    const byId = new Map(workspaces.map((row) => [row.id, row]))
    expect([...byId.keys()]).toEqual(expect.arrayContaining([personal, team]))
    expect(byId.get(team)?.projectCount ?? 0).toBeGreaterThanOrEqual(1)
    expect(byId.get(personal)?.projectCount ?? 0).toBeGreaterThanOrEqual(1)
    expect(snapshot.json?.activity, "the snapshot carries what the machine is doing").toBeTruthy()
  })

  test("localhost alone is not enough: no session, no tunnel, no snapshot", async () => {
    // A separate request context: no browser cookies, so this is the same
    // anonymous loopback call a stray local process would make.
    const anonymous = await playwrightRequest.newContext({ baseURL: API })
    try {
      const res = await anonymous.get("/api/local/machine")
      expect(res.status()).toBe(403)
    } finally {
      await anonymous.dispose()
    }
  })
})
