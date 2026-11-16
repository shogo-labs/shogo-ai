// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Browser, type BrowserContext, type Page } from "./fixtures"
import { mustExec } from "./runtime-exec"
import {
  bootstrapApiBase,
  bootstrapProSubscriptionViaApi,
  createProjectAndWait,
  makeTestUser,
  signUpAndOnboard,
  type TestUser,
} from "./helpers"

/**
 * SHO-401 — the paid per-GiB disk add-on, end to end.
 *
 * A workspace's tier includes a fixed amount of workspace drive (20 GiB on
 * micro/small). Anything above that is a paid add-on, charged daily against the
 * usage wallet. This spec proves the parts a unit test cannot:
 *
 *   1. A paid workspace can buy 50 GiB for a project: the panel reports
 *      included 20 + add-on 30 at $4.50/mo, the PUT succeeds, and on metal the
 *      guest's `df /app/workspace` really grows without a restart.
 *   2. A smaller size is refused with 422 `cannot_shrink` (drives never shrink).
 *   3. The workspace runtime has its own Disk setting: PUT
 *      /api/workspaces/:id/disk saves `Workspace.runtimeDiskGiB` and grows the
 *      bare `ws:<id>` runtime live.
 *   4. A free workspace cannot buy: `canBuyAddon` is false, the ceiling stays at
 *      the included 20 GiB, and a PUT above it is 402 `plan_required`.
 *   5. A non-owner member gets 403 on both PUT routes.
 *
 * Needs `SHOGO_E2E_BOOTSTRAP_SECRET` for the paid-plan backdoor; skips the
 * paid-plan steps without it. The live-grow assertions skip when the project is
 * not on a metal host.
 *
 * Run: E2E_TARGET_URL=... SHOGO_E2E_BOOTSTRAP_SECRET=... \
 *   npx playwright test --config e2e/playwright.config.ts disk-addon
 */

const GiB = 1024 ** 3
const PAID_USER = makeTestUser("DiskAddonPaid")
const FREE_USER = makeTestUser("DiskAddonFree")
const MATE_USER = makeTestUser("DiskAddonMate")

interface DiskState {
  requestedGiB: number | null
  effectiveGiB: number
  defaultGiB: number
  includedGiB: number
  maxGiB: number
  addonGiB: number
  pricePerGiBMonthUsd: number
  addonMonthlyUsd: number
  canIncrease: boolean
  canBuyAddon: boolean
  buyBlockedReason?: string
  substrate: "metal" | "knative" | "local"
  usage: { usedBytes: number; totalBytes: number } | null
  growError?: string
}

interface Actor {
  user: TestUser
  context: BrowserContext
  page: Page
}

async function newActor(browser: Browser, user: TestUser): Promise<Actor> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signUpAndOnboard(page, user)
  return { user, context, page }
}

function apiBase(): string {
  return bootstrapApiBase()
}

