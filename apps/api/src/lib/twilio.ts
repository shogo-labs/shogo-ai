// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Thin fetch-based Twilio REST client for the endpoints Shogo needs to
 * buy + release numbers on behalf of Mode B projects. Intentionally
 * minimal — we avoid the `twilio` npm package so the API server boots
 * without hauling in its dependency tree when telephony is disabled.
 *
 * Only the endpoints used today are typed. Add more as needed.
 *
 *   - AvailablePhoneNumbers/{country}/Local → search for a number
 *   - IncomingPhoneNumbers                  → purchase or list
 *   - IncomingPhoneNumbers/{sid}            → release (DELETE)
 *   - Messages / Calls webhook signature verification (helper below)
 */

import { createHmac } from 'node:crypto'
import { safeBufferEqual } from './crypto-util'

export const DEFAULT_TWILIO_BASE_URL = 'https://api.twilio.com'

export class TwilioApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'TwilioApiError'
  }
}

export interface TwilioClientConfig {
  accountSid: string
  authToken: string
  /** Override for tests. Defaults to the public API. */
  baseUrl?: string
  /** Custom fetch (for tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch
}

export interface AvailableNumberResult {
  phoneNumber: string
  friendlyName: string
  region?: string
  locality?: string
  isoCountry?: string
}

export interface IncomingNumberResult {
  sid: string
  phoneNumber: string
  friendlyName: string
  /** Voice URL the number routes inbound calls to (set by us when linking to EL). */
  voiceUrl?: string
  statusCallback?: string
}

export interface SearchAvailableParams {
  country?: string // defaults to 'US'
  areaCode?: string
  contains?: string
  limit?: number
}

export interface PurchaseNumberParams {
  /** E.164 number returned from `searchAvailable`. */
  phoneNumber: string
  friendlyName?: string
  /** Voice webhook URL. Leave unset when ElevenLabs owns the SIP link. */
  voiceUrl?: string
  /** Shogo status callback URL (per-call lifecycle events). */
  statusCallback?: string
  statusCallbackMethod?: 'POST' | 'GET'
  statusCallbackEvent?: Array<'initiated' | 'ringing' | 'answered' | 'completed'>
}

export class TwilioClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly basicAuth: string

  constructor(private readonly config: TwilioClientConfig) {
    if (!config.accountSid) throw new Error('TwilioClient: accountSid is required')
    if (!config.authToken) throw new Error('TwilioClient: authToken is required')
    this.baseUrl = (config.baseUrl ?? DEFAULT_TWILIO_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = config.fetch ?? globalThis.fetch
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('TwilioClient: global fetch is unavailable; pass config.fetch')
    }
    this.basicAuth = `Basic ${Buffer.from(
      `${config.accountSid}:${config.authToken}`,
    ).toString('base64')}`
  }

  private accountUrl(path: string): string {
    return `${this.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(
      this.config.accountSid,
    )}${path}`
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: this.basicAuth,
      ...extra,
    }
  }

  /** Search Twilio's catalog for purchasable numbers. */
  async searchAvailable(
    params: SearchAvailableParams = {},
  ): Promise<AvailableNumberResult[]> {
    const country = (params.country ?? 'US').toUpperCase()
    const search = new URLSearchParams()
    if (params.areaCode) search.set('AreaCode', params.areaCode)
    if (params.contains) search.set('Contains', params.contains)
    search.set('PageSize', String(params.limit ?? 10))

    const url = `${this.accountUrl(
      `/AvailablePhoneNumbers/${country}/Local.json`,
    )}?${search.toString()}`
    const res = await this.fetchImpl(url, { headers: this.headers() })
    if (!res.ok) {
      const text = await res.text()
      throw new TwilioApiError(`searchAvailable failed: ${res.status}`, res.status, text)
    }
    const data = (await res.json()) as {
      available_phone_numbers?: Array<{
        phone_number: string
        friendly_name?: string
        region?: string
        locality?: string
        iso_country?: string
      }>
    }
    return (data.available_phone_numbers ?? []).map((n) => ({
      phoneNumber: n.phone_number,
      friendlyName: n.friendly_name ?? n.phone_number,
      region: n.region,
      locality: n.locality,
      isoCountry: n.iso_country,
    }))
  }

  /** Purchase an AvailablePhoneNumber, returning the new IncomingPhoneNumber. */
  async purchaseNumber(
    params: PurchaseNumberParams,
  ): Promise<IncomingNumberResult> {
    const body = new URLSearchParams()
    body.set('PhoneNumber', params.phoneNumber)
    if (params.friendlyName) body.set('FriendlyName', params.friendlyName)
    if (params.voiceUrl) body.set('VoiceUrl', params.voiceUrl)
    if (params.statusCallback) {
      body.set('StatusCallback', params.statusCallback)
      body.set('StatusCallbackMethod', params.statusCallbackMethod ?? 'POST')
      for (const ev of params.statusCallbackEvent ?? [
        'initiated',
        'answered',
        'completed',
      ]) {
        body.append('StatusCallbackEvent', ev)
      }
    }

    const res = await this.fetchImpl(this.accountUrl('/IncomingPhoneNumbers.json'), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      body: body.toString(),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new TwilioApiError(`purchaseNumber failed: ${res.status}`, res.status, text)
    }
    const data = (await res.json()) as {
      sid: string
      phone_number: string
      friendly_name?: string
      voice_url?: string
      status_callback?: string
    }
    return {
      sid: data.sid,
      phoneNumber: data.phone_number,
      friendlyName: data.friendly_name ?? data.phone_number,
      voiceUrl: data.voice_url,
      statusCallback: data.status_callback,
    }
  }

  /** Release a number, stopping recurring Twilio billing for it. */
  async releaseNumber(sid: string): Promise<void> {
    const res = await this.fetchImpl(
      this.accountUrl(`/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`),
      { method: 'DELETE', headers: this.headers() },
    )
    if (!res.ok && res.status !== 404) {
      const text = await res.text()
      throw new TwilioApiError(`releaseNumber failed: ${res.status}`, res.status, text)
    }
  }
}

/**
 * Resolve Shogo's pooled Twilio client from env. Returns `{ error }` if
 * env vars are missing. Not module-level so tests can mock without
 * clobbering process.env.
 */
export function resolveShogoTwilioClient():
  | { client: TwilioClient; accountSid: string }
  | { error: string } {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!accountSid || !authToken) {
    return {
      error:
        'Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the API server to enable telephony.',
    }
  }
  return {
    client: new TwilioClient({ accountSid, authToken }),
    accountSid,
  }
}

/**
 * Verify a Twilio webhook signature per their docs:
 *   https://www.twilio.com/docs/usage/security#validating-requests
 *
 * Twilio signs `url + concat(sorted(key + value))` with HMAC-SHA1 and
 * base64s the result. For `application/x-www-form-urlencoded` POSTs
 * the params are the body fields; for `application/json` POSTs the
 * params are empty and the raw body is hashed with SHA-256 into an
 * `X-Twilio-Body-SHA256` header instead. Today we only call this for
 * our own form-encoded statusCallback, so we handle the form path.
 */
export function verifyTwilioSignature(params: {
  authToken: string
  signatureHeader: string | null
  fullUrl: string
  bodyParams: Record<string, string>
}): boolean {
  if (!params.signatureHeader) return false
  const sortedKeys = Object.keys(params.bodyParams).sort()
  let data = params.fullUrl
  for (const k of sortedKeys) data += k + params.bodyParams[k]
  const expected = createHmac('sha1', params.authToken).update(data).digest('base64')
  return safeBufferEqual(Buffer.from(expected), Buffer.from(params.signatureHeader))
}
