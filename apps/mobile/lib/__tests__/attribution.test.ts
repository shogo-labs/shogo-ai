// SPDX-License-Identifier: MIT
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

const {
  captureAttribution,
  getStoredAttribution,
  clearStoredAttribution,
  queueSignupAttribution,
  getPendingSignupAttribution,
  discardPendingSignupAttribution,
  shouldRecordSignupAttribution,
  flushSignupAttribution,
  attributionCookieDomain,
  writeAttributionCookie,
  readAttributionCookie,
  parseAttributionCookieValue,
  mergeFirstTouch,
  ensureFbcCookie,
  readCookie,
} = await import('../attribution')

function clearCookies(): void {
  for (const name of ['__shogo_utm', '_fbc', '_fbp']) {
    document.cookie = `${name}=; max-age=0; path=/`
    document.cookie = `${name}=; max-age=0; path=/; Domain=.shogo.ai`
  }
}

beforeEach(() => {
  localStorage.clear()
  clearCookies()
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

// ============================================================================
// SHO-611 — the cookie the signup POST actually carries
// ============================================================================

describe('captureAttribution click ids and the __shogo_utm cookie', () => {
  test('captures fbclid, gclid and ph_did from the studio link', () => {
    setLocation('?utm_source=meta&fbclid=IwARabc&gclid=Cj0KCQ&ph_did=ph_123')
    captureAttribution()

    const data = getStoredAttribution()!
    expect(data.utmSource).toBe('meta')
    expect(data.fbclid).toBe('IwARabc')
    expect(data.gclid).toBe('Cj0KCQ')
    expect(data.phDid).toBe('ph_123')
  })

  test('writes __shogo_utm as URL-encoded JSON in the shape the server parses', () => {
    setLocation('?utm_source=meta&utm_campaign=launch&fbclid=IwARabc&gclid=Cj0KCQ&ph_did=ph_123', '/pricing')
    captureAttribution()

    const raw = readCookie('__shogo_utm')
    expect(raw).not.toBeNull()
    const payload = JSON.parse(raw!)
    expect(payload).toMatchObject({
      utmSource: 'meta',
      utmCampaign: 'launch',
      fbclid: 'IwARabc',
      gclid: 'Cj0KCQ',
      phDid: 'ph_123',
      landingPage: '/pricing?utm_source=meta&utm_campaign=launch&fbclid=IwARabc&gclid=Cj0KCQ&ph_did=ph_123',
    })
    // No empty keys: the server treats "absent" and "empty" the same, and a
    // tight payload keeps the cookie small.
    expect(Object.values(payload).every((v) => typeof v === 'string' && v.length > 0)).toBe(true)
  })

  test('a cookie the website already set is never overwritten, only filled in', () => {
    writeAttributionCookie({ utmSource: 'website', utmMedium: 'paid' })
    setLocation('?utm_source=app&fbclid=IwARlater')
    captureAttribution()

    const cookie = readAttributionCookie()
    expect(cookie.utmSource).toBe('website')
    expect(cookie.utmMedium).toBe('paid')
    expect(cookie.fbclid).toBe('IwARlater')
  })

  test('sets _fbc from fbclid, and leaves an existing _fbc alone', () => {
    ensureFbcCookie('IwARfirst', 1_700_000_000_000)
    expect(readCookie('_fbc')).toBe('fb.1.1700000000000.IwARfirst')

    ensureFbcCookie('IwARsecond', 1_700_000_001_000)
    expect(readCookie('_fbc')).toBe('fb.1.1700000000000.IwARfirst')
  })

  test('a legacy query-string cookie is still readable', () => {
    expect(parseAttributionCookieValue('utm_source=old&fbclid=IwARold').fbclid).toBe('IwARold')
    expect(parseAttributionCookieValue('{not json')).toEqual({})
  })

  test('the cookie is only scoped to .shogo.ai, never to an arbitrary host', () => {
    expect(attributionCookieDomain('shogo.ai')).toBe('.shogo.ai')
    expect(attributionCookieDomain('studio.shogo.ai')).toBe('.shogo.ai')
    expect(attributionCookieDomain('localhost')).toBeUndefined()
    expect(attributionCookieDomain('someone-else.example')).toBeUndefined()
    expect(mergeFirstTouch({ utmSource: 'a' }, { utmSource: 'b', gclid: 'g' })).toEqual({
      utmSource: 'a',
      gclid: 'g',
    })
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

describe('queueSignupAttribution', () => {
  test('keeps captured UTMs and the signup method until the post succeeds', async () => {
    setLocation('?utm_source=google&utm_medium=cpc')
    captureAttribution()
    queueSignupAttribution('email')

    const pending = getPendingSignupAttribution()
    expect(pending!.method).toBe('email')
    expect(pending!.utmSource).toBe('google')
    expect(pending!.utmMedium).toBe('cpc')

    let posted: unknown = null
    const ok = await flushSignupAttribution(async (body) => {
      posted = body
    })
    expect(ok).toBe(true)
    expect(posted).toMatchObject({ method: 'email', utmSource: 'google' })
    expect(getPendingSignupAttribution()).toBeNull()
    expect(getStoredAttribution()).toBeNull()
  })

  test('leaves the queue in place when the post fails', async () => {
    queueSignupAttribution('google')
    await expect(flushSignupAttribution(async () => {
      throw new Error('unauthorized')
    })).rejects.toThrow('unauthorized')
    expect(getPendingSignupAttribution()!.method).toBe('google')
  })

  test('records email signups for a week, and oauth only for a fresh account', () => {
    const now = Date.parse('2026-10-10T00:00:00Z')
    const email = { method: 'email' as const, queuedAt: now - 6 * 24 * 60 * 60 * 1000 }
    expect(shouldRecordSignupAttribution(email, new Date(email.queuedAt), now)).toBe(true)
    expect(shouldRecordSignupAttribution(email, new Date(now - 8 * 24 * 60 * 60 * 1000), now)).toBe(false)

    const google = { method: 'google' as const, queuedAt: now - 60 * 1000 }
    expect(shouldRecordSignupAttribution(google, new Date(now - 30 * 1000), now)).toBe(true)
    expect(shouldRecordSignupAttribution(google, new Date(now - 30 * 60 * 1000), now)).toBe(false)
    expect(shouldRecordSignupAttribution(google, null, now)).toBe(false)
  })

  test('does not attribute a queued signup to a different account', () => {
    const now = Date.parse('2026-10-10T00:00:00Z')
    const pending = { method: 'email' as const, queuedAt: now - 60 * 1000 }
    expect(shouldRecordSignupAttribution(pending, new Date(now - 2 * 24 * 60 * 60 * 1000), now)).toBe(false)
    expect(shouldRecordSignupAttribution(pending, new Date(now - 2 * 60 * 60 * 1000), now)).toBe(false)
    expect(shouldRecordSignupAttribution(pending, new Date(now - 30 * 1000), now)).toBe(true)
  })

  test('posts once when two flushes overlap', async () => {
    queueSignupAttribution('email')
    let posts = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = flushSignupAttribution(async () => {
      posts += 1
      await gate
    })
    const second = flushSignupAttribution(async () => {
      posts += 1
      await gate
    })
    release()
    await Promise.all([first, second])
    expect(posts).toBe(1)
    expect(getPendingSignupAttribution()).toBeNull()
  })
})
