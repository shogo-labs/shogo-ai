// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test } from "@playwright/test";

/**
 * SHO-304: the Publish dropdown must not render the DNS panel. It shows one
 * "Custom domain" row with a one-line status, and tapping it opens
 * Settings → Publishing → Custom domain.
 *
 * The publish + domain API responses are fulfilled locally so the run is
 * deterministic and never depends on a deployed Cloudflare custom hostname.
 *
 * Run against a local session (signed in, one project to open):
 *
 *   E2E_PROJECT_ID=<project id> \
 *   E2E_TARGET_URL=http://localhost:8081 \
 *   npx playwright test --config e2e/mobile-ux/playwright.config.ts custom-domain-settings-jump
 */
test("publish dropdown links to Settings → Custom domain, without records", async ({ page }) => {
  const projectId = process.env.E2E_PROJECT_ID;
  test.skip(!projectId, "Set E2E_PROJECT_ID to a project the session can open");

  await page.route(`**/api/projects/${projectId}/publish`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        subdomain: "example-site",
        publishedAt: Date.now(),
        accessLevel: "anyone",
        hasPassword: false,
        serverBacked: false,
        canPublish: true,
        publishDomain: "shogo.one",
      }),
    });
  });

  await page.route(`**/api/projects/${projectId}/domains`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        fallbackOrigin: "fallback.shogo.one",
        domains: [
          {
            id: "d1",
            hostname: "example.com",
            status: "active",
            stage: "active",
            primary: true,
            canonicalHostname: "example.com",
            instructions: [
              { type: "CNAME", name: "example.com", value: "fallback.shogo.one", purpose: "routing" },
              { type: "TXT", name: "_acme-challenge.example.com", value: "dcv-token", purpose: "ssl-validation" },
            ],
          },
        ],
      }),
    });
  });

  await page.goto(`/projects/${projectId}`);
  await page.waitForLoadState("networkidle");

  const trigger = page.getByTestId("publish-trigger");
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();

  // One row, one line of status — never DNS records inside the popover.
  const row = page.getByTestId("publish-custom-domain-row");
  await expect(row).toBeVisible();
  await expect(row).toContainText("Custom domain");
  await expect(row).toContainText("example.com · Live");
  await expect(page.getByText("_acme-challenge.example.com")).toHaveCount(0);
  await expect(page.getByText("fallback.shogo.one")).toHaveCount(0);

  await row.click();

  // Settings opens with Custom domain selected.
  await expect(page.getByTestId("settings-nav-custom-domains")).toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: 15_000 },
  );
});
