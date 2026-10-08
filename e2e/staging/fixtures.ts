// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test as base, type Browser, type BrowserContext } from "@playwright/test"

export * from "@playwright/test"

/**
 * Staging e2e `test` with the API rate-limit bypass built in.
 *
 * The hosted suite runs 8 workers from a single CI runner IP, and the API
 * rate-limits per IP (600 req/min globally, 60 req/min on `/api/auth/*`). When
 * the limiter returns 429 the app can't resolve its session and treats the test
 * user as signed out, which showed up as a different "flaky" failure in almost
 * every spec. The limiter skips requests carrying `x-load-test-key` equal to the
 * server's `LOAD_TEST_SECRET`, so every browser context created through this
 * `test` adds that header to same-origin `/api/*` requests.
 *
 * - No `LOAD_TEST_SECRET` in the environment (local runs, production) means no
 *   change in behavior.
 * - The header is only added for the target origin's `/api/` paths, so it never
 *   reaches Stripe, Google, or preview subdomains.
 *
 * Specs import `test`/`expect` from here instead of `@playwright/test`.
 */

const BYPASS_KEY = process.env.LOAD_TEST_SECRET

async function bypassRateLimit(context: BrowserContext, baseURL: string | undefined): Promise<void> {
  if (!BYPASS_KEY || !baseURL) return
  const origin = new URL(baseURL).origin
  await context.route(
    (url) => url.origin === origin && url.pathname.startsWith("/api/"),
    (route) =>
      route.continue({
        headers: { ...route.request().headers(), "x-load-test-key": BYPASS_KEY },
      }),
  )
}

/**
 * `browser.newPage()` (used by most specs' `beforeAll`) and the built-in
 * `context` fixture both go through `browser.newContext()`, so patching that one
 * method covers every context a spec can create.
 */
function patchNewContext(browser: Browser, baseURL: string | undefined): () => void {
  const original = browser.newContext.bind(browser)
  browser.newContext = (async (...args: Parameters<Browser["newContext"]>) => {
    const context = await original(...args)
    await bypassRateLimit(context, args[0]?.baseURL ?? baseURL)
    return context
  }) as Browser["newContext"]
  return () => {
    browser.newContext = original as Browser["newContext"]
  }
}

export const test = base.extend<object, { browser: Browser }>({
  browser: [
    async ({ browser }, use, workerInfo) => {
      const restore = BYPASS_KEY ? patchNewContext(browser, workerInfo.project.use.baseURL) : () => {}
      try {
        await use(browser)
      } finally {
        restore()
      }
    },
    { scope: "worker" },
  ],
})
