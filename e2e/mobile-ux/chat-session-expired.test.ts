// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test } from "@playwright/test";

/**
 * SHO-431: a send the API refuses for want of a session refreshes once, retries
 * the identical request once, and when the retry is refused too the person gets
 * a sign-in prompt with their message back in the composer — never the raw
 * `{"error":{"code":"unauthorized",…}}` envelope.
 *
 * The chat POST is intercepted here, which is the only way to produce a
 * mid-conversation 401 without deleting a real session: everything else (the
 * transport's `getSession({disableCookieCache:true})`, the one-shot replay, the
 * banner and the draft restore) is the app's own code.
 *
 * Run against a local session with a project it can open:
 *
 *   E2E_PROJECT_ID=<project id> \
 *   E2E_TARGET_URL=http://localhost:8081 \
 *   npx playwright test --config e2e/mobile-ux/playwright.config.ts chat-session-expired
 *
 * Both config projects are phone-sized (390 × 844), so this is the phone proof
 * as well.
 */

const UNAUTHORIZED = JSON.stringify({
  error: { code: "unauthorized", message: "Authentication required" },
});

/** The chat POST, on every URL shape `buildChatApiUrl` can produce. */
const CHAT_POST = /\/api\/(?:projects\/[^/]+\/|workspaces\/[^/]+\/)?chat$/;

test("a refused send asks for a sign-in and keeps the message", async ({ page }) => {
  const projectId = process.env.E2E_PROJECT_ID;
  test.skip(!projectId, "Set E2E_PROJECT_ID to a project the session can open");

  let attempts = 0;
  await page.route(CHAT_POST, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts += 1;
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: UNAUTHORIZED,
    });
  });

  await page.goto(`/projects/${projectId}`);
  const composer = page.getByTestId("project-composer-input");
  await expect(composer).toBeVisible({ timeout: 60_000 });

  const message = `qa-sho431-${Date.now()}`;
  await composer.fill(message);
  await composer.press("Enter");

  // The banner replaces the generic error: no envelope, no Retry, a sign-in.
  const banner = page.getByTestId("chat-error-banner");
  await expect(banner).toContainText("Your session has expired", { timeout: 30_000 });
  await expect(banner).toContainText("we kept your message");
  await expect(
    page.getByRole("button", { name: "Sign in again to continue this conversation" }),
  ).toBeVisible();
  await expect(page.getByText('"unauthorized"')).toHaveCount(0);

  // The retry is the transport's, and it happens exactly once.
  expect(attempts).toBe(2);

  // AC2: the text the person typed is back in the composer, once.
  await expect(composer).toHaveValue(message, { timeout: 15_000 });
});