async function api(page: Page, method: string, path: string, body?: unknown) {
  const base = apiBase()
  const res = await page.request.fetch(`${base}${path}`, {
    method,
    headers: { Origin: base, ...(body ? { "content-type": "application/json" } : {}) },
    data: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status(), body: await res.json().catch(() => null) }
}

async function firstWorkspaceId(page: Page): Promise<string> {
  const res = await api(page, "GET", "/api/workspaces")
  const rows = (res.body?.items ?? res.body?.data?.items ?? res.body?.data ?? []) as Array<{
    id: string
    kind?: string
  }>
  const id = rows.find((w) => w.kind === "team")?.id ?? rows[0]?.id
  if (!id) throw new Error(`no workspace: ${JSON.stringify(res.body)}`)
  return id
}

/** `df -B1 --output=size <path>` in the project's runtime. */
async function guestDriveBytes(page: Page, projectId: string, path: string): Promise<number> {
  const out = await mustExec(page, projectId, `df -B1 --output=size ${path} | tail -1`)
  return Number(out.trim())
}

test.describe("Disk add-on (SHO-401)", () => {
  test.describe.configure({ mode: "serial" })

  let paid: Actor
  let free: Actor
  let mate: Actor
  let workspaceId = ""
  let projectId = ""
  let substrate: DiskState["substrate"] = "knative"

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(420_000)
    paid = await newActor(browser, PAID_USER)
    free = await newActor(browser, FREE_USER)
    mate = await newActor(browser, MATE_USER)
  })

  test.afterAll(async () => {
    if (paid?.page && projectId) {
      await api(paid.page, "DELETE", `/api/projects/${projectId}`).catch(() => {})
    }
    for (const actor of [paid, free, mate]) await actor?.context.close().catch(() => {})
  })

  test("a paid workspace can buy disk above what its tier includes", async () => {
    test.setTimeout(600_000)
    test.skip(
      !(await bootstrapProSubscriptionViaApi(paid.page, PAID_USER, "pro")),
      "needs SHOGO_E2E_BOOTSTRAP_SECRET for the paid-plan backdoor",
    )

    await createProjectAndWait(
      paid.page,
      "Create the simplest possible starter app: a single page that shows the word Hello. No extra pages, components, features, or backend.",
    )
    projectId = paid.page.url().match(/\/projects\/([^/?#]+)/)?.[1] ?? ""
    expect(projectId, `expected a /projects/<id> URL, got ${paid.page.url()}`).not.toBe("")
    workspaceId = await firstWorkspaceId(paid.page)

    const before = await api(paid.page, "GET", `/api/projects/${projectId}/disk`)
    expect(before.status, JSON.stringify(before.body)).toBe(200)
    const state = before.body as DiskState
    substrate = state.substrate
    expect(state.includedGiB).toBe(20)
    expect(state.pricePerGiBMonthUsd).toBe(0.15)
    expect(state.canBuyAddon, "a paid plan may buy the add-on").toBe(true)
    expect(state.maxGiB, "a paid workspace can go to the 200 GiB host cap").toBe(200)

    const beforeBytes = substrate === "metal" ? await guestDriveBytes(paid.page, projectId, "/app/workspace") : 0

    const put = await api(paid.page, "PUT", `/api/projects/${projectId}/disk`, { sizeGiB: 50 })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    const after = put.body as DiskState
    expect(after.effectiveGiB).toBe(50)
    expect(after.addonGiB, "50 GiB on a 20 GiB tier is 30 GiB of add-on").toBe(30)
    expect(after.addonMonthlyUsd, "30 GiB at $0.15/GiB-month").toBe(4.5)
    expect(after.growError, `live grow reported: ${after.growError}`).toBeUndefined()

    if (substrate === "metal") {
      // The guest sees the new size without a restart (the bug this card fixes).
      await expect
        .poll(async () => guestDriveBytes(paid.page, projectId, "/app/workspace"), { timeout: 30_000 })
        .toBeGreaterThan(beforeBytes)
      const grown = await guestDriveBytes(paid.page, projectId, "/app/workspace")
      expect(grown).toBeGreaterThanOrEqual(50 * GiB * 0.95)
    }
  })

  test("a smaller size is refused — disks never shrink", async () => {
    test.skip(!projectId, "no project from the first step")
    const res = await api(paid.page, "PUT", `/api/projects/${projectId}/disk`, { sizeGiB: 20 })
    expect(res.status).toBe(422)
    expect(res.body?.error?.code).toBe("cannot_shrink")
    const state = (await api(paid.page, "GET", `/api/projects/${projectId}/disk`)).body as DiskState
    expect(state.effectiveGiB, "a refused shrink must not change the size").toBe(50)
  })

  test("the workspace runtime has its own disk setting", async () => {
    test.setTimeout(600_000)
    test.skip(!workspaceId, "no workspace from the first step")

    const before = await api(paid.page, "GET", `/api/workspaces/${workspaceId}/disk`)
    expect(before.status, JSON.stringify(before.body)).toBe(200)
    const state = before.body as DiskState
    expect(state.includedGiB).toBe(20)
    expect(state.canBuyAddon).toBe(true)

    const put = await api(paid.page, "PUT", `/api/workspaces/${workspaceId}/disk`, { sizeGiB: 50 })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    const after = put.body as DiskState
    expect(after.effectiveGiB).toBe(50)
    expect(after.addonGiB).toBe(30)

    // Saved, not just echoed: a fresh GET reads Workspace.runtimeDiskGiB back.
    const reread = (await api(paid.page, "GET", `/api/workspaces/${workspaceId}/disk`)).body as DiskState
    expect(reread.requestedGiB, "runtimeDiskGiB must be persisted").toBe(50)
    expect(reread.effectiveGiB).toBe(50)
  })

  test("a free workspace cannot buy disk", async () => {
    test.skip(!workspaceId, "no workspace from the first step")
    const freeWorkspaceId = await firstWorkspaceId(free.page)

    const state = (await api(free.page, "GET", `/api/workspaces/${freeWorkspaceId}/disk`)).body as DiskState
    expect(state.canBuyAddon, "the free plan may not buy the add-on").toBe(false)
    expect(state.buyBlockedReason).toBe("plan_required")
    expect(state.maxGiB, "a free workspace is capped at what its tier includes").toBe(20)

    const put = await api(free.page, "PUT", `/api/workspaces/${freeWorkspaceId}/disk`, { sizeGiB: 50 })
    expect(put.status).toBe(402)
    expect(put.body?.error?.code).toBe("plan_required")
    expect(put.body?.error?.message, "the refusal must name the upgrade").toContain("Upgrade")
  })

  test("a non-owner member cannot change the disk", async () => {
    test.skip(!workspaceId || !projectId, "no workspace/project from the first step")

    const link = await api(paid.page, "POST", "/api/invite-links", { workspaceId, role: "member" })
    expect(link.status, JSON.stringify(link.body)).toBe(200)
    const accepted = await api(mate.page, "POST", `/api/invite-links/${link.body.data.token}/accept`)
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)

    const projectPut = await api(mate.page, "PUT", `/api/projects/${projectId}/disk`, { sizeGiB: 60 })
    expect(projectPut.status, "a member must not raise a project's disk").toBe(403)

    const workspacePut = await api(mate.page, "PUT", `/api/workspaces/${workspaceId}/disk`, { sizeGiB: 60 })
    expect(workspacePut.status, "a member must not raise the workspace disk").toBe(403)
  })
})
