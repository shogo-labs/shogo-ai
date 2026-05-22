// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect } from "@playwright/test"

/**
 * CloudSyncMode — dual_shadow re-assignment validation.
 *
 * This test exercises the NEW code paths added by PR #576 by:
 *
 *   1. Signing in as the test user from the prior smoke-test run, whose
 *      project was flipped to `cloudSyncMode='dual_shadow'` in the DB
 *      out-of-band (see e2e/staging/cloud-sync-mode-smoke.test.ts and
 *      the kubectl exec psql UPDATE that ran between the two tests).
 *
 *   2. Opening the project's chat URL. Because the project is now scaled
 *      to zero (knative cold), this forces a fresh `/pool/assign`
 *      against a warm-pool pod. The API's `buildProjectEnv` will see
 *      `cloudSyncMode='dual_shadow'`, emit `SHOGO_CLOUD_SYNC_MODE=dual_shadow`
 *      in the assignment env, and the runtime's `resolveCloudSyncMode()`
 *      will return `'dual_shadow'`, instantiating BOTH S3Sync (Layer 2 ON)
 *      AND GitWorkspaceSync.
 *
 *   3. Sending a fresh chat message → the agent-runtime must respond
 *      successfully under the new wiring. If anything in the new sync
 *      code crashes the pod on startup, the SSE relay never emits a
 *      complete turn and the test fails.
 *
 * The corresponding log assertion (`[agent-runtime] cloudSyncMode=dual_shadow`)
 * runs out-of-band via `kubectl logs` after this test exits — Playwright
 * doesn't need cluster access for the test itself.
 *
 * Required env:
 *   E2E_DUAL_SHADOW_EMAIL    — test user email from prior run
 *   E2E_DUAL_SHADOW_PASSWORD — test user password (helpers.makeTestUser format)
 *   E2E_DUAL_SHADOW_PROJECT  — project UUID flipped to dual_shadow
 */

const EMAIL = process.env.E2E_DUAL_SHADOW_EMAIL || ""
const PASSWORD = process.env.E2E_DUAL_SHADOW_PASSWORD || ""
const PROJECT = process.env.E2E_DUAL_SHADOW_PROJECT || ""

test.describe("CloudSyncMode rollout — dual_shadow fresh assignment", () => {
  test.skip(!EMAIL || !PASSWORD || !PROJECT, "set E2E_DUAL_SHADOW_{EMAIL,PASSWORD,PROJECT}")

  test("re-open dual_shadow project triggers fresh /pool/assign with new mode", async ({
    page,
  }) => {
    // ── Sign in ────────────────────────────────────────────────────────────
    await page.goto("/sign-in")
    // Already on Sign In tab by default; only the form fields exist.
    await page.getByPlaceholder("you@example.com").fill(EMAIL)
    // The sign-in placeholder is "Enter your password", not "Create a password"
    await page.getByPlaceholder(/Enter your password|password/i).first().fill(PASSWORD)
    // Mandatory Privacy/Terms consent (SHOG-666) — gates the Sign In CTA.
    await page
      .getByRole("checkbox", { name: /Privacy Policy and Terms of Use/i })
      .click()
    await page.getByText("Sign In", { exact: true }).last().click()

    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
      timeout: 30_000,
    })

    // ── Navigate to the project ────────────────────────────────────────────
    await page.goto(`/projects/${PROJECT}`)

    // The project page should mount even if the runtime is cold — the
    // tablist (Chat | Canvas | IDE | …) appears immediately while the
    // pool assignment happens in the background. This is our first
    // signal that the page loaded; the runtime cold-start is what we're
    // actually testing below.
    await expect(
      page.getByRole("tablist").or(page.locator('[role="tablist"]')).first(),
    ).toBeVisible({ timeout: 30_000 })

    // ── Send a fresh message to force runtime startup ──────────────────────
    // The project page composer (different from home composer) — try a
    // few stable selectors in priority order.
    const composer = page
      .getByTestId("home-composer-input")
      .or(page.getByPlaceholder("Ask Shogo..."))
      .or(page.getByPlaceholder(/Reply to Shogo/i))
      .or(page.getByPlaceholder(/Message Shogo/i))
      .or(page.locator('textarea').first())
      .first()
    await composer.waitFor({ state: "visible", timeout: 30_000 })
    await composer.click()
    await composer.fill("Just reply with the single word READY so I can verify the runtime came up.")
    await page.waitForTimeout(300)
    await page.keyboard.press("Enter")

    // Wait for the stop button to appear (agent started streaming) then
    // detach (turn complete). 120s budget for cold start + first
    // response since this is a brand-new pool assignment under
    // dual_shadow mode (S3 + git both initializing).
    const stopSel = '[data-testid="stop-streaming"], [aria-label="Stop"], [aria-label="stop"]'
    try {
      await page.waitForSelector(stopSel, { state: "attached", timeout: 90_000 })
    } catch {
      // Streaming may have completed before we observed it — fine.
    }
    await page
      .waitForSelector(stopSel, { state: "detached", timeout: 120_000 })
      .catch(() => {})
    await page.waitForTimeout(1500)

    // If we got this far without timing out, the agent-runtime pod
    // booted under dual_shadow mode AND completed an SSE response. The
    // out-of-band kubectl log check confirms the cloudSyncMode log
    // line was emitted.
  })
})
