// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Storage metering (SHO-423) — what a workspace's own settings may see, and the
 * super admin's platform view.
 *
 * `GET /api/workspaces/:id/storage` is the one endpoint in this card with a
 * role-dependent body, and it lives inside `server.ts` (no router test harness),
 * so this spec is where the gate is actually exercised against a running API:
 *
 *   owner  → breakdown, real per-project bytes, history and the month estimate;
 *   member → the total only (the breakdown names every project in the workspace,
 *            including the hidden ones they cannot open);
 *   nobody → 403.
 *
 * `GET /api/admin/storage` is super_admin-only, so the second person — a plain
 * `member` seeded the same way `huddle-seed-user.ts` seeds the team-nav peer —
 * must be refused. The platform summary itself is stubbed on its own endpoint
 * for the admin page, because a local stack has no S3 footprint to measure and
 * the numbers are not what this spec is about.
 *
 * The Settings → Compute half of the acceptance criterion is pinned by
 * `apps/mobile/components/settings/__tests__/compute-storage-breakdown.rtl.test.tsx`:
 * Settings bounces a `compute` tab back to `workspace` whenever `isLocal`, so
 * that tab cannot be reached from this suite at all.
 *
 * Needs the local stack (`E2E_LOCAL_START_STACK=1` starts it).
 */
import { execFileSync } from "child_process"
import { resolve } from "path"
import { expect, test, type Browser, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { api, signInByApi, teamWorkspaceId } from "./team-nav-seed"

const REPO = resolve(__dirname, "../..")
const DATABASE_URL =
  process.env.E2E_LOCAL_DATABASE_URL ||
  `file:${resolve(REPO, process.env.E2E_LOCAL_DB || "test-results/e2e-local.db")}`

const PEER = {
  email: "storage-qa-peer@example.com",
  password: "storage-qa-peer-pass",
  name: "Sam Member",
}

/** Same shape `getPlatformStorageSummary` returns (see analytics.tsx). */
const PLATFORM_SUMMARY = {
  lastPassAt: "2026-11-18T12:00:00.000Z",
  buckets: { measuredBytes: 1610612736, workspaces: 4 },
  categories: {
    project_files: 1073741824,
    repo: 536435456,
    assets: 0,
    backups: 0,
    chat_files: 0,
    workspace_root: 0,
    published: 0,
    quarantine: 2097152,
    vm_snapshots: 0,
  },
  billableBytes: 1610608640,
  overheadBytes: 2097152,
  unmeasured: [],
  month: { gbMonths: 0.5, shadowUsd: 0.08, chargedUsd: 0, mode: "shadow" as const },
  topByBytes: [
    { workspaceId: "ws-1", name: "Acme", totalBytes: 1610612736, billableBytes: 1610608640, allowanceBytes: 5368709120 },
  ],
  topByOverage: [
    { workspaceId: "ws-1", name: "Acme", totalBytes: 1610612736, overageBytes: 0, allowanceBytes: 5368709120 },
  ],
}

/**
 * Adds the second person to the local team workspace as a plain `member` and
 * returns their id. Local mode refuses a second sign-up, so the user and its
 * credential are written straight to the stack's SQLite file (`huddle-seed-user.ts`).
 */
function seedMember(): string {
  const out = execFileSync(
    "bun",
    ["--no-env-file", resolve(__dirname, "huddle-seed-user.ts"), PEER.email, PEER.password, PEER.name],
    { cwd: REPO, env: { ...process.env, DATABASE_URL }, encoding: "utf8" },
  )
  return JSON.parse(out.trim().split("\n").pop()!).userId as string
}

/** A second session in its own context, signed in as the member. */
async function memberContext(browser: Browser) {
  const context = await browser.newContext()
  const signedIn = await context.request.post(`${LOCAL_API_BASE}/api/auth/sign-in/email`, {
    data: { email: PEER.email, password: PEER.password },
  })
  if (!signedIn.ok()) throw new Error(`member sign-in failed: ${signedIn.status()} ${await signedIn.text()}`)
  return context
}

let page: Page

test.describe("workspace storage endpoint", () => {
  test.describe.configure({ mode: "serial" })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    await signInByApi(page)
  })

  test.afterAll(async () => {
    await page.context().close()
  })

  test("an owner gets the breakdown, per-project bytes, history and the month estimate", async () => {
    const workspaceId = await teamWorkspaceId(page)
    const res = await api(page, "GET", `/api/workspaces/${workspaceId}/storage`)

    expect(res.status).toBe(200)
    const body = res.json as Record<string, any>
    expect(typeof body.totalBytes).toBe("number")
    expect(typeof body.billableBytes).toBe("number")
    expect(body.limitBytes).toBeGreaterThan(0)

    // The detail half: a zero row still has to carry the shape, because the card
    // renders one row per category and one per project from it.
    expect(body.categories).toBeTruthy()
    for (const category of ["project_files", "repo", "assets", "backups", "chat_files", "quarantine", "vm_snapshots"]) {
      expect(typeof body.categories[category]).toBe("number")
    }
    expect(Array.isArray(body.projects)).toBe(true)
    expect(Array.isArray(body.history)).toBe(true)
    expect(Array.isArray(body.unmeasured)).toBe(true)
    for (const project of body.projects as Array<Record<string, unknown>>) {
      expect(typeof project.projectId).toBe("string")
      expect(typeof project.bytes).toBe("number")
    }

    // History rows are one per UTC day, and the estimate is GB-months plus USD.
    for (const day of body.history as Array<Record<string, any>>) {
      expect(day.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(typeof day.totalBytes).toBe("number")
    }
    expect(typeof body.month.billableGbMonths).toBe("number")
    expect(typeof body.month.estimatedUsd).toBe("number")
    // Shadow until Russell sets the rate: a fresh deployment must not charge.
    expect(body.month.mode).toBe("shadow")
  })

  test("a plain member gets the total only, never the breakdown", async ({ browser }) => {
    seedMember()
    const workspaceId = await teamWorkspaceId(page)
    const context = await memberContext(browser)
    try {
      const res = await context.request.get(`${LOCAL_API_BASE}/api/workspaces/${workspaceId}/storage`)
      expect(res.status()).toBe(200)

      const body = (await res.json()) as Record<string, unknown>
      expect(typeof body.totalBytes).toBe("number")
      expect(typeof body.limitBytes).toBe("number")
      // The breakdown names every project in the workspace, hidden ones included.
      expect(body.categories).toBeUndefined()
      expect(body.projects).toBeUndefined()
      expect(body.history).toBeUndefined()
      expect(body.month).toBeUndefined()
    } finally {
      await context.close()
    }
  })

  test("someone outside the workspace is refused", async ({ browser }) => {
    const workspaceId = await teamWorkspaceId(page)
    const stranger = await browser.newContext()
    try {
      const res = await stranger.request.get(`${LOCAL_API_BASE}/api/workspaces/${workspaceId}/storage`)
      expect(res.status()).toBe(403)
    } finally {
      await stranger.close()
    }
  })

  test("the platform storage view is refused to a non-super-admin", async ({ browser }) => {
    seedMember()
    const context = await memberContext(browser)
    try {
      const res = await context.request.get(`${LOCAL_API_BASE}/api/admin/storage`)
      expect(res.status()).toBe(403)
    } finally {
      await context.close()
    }
  })
})

