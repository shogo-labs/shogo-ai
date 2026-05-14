// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_TWILIO_BASE_URL,
  TwilioApiError,
  TwilioClient,
  resolveShogoTwilioClient,
  verifyTwilioSignature,
} from '../lib/twilio'

const ENV_KEYS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

function makeClient(fetchImpl: typeof fetch): TwilioClient {
  return new TwilioClient({
    accountSid: 'AC test/sid',
    authToken: 'auth-token',
    baseUrl: 'https://twilio.test/',
    fetch: fetchImpl,
  })
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('TwilioClient constructor', () => {
  test('requires accountSid and authToken', () => {
    expect(() => new TwilioClient({ accountSid: '', authToken: 'token', fetch })).toThrow('accountSid')
    expect(() => new TwilioClient({ accountSid: 'sid', authToken: '', fetch })).toThrow('authToken')
  })

  test('uses the public Twilio base URL by default', async () => {
    const calls: string[] = []
    const client = new TwilioClient({
      accountSid: 'AC123',
      authToken: 'token',
      fetch: (async (url) => {
        calls.push(String(url))
        return jsonResponse({ available_phone_numbers: [] })
      }) as typeof fetch,
    })

    await client.searchAvailable()

    expect(calls[0].startsWith(DEFAULT_TWILIO_BASE_URL)).toBe(true)
  })

  test('throws when no fetch implementation is available', () => {
    const originalFetch = globalThis.fetch
    try {
      ;(globalThis as any).fetch = undefined
      expect(() => new TwilioClient({ accountSid: 'sid', authToken: 'token' }))
        .toThrow('global fetch is unavailable')
    } finally {
      ;(globalThis as any).fetch = originalFetch
    }
  })
})

describe('TwilioClient searchAvailable', () => {
  test('maps available phone numbers and sends basic auth', async () => {
    const calls: Array<{ url: string; headers?: HeadersInit }> = []
    const client = makeClient((async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers })
      return jsonResponse({
        available_phone_numbers: [
          {
            phone_number: '+15551234567',
            friendly_name: '(555) 123-4567',
            region: 'CA',
            locality: 'San Francisco',
            iso_country: 'US',
          },
          { phone_number: '+15559876543' },
        ],
      })
    }) as typeof fetch)

    const numbers = await client.searchAvailable({
      country: 'ca',
      areaCode: '416',
      contains: '555',
      limit: 2,
    })

    expect(calls[0].url).toContain('/AvailablePhoneNumbers/CA/Local.json')
    expect(calls[0].url).toContain('AreaCode=416')
    expect(calls[0].url).toContain('Contains=555')
    expect(calls[0].url).toContain('PageSize=2')
    expect((calls[0].headers as Record<string, string>).authorization).toMatch(/^Basic /)
    expect(numbers).toEqual([
      {
        phoneNumber: '+15551234567',
        friendlyName: '(555) 123-4567',
        region: 'CA',
        locality: 'San Francisco',
        isoCountry: 'US',
      },
      {
        phoneNumber: '+15559876543',
        friendlyName: '+15559876543',
        region: undefined,
        locality: undefined,
        isoCountry: undefined,
      },
    ])
  })

  test('throws TwilioApiError on search failure', async () => {
    const client = makeClient((async () => new Response('rate limited', { status: 429 })) as typeof fetch)

    try {
      await client.searchAvailable()
      throw new Error('expected searchAvailable to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(TwilioApiError)
      expect((err as TwilioApiError).status).toBe(429)
      expect((err as TwilioApiError).body).toBe('rate limited')
    }
  })
})

