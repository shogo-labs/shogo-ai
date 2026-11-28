// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Catching the marketing site's sign-up intent (SHO-614) in the browser.
 *
 * `Platform.OS` is a mutable object so the file also proves the capture is
 * web-only: the app runs on iOS/Android too, and those must never touch
 * `document` or read a stale localStorage entry.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const platform = { OS: 'web' as string }
mock.module('react-native', () => ({ Platform: platform }))

const {
  SIGNUP_INTENT_COOKIE,
  SIGNUP_INTENT_STORAGE_KEY,
  SIGNUP_INTENT_MAX_AGE_MS,
  PENDING_TEMPLATE_KEY,
  captureSignupIntent,
  clearSignupIntent,
  getSignupIntent,
} = await import('../signup-intent')

function goTo(pathAndQuery: string): void {
  window.history.replaceState({}, '', pathAndQuery)
}

function clearCookies(): void {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim()
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`
  }
}

function intentCookie(): string | null {
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SIGNUP_INTENT_COOKIE) return decodeURIComponent(rest.join('=')) || null
  }
  return null
}

beforeEach(() => {
  platform.OS = 'web'
  window.localStorage.clear()
  clearCookies()
  goTo('/')
})

afterEach(() => {
  goTo('/')
})

describe('captureSignupIntent', () => {
  test('stores the hero link in localStorage and in the cookie, then strips it from the URL', () => {
    goTo('/sign-up?mode=signup&prompt=A+booking+page+for+my+salon&intent=hero_prompt&utm_source=x')

    const intent = captureSignupIntent()

    expect(intent).toEqual({ prompt: 'A booking page for my salon', intent: 'hero_prompt' })
    // The browser copy, stamped so it can expire.
    const stored = JSON.parse(window.localStorage.getItem(SIGNUP_INTENT_STORAGE_KEY)!)
    expect(stored.prompt).toBe('A booking page for my salon')
    expect(typeof stored.capturedAt).toBe('number')
    // The server copy, for verifying on another device.
    expect(JSON.parse(intentCookie()!)).toEqual({
      prompt: 'A booking page for my salon',
      intent: 'hero_prompt',
    })
    // Params the other cards own survive; ours are consumed.
    expect(window.location.search).toBe('?mode=signup&utm_source=x')
  })

  test('keeps the old template slots working alongside the new intent', () => {
    goTo('/sign-up?template=invoice-generator&app_template=finance')
    captureSignupIntent()
    expect(window.localStorage.getItem(PENDING_TEMPLATE_KEY)).toBe('invoice-generator')
    expect(window.localStorage.getItem('pending_app_template')).toBe('finance')
    expect(getSignupIntent()).toMatchObject({ template: 'invoice-generator' })
  })

  test('reads a pricing link', () => {
    goTo('/sign-up?plan=business&trial=1')
    expect(captureSignupIntent()).toEqual({ plan: 'business', trial: true })
    expect(window.location.search).toBe('')
  })

  test('does nothing without a valid intent', () => {
    goTo('/sign-up?mode=signup&utm_campaign=launch')
    expect(captureSignupIntent()).toBeNull()
    expect(window.localStorage.getItem(SIGNUP_INTENT_STORAGE_KEY)).toBeNull()
    expect(intentCookie()).toBeNull()
  })

  test('is idle on native', () => {
    platform.OS = 'ios'
    goTo('/sign-up?prompt=A+booking+page')
    expect(captureSignupIntent()).toBeNull()
    expect(window.localStorage.getItem(SIGNUP_INTENT_STORAGE_KEY)).toBeNull()
  })
})

describe('getSignupIntent', () => {
  test('returns the captured intent for a week', () => {
    goTo('/?prompt=A+job+tracker+for+my+crew')
    const capturedAt = captureSignupIntent()
    expect(capturedAt).not.toBeNull()
    expect(getSignupIntent()).toMatchObject({ prompt: 'A job tracker for my crew' })
  })

  test('drops an entry older than the cookie', () => {
    goTo('/?prompt=A+job+tracker')
    captureSignupIntent()
    expect(getSignupIntent(Date.now() + SIGNUP_INTENT_MAX_AGE_MS + 1000)).toBeNull()
    expect(window.localStorage.getItem(SIGNUP_INTENT_STORAGE_KEY)).toBeNull()
  })

  test('drops garbage instead of throwing', () => {
    window.localStorage.setItem(SIGNUP_INTENT_STORAGE_KEY, '{not json')
    expect(getSignupIntent()).toBeNull()
    expect(window.localStorage.getItem(SIGNUP_INTENT_STORAGE_KEY)).toBeNull()
  })
})

describe('clearSignupIntent', () => {
  test('removes both copies once the first build has started', () => {
    goTo('/?prompt=A+client+intake+form')
    captureSignupIntent()
    clearSignupIntent()
    expect(window.localStorage.getItem(SIGNUP_INTENT_STORAGE_KEY)).toBeNull()
    expect(intentCookie()).toBeNull()
  })
})

