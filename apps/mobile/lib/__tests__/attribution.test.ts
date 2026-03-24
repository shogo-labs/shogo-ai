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

const store = new Map<string, string>()

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  },
  writable: true,
  configurable: true,
})

Object.defineProperty(globalThis, 'document', {
  value: { referrer: '' },
  writable: true,
  configurable: true,
})

function setLocation(search: string, pathname = '/') {
  Object.defineProperty(globalThis, 'window', {
    value: {
      location: { search, pathname },
    },
    writable: true,
    configurable: true,
  })
}

const { captureAttribution, getStoredAttribution, clearStoredAttribution } =
  await import('../attribution')

beforeEach(() => {
  store.clear()
  ;(document as any).referrer = ''
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
    ;(document as any).referrer = 'https://www.google.com/'
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
    store.set('shogo_attribution', JSON.stringify({ utmSource: 'test' }))
    const data = getStoredAttribution()
    expect(data!.utmSource).toBe('test')
  })

  test('returns null on corrupt data', () => {
    store.set('shogo_attribution', 'not-json')
    expect(getStoredAttribution()).toBeNull()
  })
})

describe('clearStoredAttribution', () => {
  test('removes stored data', () => {
    store.set('shogo_attribution', '{}')
    store.set('shogo_landing_page', '/test')

    clearStoredAttribution()

    expect(store.has('shogo_attribution')).toBe(false)
    expect(store.has('shogo_landing_page')).toBe(false)
  })
})
