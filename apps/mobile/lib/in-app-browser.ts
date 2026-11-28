// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Instagram / Facebook in-app browsers, and how to get out of one.
 *
 * Google refuses its OAuth flow inside an embedded webview: the visitor gets
 * `disallowed_useragent` and the "Continue with Google" button simply fails
 * (SHO-613). Almost all of our ad traffic arrives in exactly that webview, so
 * the auth screen has to notice where it is running and offer the two ways out
 * that actually work:
 *
 *   - Android: an `intent://` link that hands the page to Chrome (with a
 *     browser fallback if Chrome is missing);
 *   - iOS: there is no such deep link, so the person is told to use ••• →
 *     "Open in external browser".
 *
 * Detection is a user-agent test on web and always null on native: the app's own
 * iOS/Android build is not an in-app browser and its Google sheet works.
 */
import { Platform } from 'react-native'

export type InAppBrowserApp = 'instagram' | 'facebook'

/**
 * The UA markers of every embedded browser we treat specially. One exported
 * list so TikTok/LinkedIn can be added without touching the code that uses it.
 */
export const IN_APP_BROWSER_USER_AGENT_MARKERS: Record<InAppBrowserApp, readonly string[]> = {
  instagram: ['Instagram'],
  // `FBAN`/`FBAV` are the Facebook app on iOS and Android; `FB_IAB` is its
  // in-app-browser token on older builds.
  facebook: ['FBAN', 'FBAV', 'FB_IAB'],
}

/**
 * Which in-app browser this user agent belongs to, or null for a real browser
 * (and for every native build of the app).
 */
export function detectInAppBrowser(userAgent?: string | null): InAppBrowserApp | null {
  if (Platform.OS !== 'web') return null
  if (!userAgent) return null
  for (const [app, markers] of Object.entries(IN_APP_BROWSER_USER_AGENT_MARKERS) as Array<
    [InAppBrowserApp, readonly string[]]
  >) {
    if (markers.some((marker) => userAgent.includes(marker))) return app
  }
  return null
}

/** The web URL this page was opened at, or null off web. */
export function currentPageUrl(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  try {
    return window.location?.href ?? null
  } catch {
    return null
  }
}

/**
 * An Android `intent://` link that opens `httpsUrl` in Chrome.
 *
 * `S.browser_fallback_url` is the same https URL, so a device without Chrome
 * (or with a chrome-less work profile) still gets the page in whatever browser
 * it has instead of an "app not found" dead end.
 */
export function androidChromeIntentUrl(httpsUrl: string): string {
  const url = new URL(httpsUrl)
  const fallback = encodeURIComponent(url.toString())
  return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${fallback};end`
}
