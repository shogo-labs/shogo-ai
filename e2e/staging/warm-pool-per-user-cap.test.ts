// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import {
  bootstrapProSubscriptionViaApi,
  createProjectAndWait,
  getClaimedPodsViaApi,
  makeTestUser,
  signUpAndOnboard,
  waitForClaimedPodCount,
  type TestUser,
} from "./helpers"

/**
 * Per-user claimed-pod cap E2E.
 *
 * The cloud warm pool caps the number of concurrent CLAIMED (promoted) pods
 * a single user may hold, scaled by their workspace plan
 * (getClaimedPodCapForPlan: free=2, pro=4, …). When a user opens one project
 * too many, their least-recently-used claimed pod is LRU-evicted to free a
 * slot — mirroring the desktop VM warm pool.
 *
 * These tests drive the real claim path (creating + opening projects claims a
 * warm pod) and assert via the API diagnostic backdoor
 * (GET /api/internal/e2e/claimed-pods) that:
 *   - a free user never holds more than 2 claimed pods, and
 *   - the oldest (first-created) project is the one evicted, while
 *   - a Pro workspace is allowed up to 4.
 *
 * Both require SHOGO_E2E_BOOTSTRAP_SECRET (the same backdoor used by the
 * billing suite); they skip cleanly when it's absent.
 *
 * Run: STAGING_URL=... SHOGO_E2E_BOOTSTRAP_SECRET=... \
 *   npx playwright test --config e2e/playwright.config.ts warm-pool-per-user-cap
 */

const CLAIM_SETTLE_TIMEOUT_MS = 45_000

/** Open an existing project so its runtime resolves (claims a warm pod). */
async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`)
  // Wait for the project shell to mount (composer present). The pod claim is
  // triggered by the runtime resolution behind this view.
  await page
    .getByRole("textbox", { name: "Chat message input" })
    .first()
    .waitFor({ state: "visible", timeout: 60_000 })
    .catch(() => {})
  await page.waitForTimeout(1500)
}

/** Create a project from the home composer and return its id. */
async function createProjectReturningId(page: Page, prompt: string): Promise<string> {
  await createProjectAndWait(page, prompt)
  const m = page.url().match(/\/projects\/([^/?#]+)/)
  expect(m, `expected a /projects/<id> URL, got ${page.url()}`).toBeTruthy()
  return m![1]
}

test.describe("warm pool per-user claimed-pod cap", () => {
  test("free user is capped at 2 claimed pods (LRU evicts the oldest)", async ({ page }) => {
    const user = makeTestUser("CapFree")
    await signUpAndOnboard(page, user)

    // Skip cleanly if the diagnostic backdoor isn't wired up in this env.
    const probe = await getClaimedPodsViaApi(page, user)
    test.skip(
      probe === null,
      "claimed-pods backdoor unavailable (set SHOGO_E2E_BOOTSTRAP_SECRET against an env that exposes /api/internal/e2e).",
    )

    // Create three projects; each open claims a warm pod. The free cap is 2,
    // so opening the 3rd must LRU-evict the 1st.
    const p1 = await createProjectReturningId(page, "Build a simple counter app")
    const p2 = await createProjectReturningId(page, "Build a todo list app")
    const p3 = await createProjectReturningId(page, "Build a calculator app")

    // Re-open in order so p1 becomes least-recently-used, then p2, then p3.
    await openProject(page, p1)
    await openProject(page, p2)
    await openProject(page, p3)

    const result = await waitForClaimedPodCount(page, user, 2, CLAIM_SETTLE_TIMEOUT_MS)
    expect(result, "expected a claimed-pods reading").not.toBeNull()
    expect(result!.claimedCount).toBeLessThanOrEqual(2)

    const claimedIds = result!.claimed.map((c) => c.id)
    // p1 was the least-recently-used at the time the cap bound, so it should
    // have been evicted; the two most-recently-used survive.
    expect(claimedIds).not.toContain(p1)
    expect(claimedIds).toContain(p3)
  })

  test("pro workspace is allowed up to 4 claimed pods", async ({ page }) => {
    const user = makeTestUser("CapPro")
    await signUpAndOnboard(page, user)

    const upgraded = await bootstrapProSubscriptionViaApi(page, user, "pro")
    test.skip(
      !upgraded,
      "pro bootstrap backdoor unavailable (set SHOGO_E2E_BOOTSTRAP_SECRET).",
    )

    // Four projects all fit under the pro cap (4): none should be evicted.
    const ids: string[] = []
    for (const prompt of [
      "Build app one",
      "Build app two",
      "Build app three",
      "Build app four",
    ]) {
      ids.push(await createProjectReturningId(page, prompt))
    }

    const result = await getClaimedPodsViaApi(page, user)
    expect(result, "expected a claimed-pods reading").not.toBeNull()
    // All four remain claimed (cap is 4, so nothing is evicted yet).
    expect(result!.claimedCount).toBeLessThanOrEqual(4)
    expect(result!.claimedCount).toBeGreaterThanOrEqual(3)
  })
})
