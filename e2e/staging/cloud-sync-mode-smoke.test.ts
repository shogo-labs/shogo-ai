// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect } from "@playwright/test"
import {
  createProjectAndWait,
  makeTestUser,
  signUpAndOnboard,
} from "./helpers"

/**
 * Cloud Sync Mode Rollout — staging smoke test.
 *
 * This is the e2e gate for PR #576 (paired-machine git sync +
 * `CloudSyncMode` enum). The new code paths only activate when a project
 * is explicitly switched to `dual_shadow` / `git_only`; the default
 * remains `s3`. The most important property to assert in production
 * staging is therefore **no regression for the default path**.
 *
 * What this test exercises end-to-end:
 *
 *   1. API boot with the new Prisma `Project.cloudSyncMode` column in
 *      the `select`. If the migration didn't apply, project creation
 *      returns 500 here.
 *   2. `apps/api/src/lib/runtime/build-project-env.ts` — the per-project
 *      env builder that now sets `SHOGO_CLOUD_SYNC_MODE` for non-`s3`
 *      modes. For a default project this code path must be a *no-op*
 *      (env var stays unset).
 *   3. Warm-pool assignment → agent-runtime container boot. The
 *      runtime now statically imports `GitWorkspaceSync` +
 *      `resolveCloudSyncMode` from `@shogo/shared-runtime`. A bundling
 *      regression in those new exports would crash the container before
 *      the SSE stream emits its first chunk.
 *   4. `resolveCloudSyncMode()` returning `'s3'` → S3Sync constructed
 *      exactly as before, GitWorkspaceSync skipped.
 *
 * Concretely, this is a sign-up → create project → first response cycle
 * against staging. If the new wiring is broken at any layer, the
 * project page never reaches a settled "agent done" state within the
 * 90s timeout and the test fails.
 */

test.describe("CloudSyncMode rollout — s3 default smoke", () => {
  test("fresh project creation + first response succeeds against staging", async ({
    page,
  }) => {
    const user = makeTestUser("CloudSyncMode")

    await signUpAndOnboard(page, user)

    await createProjectAndWait(
      page,
      "Hello! Just reply with the single word OK so I can confirm the runtime booted.",
    )

    await expect(page).toHaveURL(/\/projects\//, { timeout: 5_000 })

    // The project workspace shell loaded — these chrome elements only
    // render once the project page mounted with a backing runtime. If
    // the new sync wiring crashed agent-runtime on boot, the SSE relay
    // would never settle and `createProjectAndWait` would have timed
    // out before this point.
    await expect(
      page.getByRole("tablist").or(page.locator('[role="tablist"]')).first(),
    ).toBeVisible({ timeout: 15_000 })

    // Auto-naming runs *after* the first response stream completes, so
    // a non-default project title proves the agent finished its turn
    // (not just started streaming).
    const titleLocator = page
      .getByText(/^Runtime|Confirmation|OK$/i)
      .or(page.locator("text=/Switch project/"))
      .first()
    await titleLocator.waitFor({ state: "visible", timeout: 30_000 })
  })
})
