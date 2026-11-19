// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Cometly pixel loads on the auth pages and nowhere else (SHO-441).
 *
 * `apps/mobile/lib/cometly.ts` injects the site tag; `app/(auth)/_layout.tsx`
 * is the only route group that asks for it, and `app/(app)/_layout.tsx` asks
 * for it on one further page — the first authenticated page of a brand-new
 * sign-up, which is the only place `custom_event_2` can be reported because
 * the tag is not on the app routes. A tag that loaded on `/` would double-count
 * every visit; a tag that never loaded on the post-signup page would drop the
 * conversion this card exists to record.
 *
 * The tag itself is stubbed: `js.comet-serve.com` is answered locally with a
 * script that exposes the two globals the app uses (`cometToken`, `comet`) and
 * records every event. Nothing leaves the browser, and no real Cometly call is
 * made.
 *
 * Needs the local stack (`E2E_LOCAL_START_STACK=1` starts it).
 */
import { expect, test, type Page } from "@playwright/test"

const COMETLY_SCRIPT = "js.comet-serve.com/script.js"

/** What the real tag exposes; here it just records. */
const STUB_TAG = `
window.__cometCalls = window.__cometCalls || [];
window.cometToken = function () { return 'tok_test'; };
window.comet = function (name) { window.__cometCalls.push(name); };
`

/** Requests to the tag, counted across the page's navigations. */
type Counter = { tagRequests: string[] }

async function installCometlyStub(page: Page, counter: Counter): Promise<void> {
  page.on("request", (request) => {
    if (request.url().includes(COMETLY_SCRIPT)) counter.tagRequests.push(request.url())
  })
  await page.route(`**/${COMETLY_SCRIPT}*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: STUB_TAG }),
  )
}

/** The app shell is up (either workspace, whichever the local stack lands on). */
async function waitForApp(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "App sidebar" })
    .or(page.getByText("What are we building", { exact: false }))
    .first()
    .waitFor({ state: "visible", timeout: 120_000 })
}

test.describe("Cometly pixel scope", () => {
  test("the auth page requests the site tag exactly once", async ({ page }) => {
    test.setTimeout(180_000)
    const counter: Counter = { tagRequests: [] }
    await installCometlyStub(page, counter)

    await page.goto("/sign-in")

    // Local mode redirects the auth group home, but the group's own effect has
    // already run by then — that is what puts the tag on the auth pages in
    // cloud mode, where the same group renders the form.
    await expect
      .poll(() => counter.tagRequests.length, { timeout: 60_000 })
      .toBe(1)
    expect(counter.tagRequests[0]).toContain("uid=4fb936-6755399446000006-d1965d8")
    expect(counter.tagRequests[0]).toContain("domains=shogo.ai,studio.shogo.ai")

    // The redirect lands on the app shell in the SAME document: whatever mounts
    // there must not add the tag (that is the double-count this card avoids).
    await waitForApp(page)
    await page.waitForTimeout(3_000)
    expect(counter.tagRequests).toHaveLength(1)

    // A second document load is a second page, so it gets its own single tag —
    // exactly one more, never two.
    await page.goto("/reset-password")
    await expect
      .poll(() => counter.tagRequests.length, { timeout: 60_000 })
      .toBe(2)
  })

  test("an app page loads no tag when there was no new sign-up", async ({ page }) => {
    test.setTimeout(180_000)
    const counter: Counter = { tagRequests: [] }
    await installCometlyStub(page, counter)
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("shogo_cometly_new_signup")
      } catch {}
    })

    await page.goto("/")
    await waitForApp(page)
    // Give a late injection time to show up before calling it absent.
    await page.waitForTimeout(3_000)

    expect(counter.tagRequests).toEqual([])
  })

  test("the first page after a new sign-up reports custom_event_2 once", async ({ page }) => {
    test.setTimeout(180_000)
    const counter: Counter = { tagRequests: [] }
    await installCometlyStub(page, counter)

    // A first load with no flag, so the effect has run once and consumed nothing.
    await page.goto("/")
    await waitForApp(page)
    expect(counter.tagRequests).toEqual([])

    // `markNewSignup()`'s flag, as the sign-up screen leaves it.
    await page.evaluate(() => localStorage.setItem("shogo_cometly_new_signup", String(Date.now())))
    await page.reload()
    await waitForApp(page)

    await expect
      .poll(() => page.evaluate(() => (window as any).__cometCalls ?? []), { timeout: 30_000 })
      .toContain("custom_event_2")
    expect(await page.evaluate(() => (window as any).__cometCalls)).toEqual(["custom_event_2"])
    // The flag is consumed, so it cannot fire again.
    expect(await page.evaluate(() => localStorage.getItem("shogo_cometly_new_signup"))).toBeNull()
    expect(counter.tagRequests).toHaveLength(1)

    // A second load of the same page: no flag, so no tag and no event.
    await page.reload()
    await waitForApp(page)
    await page.waitForTimeout(3_000)
    expect(counter.tagRequests).toHaveLength(1)
    expect(await page.evaluate(() => (window as any).__cometCalls ?? [])).toEqual([])
  })
})