describe('TwilioClient purchaseNumber and releaseNumber', () => {
  test('posts form-encoded purchase fields and maps response defaults', async () => {
    const calls: Array<{ url: string; method?: string; headers?: HeadersInit; body?: BodyInit | null }> = []
    const client = makeClient((async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
      })
      return jsonResponse({
        sid: 'PN123',
        phone_number: '+15551234567',
        voice_url: 'https://voice.example/webhook',
        status_callback: 'https://status.example/callback',
      })
    }) as typeof fetch)

    const result = await client.purchaseNumber({
      phoneNumber: '+15551234567',
      friendlyName: 'Support Line',
      voiceUrl: 'https://voice.example/webhook',
      statusCallback: 'https://status.example/callback',
      statusCallbackMethod: 'GET',
      statusCallbackEvent: ['initiated', 'ringing'],
    })

    expect(calls[0].url).toContain('/IncomingPhoneNumbers.json')
    expect(calls[0].method).toBe('POST')
    expect((calls[0].headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(String(calls[0].body))
    expect(body.get('PhoneNumber')).toBe('+15551234567')
    expect(body.get('FriendlyName')).toBe('Support Line')
    expect(body.get('VoiceUrl')).toBe('https://voice.example/webhook')
    expect(body.get('StatusCallback')).toBe('https://status.example/callback')
    expect(body.get('StatusCallbackMethod')).toBe('GET')
    expect(body.getAll('StatusCallbackEvent')).toEqual(['initiated', 'ringing'])
    expect(result).toEqual({
      sid: 'PN123',
      phoneNumber: '+15551234567',
      friendlyName: '+15551234567',
      voiceUrl: 'https://voice.example/webhook',
      statusCallback: 'https://status.example/callback',
    })
  })

  test('uses default status callback events and POST method', async () => {
    let body = ''
    const client = makeClient((async (_url, init) => {
      body = String(init?.body)
      return jsonResponse({
        sid: 'PN123',
        phone_number: '+15551234567',
        friendly_name: 'Line',
      })
    }) as typeof fetch)

    await client.purchaseNumber({
      phoneNumber: '+15551234567',
      statusCallback: 'https://status.example/callback',
    })

    const params = new URLSearchParams(body)
    expect(params.get('StatusCallbackMethod')).toBe('POST')
    expect(params.getAll('StatusCallbackEvent')).toEqual(['initiated', 'answered', 'completed'])
  })

  test('throws TwilioApiError on purchase failure', async () => {
    const client = makeClient((async () => new Response('bad number', { status: 400 })) as typeof fetch)

    await expect(client.purchaseNumber({ phoneNumber: '+1555' })).rejects.toThrow('purchaseNumber failed: 400')
  })

  test('DELETEs incoming number and treats 404 as already released', async () => {
    const calls: Array<{ url: string; method?: string }> = []
    const client = makeClient((async (url, init) => {
      calls.push({ url: String(url), method: init?.method })
      return new Response('', { status: calls.length === 1 ? 204 : 404 })
    }) as typeof fetch)

    await expect(client.releaseNumber('PN/needs encoding')).resolves.toBeUndefined()
    await expect(client.releaseNumber('PN-missing')).resolves.toBeUndefined()

    expect(calls[0].url).toContain('/IncomingPhoneNumbers/PN%2Fneeds%20encoding.json')
    expect(calls[0].method).toBe('DELETE')
  })

  test('throws TwilioApiError on release failures other than 404', async () => {
    const client = makeClient((async () => new Response('server down', { status: 500 })) as typeof fetch)

    await expect(client.releaseNumber('PN123')).rejects.toThrow('releaseNumber failed: 500')
  })
})

describe('resolveShogoTwilioClient', () => {
  test('returns an error when env is incomplete', () => {
    expect(resolveShogoTwilioClient()).toEqual({
      error:
        'Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the API server to enable telephony.',
    })

    process.env.TWILIO_ACCOUNT_SID = 'AC123'
    expect(resolveShogoTwilioClient()).toEqual({
      error:
        'Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the API server to enable telephony.',
    })
  })

  test('returns a configured client when env is present', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123'
    process.env.TWILIO_AUTH_TOKEN = 'token'

    const result = resolveShogoTwilioClient()

    expect('client' in result).toBe(true)
    expect((result as { accountSid: string }).accountSid).toBe('AC123')
  })
})

describe('verifyTwilioSignature', () => {
  test('validates sorted form parameters with HMAC-SHA1', () => {
    const authToken = 'secret'
    const fullUrl = 'https://api.example.com/twilio/webhook'
    const bodyParams = {
      Digits: '1234',
      CallSid: 'CA123',
      From: '+15551234567',
    }
    const data = fullUrl + 'CallSidCA123' + 'Digits1234' + 'From+15551234567'
    const signatureHeader = createHmac('sha1', authToken).update(data).digest('base64')

    expect(verifyTwilioSignature({ authToken, signatureHeader, fullUrl, bodyParams })).toBe(true)
  })

  test('rejects missing or mismatched signatures', () => {
    const params = {
      authToken: 'secret',
      fullUrl: 'https://api.example.com/twilio/webhook',
      bodyParams: { CallSid: 'CA123' },
    }

    expect(verifyTwilioSignature({ ...params, signatureHeader: null })).toBe(false)
    expect(verifyTwilioSignature({ ...params, signatureHeader: 'wrong' })).toBe(false)
  })
})
