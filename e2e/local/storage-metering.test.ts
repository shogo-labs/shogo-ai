// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The super admin storage surfaces (SHO-423) — the Storage section on
 * Admin → Analytics.
 *
 * Both cases stub `GET /api/admin/storage` on the browser side. That is
 * deliberate: this spec is about what the page does with the payload, and the
 * numbers are the service's job (covered by `storage.service.test.ts`, which
 * pins the category split, the billable/overhead split and the empty platform).
 *
 * The second case is the regression that started QA round 1: an older pod (or a
 * rolling deploy answering `{ ok: true }`) hands the page a summary with no
 * `month`, and `StorageSection` used to read `data.month.mode` unguarded, throw
 * mid-render and take the whole page down.
 *
 * ## What this spec cannot reach
 *
 * `GET /api/workspaces/:id/storage` and `GET /api/admin/storage` are registered
 * in the cloud composer (`apps/api/src/server.ts`) and `routes/admin.ts`; the
 * local/desktop composer (`app/create-local-app.ts`) mounts neither, so on the
 * local stack those two paths answer 404 to everyone, member or owner. The role
 * gate on the workspace endpoint — owner/admin/billing-admin get the breakdown,
 * a plain member gets the total, a non-member gets 403 — therefore has no e2e
 * home here; it is only reachable in a cloud-targeted suite, and `server.ts` has
 * no router harness. It is read-and-reviewed, not asserted by this file.
 *
 * Settings → Compute is unreachable on the local stack too (Settings bounces a
 * `compute` tab back to `workspace` whenever `isLocal`), so the "Compute tab
 * renders the breakdown" criterion lives in
 * `apps/mobile/components/settings/__tests__/compute-storage-breakdown.rtl.test.tsx`.
 *
 * Needs the local stack (`E2E_LOCAL_START_STACK=1` starts it).
 */
import { expect, test, type Page } from "@playwright/test"
import { signInByApi } from "./team-nav-seed"

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

let page: Page

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
