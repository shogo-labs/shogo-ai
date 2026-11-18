// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test, type Page } from "@playwright/test";

/**
 * SHO-406: the phone's full-screen canvas surface must never sit on
 * "Starting canvas…" forever.
 *
 * Before the fix `ProjectCanvasSurface` ran its own copy of the preview gate
 * that could only leave the spinner on `running && apiReady !== false` or a
 * `no-project` start reply: a 5xx status poll, a failed `/preview/start`, a
 * terminal `phase: "failed"` and a runtime that never resolved all spun
 * forever. It now shares the project screen's gate (`lib/preview-gate.ts` +
 * `lib/use-preview-phase.ts`).
 *
 * `/sandbox/url`, `/preview/status` and `/preview/start` are all fulfilled
 * locally, so the run asserts the surface's own behaviour without a live
 * runtime. `page.clock` skips the 60s base timeout.
 *
 * Run against a local session (signed in, one project to open):
 *
 *   E2E_PROJECT_ID=<project id> \
 *   E2E_TARGET_URL=http://localhost:8081 \
 *   npx playwright test --config e2e/mobile-ux/playwright.config.ts canvas-surface-gate
 */

const ORIGIN = process.env.E2E_TARGET_URL || "http://localhost:8081";

/** Point `/sandbox/url` at a same-origin fake agent-proxy so the surface gates. */
async function stubSandboxUrl(page: Page, projectId: string): Promise<void> {
  await page.route(`**/api/projects/${projectId}/sandbox/url`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ready: true,
        status: "running",
        agentUrl: `${ORIGIN}/api/projects/${projectId}/agent-proxy`,
        canvasBaseUrl: `${ORIGIN}/p/${projectId}`,
        url: `${ORIGIN}/p/${projectId}`,
      }),
    });
  });
}

async function openCanvasSurface(page: Page, projectId: string): Promise<void> {
  await page.goto(`/project-surface/${projectId}`);
  await page.waitForLoadState("domcontentloaded");
}

test("a 5xx status poll leaves the spinner for an error naming the status and a Retry", async ({
  page,
}) => {
  const projectId = process.env.E2E_PROJECT_ID;
  test.skip(!projectId, "Set E2E_PROJECT_ID to a project the session can open");

  await page.clock.install();
  await stubSandboxUrl(page, projectId!);
  await page.route("**/preview/status", async (route) => {
    await route.fulfill({ status: 502, contentType: "application/json", body: "{}" });
  });
  await page.route("**/preview/start", async (route) => {
    await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });

  await openCanvasSurface(page, projectId!);

  // It starts on the spinner — that part is fine, it just must not stay there.
  await expect(page.getByText("Starting canvas…")).toBeVisible({ timeout: 30_000 });

  // AC 1: past the base timeout the spinner is gone, the real status is named,
  // and there is a way out.
  await page.clock.fastForward(61_000);
  await expect(page.getByText("Starting canvas…")).toHaveCount(0);
  await expect(page.getByText("Connection timed out")).toBeVisible();
  await expect(page.getByText("HTTP 502", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  await page.screenshot({
    path: `test-results/sho406-status-502-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("a failing /preview/start is retried, then times out with a Retry that starts again", async ({
  page,
}) => {
  const projectId = process.env.E2E_PROJECT_ID;
  test.skip(!projectId, "Set E2E_PROJECT_ID to a project the session can open");

  let startCalls = 0;
  await page.clock.install();
  await stubSandboxUrl(page, projectId!);
  await page.route("**/preview/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ running: false, phase: "idle" }),
    });
  });
  await page.route("**/preview/start", async (route) => {
    startCalls += 1;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "runtime busy" }),
    });
  });

  await openCanvasSurface(page, projectId!);
  await expect(page.getByText("Starting canvas…")).toBeVisible({ timeout: 30_000 });

  // AC 2: the start is retried with backoff instead of being dropped.
  await page.clock.fastForward(61_000);
  await expect.poll(() => startCalls, { timeout: 15_000 }).toBeGreaterThan(1);

  await expect(page.getByText("Starting canvas…")).toHaveCount(0);
  await expect(page.getByText("Connection timed out")).toBeVisible();
  await expect(page.getByText("runtime busy", { exact: false })).toBeVisible();

  // ...and Retry POSTs /preview/start again.
  const before = startCalls;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => startCalls, { timeout: 15_000 }).toBeGreaterThan(before);

  await page.screenshot({
    path: `test-results/sho406-start-500-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("a running preview mounts the canvas webview", async ({ page }) => {
  const projectId = process.env.E2E_PROJECT_ID;
  test.skip(!projectId, "Set E2E_PROJECT_ID to a project the session can open");

  await page.clock.install();
  await stubSandboxUrl(page, projectId!);
  await page.route("**/preview/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ running: true, apiReady: true, phase: "ready" }),
    });
  });
  await page.route("**/preview/start", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await openCanvasSurface(page, projectId!);

  // AC 3: the gate opens and the canvas document is mounted.
  await expect(page.getByTestId("canvas-preview-iframe")).toBeAttached({ timeout: 30_000 });
  await expect(page.getByText("Starting canvas…")).toHaveCount(0);
});
