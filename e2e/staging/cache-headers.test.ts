// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect } from "@playwright/test"

/**
 * Cache-header smoke checks for a deployed Studio and published app.
 *
 * Configure the target-specific hashed asset paths when running against a
 * deployment:
 *
 *   E2E_TARGET_URL=https://studio.staging.shogo.ai \
 *   E2E_STUDIO_HASHED_ASSET_PATH=/_expo/static/js/web/entry-<hash>.js \
 *   E2E_PUBLISHED_URL=https://my-app.shogo.one \
 *   E2E_PUBLISHED_HASHED_ASSET_PATH=/assets/index-<hash>.js \
 *   bunx playwright test --config e2e/playwright.config.ts cache-headers
 */

const studioUrl = process.env.E2E_TARGET_URL || process.env.STAGING_URL
const publishedUrl = process.env.E2E_PUBLISHED_URL
const studioHashedAssetPath = process.env.E2E_STUDIO_HASHED_ASSET_PATH
const publishedHashedAssetPath = process.env.E2E_PUBLISHED_HASHED_ASSET_PATH

function header(response: { headers(): Record<string, string> }, name: string): string {
  return response.headers()[name.toLowerCase()] || ""
}

function expectNoCache(value: string): void {
  expect(value).toMatch(/no-cache/i)
  expect(value).toMatch(/must-revalidate/i)
}

function expectShortRevalidation(value: string): void {
  expect(value).toMatch(/max-age=300/i)
  expect(value).toMatch(/must-revalidate/i)
}

function expectImmutable(value: string): void {
  expect(value).toMatch(/max-age=31536000/i)
  expect(value).toMatch(/immutable/i)
}

test.describe("cache headers", () => {
  test("Studio revalidates the app shell and unhashed assets", async ({ request }) => {
    test.skip(!studioUrl, "set E2E_TARGET_URL or STAGING_URL")
    test.skip(!studioHashedAssetPath, "set E2E_STUDIO_HASHED_ASSET_PATH")

    const root = await request.get(`${studioUrl}/`)
    expectNoCache(header(root, "cache-control"))

    const favicon = await request.get(`${studioUrl}/favicon.ico`)
    expectShortRevalidation(header(favicon, "cache-control"))

    const hashed = await request.get(`${studioUrl}${studioHashedAssetPath}`)
    expectImmutable(header(hashed, "cache-control"))
  })

  test("republished app revalidates stable URLs and pins hashed assets", async ({ request }) => {
    test.skip(!publishedUrl, "set E2E_PUBLISHED_URL after republishing")
    test.skip(!publishedHashedAssetPath, "set E2E_PUBLISHED_HASHED_ASSET_PATH")

    const root = await request.get(`${publishedUrl}/`)
    expectNoCache(header(root, "cache-control"))

    const favicon = await request.get(`${publishedUrl}/favicon.ico`)
    expectShortRevalidation(header(favicon, "cache-control"))

    const hashed = await request.get(`${publishedUrl}${publishedHashedAssetPath}`)
    expectImmutable(header(hashed, "cache-control"))
  })
})
