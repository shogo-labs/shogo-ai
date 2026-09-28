// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { expect, test } from "@playwright/test";

/**
 * Run this against a local session with image generation enabled:
 *
 *   E2E_IMAGE_GENERATION_PROMPT="..." \
 *   npx playwright test --config e2e/mobile-ux/playwright.config.ts
 *
 * The prompt should ask the agent to create three candidates, so the test
 * exercises the gallery rather than only the single-image path. The download
 * route is fulfilled locally so the test is deterministic after the tool
 * result arrives and never depends on an object-store image.
 */
test("generated image gallery is usable at phone width", async ({ page }) => {
  const prompt = process.env.E2E_IMAGE_GENERATION_PROMPT;
  test.skip(
    !prompt,
    "Set E2E_IMAGE_GENERATION_PROMPT to run the live image fixture",
  );

  await page.route("**/agent/workspace/download/**", async (route) => {
    // A tiny valid PNG keeps the test focused on layout and interactions.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await route.fulfill({ status: 200, contentType: "image/png", body: png });
  });

  await page.goto("/(app)");
  const composer = page
    .getByTestId("project-composer-input")
    .or(page.getByTestId("home-composer-input"))
    .or(page.getByRole("textbox", { name: /ask shogo|message/i }))
    .first();
  await expect(composer).toBeVisible();
  await composer.fill(prompt!);
  await composer.press("Enter");

  const image = page.getByTestId("generated-image-card").first();
  await expect(image).toBeVisible({ timeout: 120_000 });
  const before = await image.boundingBox();
  expect(before?.width).toBeGreaterThan(220);
  await expect(page.getByTestId("generated-image-gallery")).toBeVisible();
  await expect(page.getByTestId("generated-image-card")).toHaveCount(3);

  await page.screenshot({
    path: "test-results/generated-image-gallery.png",
    fullPage: true,
  });
  await image.click();
  await expect(page.getByRole("button", { name: /save image/i })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /share image/i }),
  ).toBeVisible();
});
