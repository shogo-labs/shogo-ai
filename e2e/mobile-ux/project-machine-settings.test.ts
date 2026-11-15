// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test, type Page } from "@playwright/test";

/**
 * Settings → DATA → Machine: pick a bigger machine, see the plan lock on sizes
 * the workspace can't have, then restart to apply. The `/machine` responses are
 * fulfilled locally so the run checks the panel's own behaviour without a metal
 * host; the route logic is covered by `apps/api/src/__tests__/project-machine.test.ts`.
 *
 *   E2E_PROJECT_ID=<project id> \
 *   E2E_TARGET_URL=http://localhost:8081 \
 *   npx playwright test --config e2e/mobile-ux/playwright.config.ts project-machine-settings
 *
 * The config's projects are phone-sized (390 × 844).
 */

const options = [
  { id: "standard", label: "Standard", vcpus: 2, memMiB: 4096, allowed: true, requiredTier: null },
  { id: "medium", label: "Medium", vcpus: 4, memMiB: 8192, allowed: true, requiredTier: "medium" },
  { id: "large", label: "Large", vcpus: 4, memMiB: 16384, allowed: false, requiredTier: "large" },
  { id: "xlarge", label: "XLarge", vcpus: 8, memMiB: 32768, allowed: false, requiredTier: "xlarge" },
];

const state = (current: (typeof options)[number], over: Record<string, unknown> = {}) => ({
  current: { id: current.id, label: current.label, vcpus: current.vcpus, memMiB: current.memMiB },
  options,
  instanceSize: "medium",
  substrate: "metal",
  running: true,
  canChange: true,
  canRestart: true,
  ...over,
});

async function openMachinePanel(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`);
  await page.waitForLoadState("networkidle");
  const settingsTab = page
    .getByTestId("project-tab-settings")
    .or(page.getByLabel("Settings", { exact: true }))
    .first();
  await expect(settingsTab).toBeVisible({ timeout: 60_000 });
  await settingsTab.click();
  const nav = page.getByTestId("settings-nav-machine").first();
  await expect(nav).toBeVisible({ timeout: 30_000 });
  await nav.click();
  await expect(page.getByText("Current size").first()).toBeVisible({ timeout: 30_000 });
}

test("the machine panel upgrades within the plan, locks bigger sizes, and restarts to apply", async ({ page }) => {
  const projectId = process.env.E2E_PROJECT_ID;
  test.skip(!projectId, "Set E2E_PROJECT_ID to a project the session can open");

  let current = options[0];
  let putBody: unknown = null;
  let restarts = 0;
  await page.route(`**/api/projects/${projectId}/machine`, async (route) => {
    if (route.request().method() === "PUT") {
      putBody = JSON.parse(route.request().postData() || "{}");
      current = options[1];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...state(current), restartRequired: true }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state(current)) });
  });
  await page.route(`**/api/projects/${projectId}/machine/restart`, async (route) => {
    restarts++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, restarted: true, message: "Restarting. The project is back in about a minute." }),
    });
  });

  await openMachinePanel(page, projectId!);
  await expect(page.getByText("Standard · 2 vCPU · 4 GB")).toBeVisible();
  await expect(page.getByText("Large plan")).toBeVisible();

  await page.getByRole("radio", { name: /Medium/ }).click();
  await page.getByText("Upgrade to Medium").click();
  await expect.poll(() => putBody).toEqual({ size: "medium" });
  await expect(page.getByText("Restart the project to switch to the new size", { exact: false })).toBeVisible();
  await page.screenshot({ path: "e2e/mobile-ux/screenshots/machine-settings-390.png", fullPage: true });

  await page.getByText("Restart to apply").click();
  await page.getByLabel("Confirm restart").click();
  await expect.poll(() => restarts).toBe(1);
  await expect(page.getByText("Restarting. The project is back in about a minute.")).toBeVisible();
});
