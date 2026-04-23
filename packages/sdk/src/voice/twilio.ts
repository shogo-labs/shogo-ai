// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Thin `fetch`-based Twilio REST client used by Mode A of the SDK's
 * `TelephonyClient` (self-hosted / BYO keys). Intentionally duplicates
 * the essential pieces of the server-side client in
 * `apps/api/src/lib/twilio.ts` instead of importing it — the SDK must
 * remain server-independent and have zero dependency on the Shogo API
 * or the `twilio` npm package.
 *
 * Only the endpoints currently needed by the SDK are modelled:
 *   - AvailablePhoneNumbers/{country}/Local → search
 *   - IncomingPhoneNumbers                  → purchase
 *   - IncomingPhoneNumbers/{sid}            → release
 */

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

export interface AvailableNumber {
  phoneNumber: string
  friendlyName: string
  region?: string
  locality?: string
  isoCountry?: string
}

export interface IncomingNumber {
  sid: string
  phoneNumber: string
  friendlyName: string
  voiceUrl?: string
}

function toBase64(s: string): string {
  if (typeof btoa === 'function') return btoa(s)
  // Node fallback. Not imported at module-top to keep this file
  // browser-loadable from the SDK barrel.
  const nodeBuffer = (globalThis as any).Buffer
  if (nodeBuffer) return nodeBuffer.from(s, 'utf-8').toString('base64')
  throw new Error('twilio.ts: no base64 encoder available in this runtime')
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
    this.basicAuth = `Basic ${toBase64(`${config.accountSid}:${config.authToken}`)}`
  }

  private accountUrl(path: string): string {
    return `${this.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(
      this.config.accountSid,
    )}${path}`
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: this.basicAuth, ...extra }
  }

  async searchAvailable(
    params: {
      country?: string
      areaCode?: string
      contains?: string
      limit?: number
    } = {},
  ): Promise<AvailableNumber[]> {
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
      throw new TwilioApiError(
        `searchAvailable failed: ${res.status}`,
        res.status,
        await res.text(),
      )
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

  async purchaseNumber(params: {
    phoneNumber: string
    friendlyName?: string
    voiceUrl?: string
  }): Promise<IncomingNumber> {
    const body = new URLSearchParams()
    body.set('PhoneNumber', params.phoneNumber)
    if (params.friendlyName) body.set('FriendlyName', params.friendlyName)
    if (params.voiceUrl) body.set('VoiceUrl', params.voiceUrl)
    const res = await this.fetchImpl(this.accountUrl('/IncomingPhoneNumbers.json'), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      body: body.toString(),
    })
    if (!res.ok) {
      throw new TwilioApiError(
        `purchaseNumber failed: ${res.status}`,
        res.status,
        await res.text(),
      )
    }
    const data = (await res.json()) as {
      sid: string
      phone_number: string
      friendly_name?: string
      voice_url?: string
    }
    return {
      sid: data.sid,
      phoneNumber: data.phone_number,
      friendlyName: data.friendly_name ?? data.phone_number,
      voiceUrl: data.voice_url,
    }
  }

  async releaseNumber(sid: string): Promise<void> {
    const res = await this.fetchImpl(
      this.accountUrl(`/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`),
      { method: 'DELETE', headers: this.headers() },
    )
    if (!res.ok && res.status !== 404) {
      throw new TwilioApiError(
        `releaseNumber failed: ${res.status}`,
        res.status,
        await res.text(),
      )
    }
  }
}
