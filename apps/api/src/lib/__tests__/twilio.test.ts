// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
  DEFAULT_TWILIO_BASE_URL,
  TwilioApiError,
  TwilioClient,
  resolveShogoTwilioClient,
  verifyTwilioSignature,
} from '../twilio'

interface RecordedCall {
  url: string
  init: RequestInit | undefined
}

function makeFetchStub(responses: Array<{ status?: number; body?: any; bodyText?: string }>) {
  const calls: RecordedCall[] = []
  let i = 0
  const fn: typeof fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    const status = r.status ?? 200
    const ok = status >= 200 && status < 300
    const text = r.bodyText ?? JSON.stringify(r.body ?? {})
    return {
      ok,
      status,
      text: async () => text,
      json: async () => (r.bodyText ? JSON.parse(r.bodyText) : r.body ?? {}),
      headers: new Headers(),
    } as any
  }) as any
  return { fn, calls }
}

const SAVED_ENV = { ...process.env }
beforeEach(() => { /* noop */ })
afterEach(() => { process.env = { ...SAVED_ENV } })

describe('TwilioClient — constructor', () => {
  it('throws when accountSid is missing', () => {
    expect(() => new TwilioClient({ accountSid: '', authToken: 't' } as any)).toThrow(/accountSid/)
  })
  it('throws when authToken is missing', () => {
    expect(() => new TwilioClient({ accountSid: 'a', authToken: '' } as any)).toThrow(/authToken/)
  })
  it('throws when global fetch is unavailable and none supplied', () => {
    const origFetch = globalThis.fetch
    ;(globalThis as any).fetch = undefined
    try {
      expect(() => new TwilioClient({ accountSid: 'a', authToken: 't' })).toThrow(/fetch/)
    } finally {
      ;(globalThis as any).fetch = origFetch
    }
  })
  it('strips trailing slashes from baseUrl', async () => {
    const { fn } = makeFetchStub([{ body: { available_phone_numbers: [] } }])
    const c = new TwilioClient({ accountSid: 'ACx', authToken: 'tok', baseUrl: 'https://example.com///', fetch: fn })
    await c.searchAvailable()
    expect(DEFAULT_TWILIO_BASE_URL).toBe('https://api.twilio.com')
    expect((c as any).baseUrl).toBe('https://example.com')
  })
})

describe('TwilioClient.searchAvailable', () => {
  it('builds the URL with defaults (US, PageSize=10) and returns mapped numbers', async () => {
    const { fn, calls } = makeFetchStub([
      {
        body: {
          available_phone_numbers: [
            { phone_number: '+15551112222', friendly_name: 'A', region: 'CA', locality: 'LA', iso_country: 'US' },
            { phone_number: '+15553334444' },
          ],
        },
      },
    ])
    const c = new TwilioClient({ accountSid: 'ACx', authToken: 'tok', fetch: fn })
    const r = await c.searchAvailable()
    expect(r).toHaveLength(2)
    expect(r[0]).toEqual({
      phoneNumber: '+15551112222',
      friendlyName: 'A',
      region: 'CA',
      locality: 'LA',
      isoCountry: 'US',
    })
    expect(r[1].friendlyName).toBe('+15553334444')
    const url = calls[0].url
    expect(url).toContain('/AvailablePhoneNumbers/US/Local.json')
    expect(url).toContain('PageSize=10')
    expect(url).not.toContain('AreaCode=')
  })
  it('forwards areaCode, contains, limit, and uppercases country', async () => {
    const { fn, calls } = makeFetchStub([{ body: { available_phone_numbers: [] } }])
    const c = new TwilioClient({ accountSid: 'ACx', authToken: 'tok', fetch: fn })
    await c.searchAvailable({ country: 'ca', areaCode: '415', contains: 'SHOGO', limit: 25 })
    expect(calls[0].url).toContain('/AvailablePhoneNumbers/CA/Local.json')
    expect(calls[0].url).toContain('AreaCode=415')
    expect(calls[0].url).toContain('Contains=SHOGO')
    expect(calls[0].url).toContain('PageSize=25')
  })
  it('returns [] when available_phone_numbers is absent', async () => {
    const { fn } = makeFetchStub([{ body: {} }])
    const c = new TwilioClient({ accountSid: 'ACx', authToken: 'tok', fetch: fn })
    expect(await c.searchAvailable()).toEqual([])
  })
  it('throws TwilioApiError on non-2xx', async () => {
    const { fn } = makeFetchStub([{ status: 503, bodyText: 'down' }])
    const c = new TwilioClient({ accountSid: 'ACx', authToken: 'tok', fetch: fn })
    let err: any
    await c.searchAvailable().catch((e) => { err = e })
    expect(err).toBeInstanceOf(TwilioApiError)
    expect(err.status).toBe(503)
    expect(err.body).toBe('down')
    expect(err.message).toContain('503')
    expect(err.name).toBe('TwilioApiError')
  })
})

