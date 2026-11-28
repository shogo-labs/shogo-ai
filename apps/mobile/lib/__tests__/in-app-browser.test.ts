// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Instagram / Facebook in-app browser detection and the Android escape hatch
 * (SHO-613). Google refuses its OAuth flow inside these webviews, so the sign-in
 * screen has to know where it is running.
 */
import { describe, expect, test, mock } from 'bun:test'

const platform = { OS: 'web' as string }
mock.module('react-native', () => ({ Platform: platform }))

const { IN_APP_BROWSER_USER_AGENT_MARKERS, androidChromeIntentUrl, detectInAppBrowser } =
  await import('../in-app-browser')

/** A real Instagram iOS webview. */
const IG_IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 312.0.0.34.114 (iPhone14,5; iOS 17_0; en_US; en; scale=3.00; 1170x2532; 561310147)'
/** A real Facebook in-app browser: FBAN/FBIOS token pair. */
const FB_IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/440.0.0.30.111;FBBV/543212345;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.0;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]'
const FB_ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/440.0.0.30.111;]'
/** Chrome on Android — a real browser, which Google will happily sign in to. */
const CHROME_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

describe('detectInAppBrowser', () => {
  test('recognises Instagram', () => {
    expect(detectInAppBrowser(IG_IOS_UA)).toBe('instagram')
  })

  test('recognises Facebook on iOS and Android', () => {
    expect(detectInAppBrowser(FB_IOS_UA)).toBe('facebook')
    expect(detectInAppBrowser(FB_ANDROID_UA)).toBe('facebook')
  })

  test('a normal browser is not an in-app browser', () => {
    expect(detectInAppBrowser(CHROME_UA)).toBeNull()
    expect(detectInAppBrowser(SAFARI_UA)).toBeNull()
  })

  test('no user agent is null, not a crash', () => {
    expect(detectInAppBrowser(undefined)).toBeNull()
    expect(detectInAppBrowser(null)).toBeNull()
    expect(detectInAppBrowser('')).toBeNull()
  })

  test('the native app is never treated as one', () => {
    platform.OS = 'ios'
    try {
      expect(detectInAppBrowser(IG_IOS_UA)).toBeNull()
    } finally {
      platform.OS = 'web'
    }
  })

  test('the markers are one exported list, so a new app is one entry', () => {
    expect(Object.keys(IN_APP_BROWSER_USER_AGENT_MARKERS).sort()).toEqual(['facebook', 'instagram'])
  })
})

describe('androidChromeIntentUrl', () => {
  test('targets Chrome and carries the page, query string included', () => {
    expect(
      androidChromeIntentUrl('https://studio.shogo.ai/sign-up?utm_source=ig&plan=pro'),
    ).toBe(
      'intent://studio.shogo.ai/sign-up?utm_source=ig&plan=pro#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' +
        encodeURIComponent('https://studio.shogo.ai/sign-up?utm_source=ig&plan=pro') +
        ';end',
    )
  })

  test('falls back to the same https URL when Chrome is not installed', () => {
    const intent = androidChromeIntentUrl('https://studio.shogo.ai/sign-in')
    const fallback = intent.split('S.browser_fallback_url=')[1]?.replace(/;end$/, '')
    expect(decodeURIComponent(fallback ?? '')).toBe('https://studio.shogo.ai/sign-in')
  })

  test('a root path still produces a valid intent', () => {
    expect(androidChromeIntentUrl('https://studio.shogo.ai/')).toContain(
      'intent://studio.shogo.ai/#Intent;scheme=https',
    )
  })
})
