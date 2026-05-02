// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Client-side Attribution Tests
 *
 * Tests UTM capture, localStorage persistence, and first-visit-only behavior.
 *
 * Run: bun test apps/mobile/lib/__tests__/attribution.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

mock.module('react-native', () => ({
  Platform: { OS: 'web' },
}))

// `document.referrer` is a getter on happy-dom's `Document.prototype` —
// we stub the descriptor for the duration of these tests and restore it
// in `beforeEach` so we don't leak a polluted referrer into the rest of
// the suite.
const documentProto = Object.getPrototypeOf(document) as object
let referrerValue = ''
function setReferrer(value: string): void {
  referrerValue = value
}

Object.defineProperty(documentProto, 'referrer', {
  configurable: true,
  get: () => referrerValue,
})

function setLocation(search: string, pathname = '/'): void {
  // `window.location` is read-only on happy-dom; the supported mutation
  // seam is `window.history.replaceState`. The preload pins the origin
  // to `http://localhost/`, so a relative URL stays same-origin.
  window.history.replaceState({}, '', `${pathname}${search}`)
}

const { captureAttribution, getStoredAttribution, clearStoredAttribution } =
  await import('../attribution')

beforeEach(() => {
  localStorage.clear()
  setReferrer('')
  setLocation('')
})

describe('captureAttribution', () => {
  test('captures UTM params from URL', () => {
    setLocation('?utm_source=google&utm_medium=cpc&utm_campaign=spring')
    captureAttribution()

    const data = getStoredAttribution()
    expect(data).not.toBeNull()
    expect(data!.utmSource).toBe('google')
    expect(data!.utmMedium).toBe('cpc')
    expect(data!.utmCampaign).toBe('spring')
  })

  test('captures document.referrer', () => {
    setReferrer('https://www.google.com/')
    setLocation('')
    captureAttribution()

    const data = getStoredAttribution()
    expect(data!.referrer).toBe('https://www.google.com/')
  })

  test('captures landing page path', () => {
    setLocation('?utm_source=test', '/templates')
    captureAttribution()

    const data = getStoredAttribution()
    expect(data!.landingPage).toContain('/templates')
  })

  test('does not overwrite on second call (first-visit-only)', () => {
    setLocation('?utm_source=first')
    captureAttribution()

    setLocation('?utm_source=second')
    captureAttribution()

    const data = getStoredAttribution()
    expect(data!.utmSource).toBe('first')
  })

  test('stores even when no UTMs present', () => {
    setLocation('')
    captureAttribution()

    const data = getStoredAttribution()
    expect(data).not.toBeNull()
    expect(data!.utmSource).toBeUndefined()
  })
})

describe('getStoredAttribution', () => {
  test('returns null when nothing stored', () => {
    expect(getStoredAttribution()).toBeNull()
  })

  test('returns parsed data', () => {
    localStorage.setItem('shogo_attribution', JSON.stringify({ utmSource: 'test' }))
    const data = getStoredAttribution()
    expect(data!.utmSource).toBe('test')
  })

  test('returns null on corrupt data', () => {
    localStorage.setItem('shogo_attribution', 'not-json')
    expect(getStoredAttribution()).toBeNull()
  })
})

describe('clearStoredAttribution', () => {
  test('removes stored data', () => {
    localStorage.setItem('shogo_attribution', '{}')
    localStorage.setItem('shogo_landing_page', '/test')

    clearStoredAttribution()

    expect(localStorage.getItem('shogo_attribution')).toBeNull()
    expect(localStorage.getItem('shogo_landing_page')).toBeNull()
  })
})
