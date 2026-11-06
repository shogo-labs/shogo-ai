// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test, type Page } from "@playwright/test";

/**
 * SHO-349: Settings → DATA → Disk shows a project's workspace drive — used vs
 * total while the project runs, the size in force, and a picker that raises it
 * up to the plan ceiling — and surfaces the route's own error copy when the
 * plan refuses.
 *
 * The two `/disk` responses are fulfilled locally, so the run asserts the
 * panel's own behaviour (AC 8) without a metal host or a plan upgrade: what the
 * real route returns is covered by the host e2e
 * (`apps/metal-agent/src/e2e-workspace-drive.ts`) and the API tests.
 *
 * Run against a local session (signed in, one project to open):
 *
 *   E2E_PROJECT_ID=<project id> \
 *   E2E_TARGET_URL=http://localhost:8081 \
 *   npx playwright test --config e2e/mobile-ux/playwright.config.ts project-disk-settings
 *
 * The config's projects are both phone-sized (390 × 844), so the screenshots
 * this writes are the 390 px proof AC 8 asks for.
 */

const GiB = 1024 ** 3;

const metalState = (over: Record<string, unknown> = {}) => ({
  requestedGiB: null,
  effectiveGiB: 20,
  defaultGiB: 20,
  maxGiB: 40,
  canIncrease: true,
  usage: { usedBytes: 12 * GiB, totalBytes: 20 * GiB, measuredAt: new Date().toISOString() },
  substrate: "metal",
  ...over,
});

/** Open the project's Settings tab and select the Disk section. */
async function openDiskPanel(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}?tab=settings`);
  await page.waitForLoadState("networkidle");
  const nav = page.getByTestId("n-disk");
  await expect(nav).toBeVisible({ timeout: 60_000 });
  await nav.click();
  await expect(page.getByText("Disk size", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
}

test("the disk panel shows usage, saves a bigger size, and shows the plan's error copy", async ({
  page,
}) => {
  const projectId = process.env.E2E_PROJECT_ID;
  test.skip(!projectId, "Set E2E_PROJECT_ID to a project the session can open");

  let putBody: unknown = null;
  await page.route(`**/api/projects/${projectId}/disk`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(metalState()),
      });
      return;
    }
    putBody = JSON.parse(route.request().postData() || "{}");
    // The plan refuses the size the panel asks for: the route answers 422 with
    // a readable message, and the panel must show that message verbatim rather
    // than a generic failure.
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "plan_ceiling",
          message: "This workspace's plan allows workspace disks up to 40 GiB.",
        },
      }),
    });
  });

  await openDiskPanel(page, projectId!);

  // AC 8: used vs total, from the guest's own statfs.
  await expect(page.getByText("12 GB of 20 GB").first()).toBeVisible();
  await expect(page.getByText("Usage appears while the project is running.")).toHaveCount(0);
  await expect(page.getByText("20 GiB now · up to 40 GiB").first()).toBeVisible();

  // Raise it one step (5 GiB) and save.
  await page.getByLabel("Bigger disk").click();
  await expect(page.getByText("25 GiB", { exact: true }).first()).toBeVisible();
  await page.getByText("Save disk size").click();

  await expect
    .poll(() => putBody, { timeout: 15_000 })
    .toEqual({ sizeGiB: 25 });
  await expect(
    page.getByText("This workspace's plan allows workspace disks up to 40 GiB."),
  ).toBeVisible();

  await page.screenshot({ path: `test-results/sho349-disk-phone-${test.info().project.name}.png`, fullPage: true });
});

test("a stopped project shows its size and says usage appears while it runs", async ({ page }) => {
  const projectId = process.env.E2E_PROJECT_ID;
  test.skip(!projectId, "Set E2E_PROJECT_ID to a project the session can open");

  await page.route(`**/api/projects/${projectId}/disk`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(metalState({ usage: null })),
    });
  });

  await openDiskPanel(page, projectId!);

  // AC 8: never wake a VM to measure it — the panel says so instead.
  await expect(page.getByText("Usage appears while the project is running.")).toBeVisible();
  await expect(page.getByText("20 GiB now · up to 40 GiB").first()).toBeVisible();

  await page.screenshot({ path: `test-results/sho349-disk-stopped-${test.info().project.name}.png`, fullPage: true });
});

test("on a machine that has no drive to grow, the panel is read-only", async ({ page }) => {
  const projectId = process.env.E2E_PROJECT_ID;
  test.skip(!projectId, "Set E2E_PROJECT_ID to a project the session can open");

  await page.route(`**/api/projects/${projectId}/disk`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        metalState({ substrate: "local", usage: null, maxGiB: 20, canIncrease: false, requestedGiB: null }),
      ),
    });
  });

  await openDiskPanel(page, projectId!);

  // No picker, and the reason: the project uses this machine's own disk.
  await expect(page.getByText("Save disk size")).toHaveCount(0);
  await expect(page.getByText("This project runs on your computer, so it uses your own disk.")).toBeVisible();
});