describe('TwilioClient.purchaseNumber', () => {
  it('posts with required fields and returns mapped result', async () => {
    const { fn, calls } = makeFetchStub([
      { body: { sid: 'PNabc', phone_number: '+15550000', friendly_name: 'fn', voice_url: 'v', status_callback: 's' } },
    ])
    const c = new TwilioClient({ accountSid: 'ACx', authToken: 'tok', fetch: fn })
    const r = await c.purchaseNumber({ phoneNumber: '+15550000' })
    expect(r).toEqual({ sid: 'PNabc', phoneNumber: '+15550000', friendlyName: 'fn', voiceUrl: 'v', statusCallback: 's' })
    const call = calls[0]
    expect(call.init?.method).toBe('POST')
    const body = String(call.init?.body)
    expect(body).toContain('PhoneNumber=')
    expect(body).not.toContain('StatusCallback=')
  })
  it('falls back friendlyName to phone_number when missing', async () => {
    const { fn } = makeFetchStub([{ body: { sid: 'PN', phone_number: '+15550000' } }])
    const c = new TwilioClient({ accountSid: 'ACx', authToken: 'tok', fetch: fn })
    const r = await c.purchaseNumber({ phoneNumber: '+15550000' })
    expect(r.friendlyName).toBe('+15550000')
    expect(r.voiceUrl).toBeUndefined()
  })
  it('includes friendlyName, voiceUrl, statusCallback with default events', async () => {
    const { fn, calls } = makeFetchStub([{ body: { sid: 'PN', phone_number: '+1' } }])
    const c = new TwilioClient({ accountSid: 'ACx', authToken: 'tok', fetch: fn })
    await c.purchaseNumber({
      phoneNumber: '+1',
      friendlyName: 'Hi',
      voiceUrl: 'https://v',
      statusCallback: 'https://s',
    })
    const body = String(calls[0].init?.body)
    expect(body).toContain('FriendlyName=Hi')
    expect(body).toContain('VoiceUrl=https%3A%2F%2Fv')
    expect(body).toContain('StatusCallback=https%3A%2F%2Fs')
    expect(body).toContain('StatusCallbackMethod=POST')
    expect(body).toContain('StatusCallbackEvent=initiated')
    expect(body).toContain('StatusCallbackEvent=answered')
    expect(body).toContain('StatusCallbackEvent=completed')
  })
  it('respects custom statusCallback method + events', async () => {
    const { fn, calls } = makeFetchStub([{ body: { sid: 'PN', phone_number: '+1' } }])
    const c = new TwilioClient({ accountSid: 'ACx', authToken: 'tok', fetch: fn })
    await c.purchaseNumber({
      phoneNumber: '+1',
      statusCallback: 'https://s',
      statusCallbackMethod: 'GET',
      statusCallbackEvent: ['ringing'],
    })
    const body = String(calls[0].init?.body)
    expect(body).toContain('StatusCallbackMethod=GET')
    expect(body).toContain('StatusCallbackEvent=ringing')
    expect(body).not.toContain('StatusCallbackEvent=initiated')
  })
  it('throws TwilioApiError on non-2xx', async () => {
    const { fn } = makeFetchStub([{ status: 400, bodyText: 'bad number' }])
    const c = new TwilioClient({ accountSid: 'ACx', authToken: 'tok', fetch: fn })
    let err: any
    await c.purchaseNumber({ phoneNumber: '+1' }).catch((e) => (err = e))
    expect(err).toBeInstanceOf(TwilioApiError)
    expect(err.status).toBe(400)
    expect(err.body).toBe('bad number')
  })
})

