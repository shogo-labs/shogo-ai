// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test, type Page } from "@playwright/test";

/**
 * SHO-613: the sign-up front door for Instagram/Facebook ad traffic.
 *
 * Three things this proves, all on the real auth screen:
 *
 *   1. `/sign-up` opens the **Sign Up** tab on a device that has never been
 *      signed in, and every ad param (`utm_source`, `plan`, `prompt`) is still
 *      in the URL, plus `mode=signup`.
 *   2. A device that *has* had a session opens Sign In, `?mode=signin` wins on
 *      a fresh device, and switching tabs rewrites `mode` only.
 *   3. In an Instagram or Facebook webview there is no "Continue with Google"
 *      button (it cannot work there) and the open-in-browser block is shown
 *      instead; a normal Chrome/Safari user agent still gets Google.
 *
 * Run it against a signed-out web target:
 *
 *   E2E_TARGET_URL=http://localhost:8081 \
 *   npx playwright test --config e2e/mobile-ux/playwright.config.ts auth-signup-front-door
 *
 * The specs skip rather than fail when the target is already signed in: the
 * auth screen is not reachable then, and that is not this card's regression.
 */

const HAD_SESSION_KEY = "auth-had-session-v1";

const IG_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 312.0.0.34.111 (iPhone15,2; iOS 17_0; en_US; en; scale=3.00; 1179x2556; 526369589) NW/3";

const FB_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/440.0.0.31.115;FBBV/512345678;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.0;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]";

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SIGNUP_TAB = { name: "Sign up" } as const;
const SIGNIN_TAB = { name: "Log in" } as const;

/** The open-in-browser block that replaces Google inside a webview. */
const IN_APP_NOTICE = "Open in your browser to continue with Google";
const GOOGLE_BUTTON = "Continue with Google";

/**
 * Wait for the auth screen. Returns false when the target is signed in, so the
 * caller can skip instead of failing on a screen that is not supposed to be
 * there.
 */
async function openAuthScreen(page: Page, path: string): Promise<boolean> {
  await page.goto(path);
  const tabs = page.getByRole("tab");
  await expect(tabs.first()).toBeVisible({ timeout: 60_000 }).catch(() => undefined);
  return (await tabs.count()) > 0;
}

function rememberSession(page: Page): Promise<void> {
  return page.addInitScript(
    ([key]) => {
      try {
        window.localStorage.setItem(key, "1");
      } catch {
        /* storage blocked — the run then behaves like a fresh device */
      }
    },
    [HAD_SESSION_KEY],
  );
}

test.describe("the ad landing tab", () => {
  test("a fresh device on /sign-up sees Sign Up and keeps every param", async ({ page }) => {
    test.skip(!(await openAuthScreen(page, "/sign-up?utm_source=ig&plan=pro&prompt=hi")), "target is signed in");

    await expect(page.getByRole("tab", SIGNUP_TAB)).toHaveAttribute("aria-selected", "true");

    const url = new URL(page.url());
    expect(url.searchParams.get("utm_source")).toBe("ig");
    expect(url.searchParams.get("plan")).toBe("pro");
    expect(url.searchParams.get("prompt")).toBe("hi");
    expect(url.searchParams.get("mode")).toBe("signup");
  });

  test("switching tabs changes mode and nothing else", async ({ page }) => {
    test.skip(!(await openAuthScreen(page, "/sign-in?utm_source=ig&plan=pro&prompt=hi")), "target is signed in");

    await page.getByRole("tab", SIGNIN_TAB).click();
    await expect(page.getByRole("tab", SIGNIN_TAB)).toHaveAttribute("aria-selected", "true");

    const url = new URL(page.url());
    expect(url.searchParams.get("mode")).toBe("signin");
    expect(url.searchParams.get("utm_source")).toBe("ig");
    expect(url.searchParams.get("plan")).toBe("pro");
    expect(url.searchParams.get("prompt")).toBe("hi");
  });

  test("a device that has signed in before gets Sign In", async ({ page }) => {
    await rememberSession(page);
    test.skip(!(await openAuthScreen(page, "/sign-in")), "target is signed in");

    await expect(page.getByRole("tab", SIGNIN_TAB)).toHaveAttribute("aria-selected", "true");
  });

  test("?mode=signin wins on a fresh device", async ({ page }) => {
    test.skip(!(await openAuthScreen(page, "/sign-in?mode=signin")), "target is signed in");

    await expect(page.getByRole("tab", SIGNIN_TAB)).toHaveAttribute("aria-selected", "true");
  });

  test("?mode=signup wins on a device that has signed in before", async ({ page }) => {
    await rememberSession(page);
    test.skip(!(await openAuthScreen(page, "/sign-in?mode=signup")), "target is signed in");

    await expect(page.getByRole("tab", SIGNUP_TAB)).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("Google inside an Instagram webview", () => {
  test.use({ userAgent: IG_UA });

  test("offers the open-in-browser route instead of Google", async ({ page }) => {
    test.skip(!(await openAuthScreen(page, "/sign-up?utm_source=ig&plan=pro")), "target is signed in");

    await expect(page.getByText(IN_APP_NOTICE)).toBeVisible();
    await expect(page.getByLabel(GOOGLE_BUTTON)).toHaveCount(0);
    // Android gets the intent button, iOS the copy-link one; either satisfies it.
    await expect(page.getByLabel("Open in browser").or(page.getByLabel("Copy link")).first()).toBeVisible();
  });
});

test.describe("Google inside a Facebook webview", () => {
  test.use({ userAgent: FB_UA });

  test("offers the open-in-browser route instead of Google", async ({ page }) => {
    test.skip(!(await openAuthScreen(page, "/sign-up?utm_source=ig&plan=pro")), "target is signed in");

    await expect(page.getByText(IN_APP_NOTICE)).toBeVisible();
    await expect(page.getByLabel(GOOGLE_BUTTON)).toHaveCount(0);
  });
});

test.describe("Google in a normal browser", () => {
  test.use({ userAgent: CHROME_UA });

  test("keeps the Google button and shows no webview notice", async ({ page }) => {
    test.skip(!(await openAuthScreen(page, "/sign-up")), "target is signed in");

    await expect(page.getByLabel(GOOGLE_BUTTON)).toBeVisible();
    await expect(page.getByText(IN_APP_NOTICE)).toHaveCount(0);
  });
});