test.describe("admin analytics storage section", () => {
  test.describe.configure({ mode: "serial" })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
    await signInByApi(page)
  })

  test.afterAll(async () => {
    await page.context().close()
  })

  const stubStorage = async (body: unknown) => {
    await page.route("**/api/admin/storage*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      }),
    )
  }

  test("renders the platform footprint by category, billable vs overhead and the month estimate", async () => {
    await stubStorage({ ok: true, data: PLATFORM_SUMMARY })
    await page.goto("/admin/analytics")

    await expect(page.getByText("Platform S3 footprint and month-to-date billing")).toBeVisible({ timeout: 60_000 })

    // Category rows, including the overhead one the customer is never billed for.
    await expect(page.getByText("Quarantine (overhead)")).toBeVisible()
    await expect(page.getByText("Git & LFS")).toBeVisible()
    // Ranked workspaces and the shadow note on the month figure.
    await expect(page.getByText("Biggest workspaces")).toBeVisible()
    await expect(page.getByText(/billable GB-months this month/)).toBeVisible()
    await expect(page.getByText(/would charge/)).toBeVisible()
    await expect(page.getByText(/would charge \$0\.08/)).toBeVisible()
  })

  test("an older pod's payload says so instead of crashing the page", async () => {
    await stubStorage({ ok: true })
    await page.goto("/admin/analytics")

    // A rolling deploy can answer with no `data`; the section must degrade, and
    // the rest of the page must still mount (round-1 QA: it threw mid-render).
    await expect(page.getByText("Storage data unavailable.")).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText("Platform S3 footprint and month-to-date billing")).toBeVisible()
  })
})