describe('TwilioClient.releaseNumber', () => {
  it('sends DELETE and resolves on 204', async () => {
    const { fn, calls } = makeFetchStub([{ status: 204 }])
    const c = new TwilioClient({ accountSid: 'ACx', authToken: 'tok', fetch: fn })
    await c.releaseNumber('PN1')
    expect(calls[0].init?.method).toBe('DELETE')
    expect(calls[0].url).toContain('/IncomingPhoneNumbers/PN1.json')
  })
  it('resolves on 404 (idempotent)', async () => {
    const { fn } = makeFetchStub([{ status: 404, bodyText: 'gone' }])
    const c = new TwilioClient({ accountSid: 'ACx', authToken: 'tok', fetch: fn })
    await c.releaseNumber('PN1')
  })
  it('throws TwilioApiError on other non-2xx', async () => {
    const { fn } = makeFetchStub([{ status: 500, bodyText: 'boom' }])
    const c = new TwilioClient({ accountSid: 'ACx', authToken: 'tok', fetch: fn })
    let err: any
    await c.releaseNumber('PN1').catch((e) => (err = e))
    expect(err).toBeInstanceOf(TwilioApiError)
    expect(err.status).toBe(500)
  })
})

describe('resolveShogoTwilioClient', () => {
  it('returns error when accountSid missing', () => {
    delete process.env.TWILIO_ACCOUNT_SID
    process.env.TWILIO_AUTH_TOKEN = 'tok'
    const r = resolveShogoTwilioClient()
    expect('error' in r).toBe(true)
  })
  it('returns error when authToken missing', () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACx'
    delete process.env.TWILIO_AUTH_TOKEN
    const r = resolveShogoTwilioClient()
    expect('error' in r).toBe(true)
  })
  it('returns a client when both env vars are set', () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACx'
    process.env.TWILIO_AUTH_TOKEN = 'tok'
    const r = resolveShogoTwilioClient() as any
    expect(r.client).toBeInstanceOf(TwilioClient)
    expect(r.accountSid).toBe('ACx')
  })
})

describe('verifyTwilioSignature', () => {
  const token = 'auth-token-xyz'
  function sign(url: string, params: Record<string, string>) {
    const keys = Object.keys(params).sort()
    let data = url
    for (const k of keys) data += k + params[k]
    return createHmac('sha1', token).update(data).digest('base64')
  }

  it('returns false when signature header is null', () => {
    expect(verifyTwilioSignature({ authToken: token, signatureHeader: null, fullUrl: 'u', bodyParams: {} })).toBe(false)
  })
  it('verifies a correctly signed empty-body request', () => {
    const url = 'https://x.shogo.ai/twilio'
    const sig = sign(url, {})
    expect(verifyTwilioSignature({ authToken: token, signatureHeader: sig, fullUrl: url, bodyParams: {} })).toBe(true)
  })
  it('verifies a signed form-body request', () => {
    const url = 'https://x.shogo.ai/twilio'
    const params = { CallSid: 'CA1', From: '+1', To: '+2' }
    const sig = sign(url, params)
    expect(verifyTwilioSignature({ authToken: token, signatureHeader: sig, fullUrl: url, bodyParams: params })).toBe(true)
  })
  it('rejects a tampered signature', () => {
    const url = 'https://x.shogo.ai/twilio'
    const params = { A: '1' }
    const goodSig = sign(url, params)
    const tampered = goodSig.replace(goodSig.charAt(0), goodSig.charAt(0) === 'A' ? 'B' : 'A')
    expect(verifyTwilioSignature({ authToken: token, signatureHeader: tampered, fullUrl: url, bodyParams: params })).toBe(false)
  })
  it('rejects when body params are changed', () => {
    const url = 'https://x.shogo.ai/twilio'
    const sig = sign(url, { A: '1' })
    expect(verifyTwilioSignature({ authToken: token, signatureHeader: sig, fullUrl: url, bodyParams: { A: '2' } })).toBe(false)
  })
})
