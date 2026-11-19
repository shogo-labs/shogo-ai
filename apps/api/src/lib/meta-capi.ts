// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Meta Conversions API (server-side events).
 *
 * The browser Pixel alone loses a share of events to blockers and never sees
 * what happens with no browser attached (activation inside a chat turn, the
 * first paid invoice from a Stripe webhook). Every event sent here carries the
 * same `event_id` the Pixel used (when there is a browser twin), so Meta keeps
 * one of the two.
 *
 * Env:
 *   META_PIXEL_ID         dataset / pixel id (falls back to FB_PIXEL_ID)
 *   META_CAPI_TOKEN       system-user access token; unset = every call is a no-op
 *   META_TEST_EVENT_CODE  staging only: routes events to Events Manager → Test events
 *
 * Never throws and never blocks a request: callers fire-and-forget.
 */
import { createHash } from 'node:crypto'

const GRAPH_VERSION = 'v21.0'

export type MetaEventName =
  | 'CompleteRegistration'
  | 'Lead'
  | 'ViewContent'
  | 'Subscribe'
  | 'Purchase'
  | 'Activated'
  | 'FunnelStart'

export interface MetaUserData {
  email?: string | null
  externalId?: string | null
  fbp?: string | null
  fbc?: string | null
  clientIp?: string | null
  userAgent?: string | null
}

export interface MetaEvent {
  name: MetaEventName
  eventId: string
  user: MetaUserData
  /** Page the event happened on; required by Meta for `website` events. */
  sourceUrl?: string | null
  customData?: Record<string, unknown>
  /** Seconds since epoch. Defaults to now. */
  eventTime?: number
}

export interface MetaCapiConfig {
  pixelId: string
  token: string
  testEventCode?: string
}

export function metaCapiConfig(env: NodeJS.ProcessEnv = process.env): MetaCapiConfig | null {
  const pixelId = (env.META_PIXEL_ID || env.FB_PIXEL_ID || '').trim()
  const token = (env.META_CAPI_TOKEN || '').trim()
  if (!pixelId || !token || pixelId === 'FB_PIXEL_ID_PLACEHOLDER') return null
  const testEventCode = (env.META_TEST_EVENT_CODE || '').trim() || undefined
  return { pixelId, token, testEventCode }
}

export function sha256Normalized(value: string | null | undefined): string | undefined {
  const v = (value ?? '').trim().toLowerCase()
  if (!v) return undefined
  return createHash('sha256').update(v).digest('hex')
}

/** Meta's `user_data` block: PII hashed, browser ids and client hints raw. */
export function buildUserData(user: MetaUserData): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const em = sha256Normalized(user.email)
  if (em) out.em = [em]
  const ext = sha256Normalized(user.externalId)
  if (ext) out.external_id = [ext]
  if (user.fbp) out.fbp = user.fbp
  if (user.fbc) out.fbc = user.fbc
  if (user.clientIp) out.client_ip_address = user.clientIp
  if (user.userAgent) out.client_user_agent = user.userAgent
  return out
}

export function buildPayload(events: MetaEvent[], cfg: MetaCapiConfig): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    data: events.map((e) => ({
      event_name: e.name,
      event_time: e.eventTime ?? now,
      event_id: e.eventId,
      action_source: 'website',
      ...(e.sourceUrl ? { event_source_url: e.sourceUrl } : {}),
      user_data: buildUserData(e.user),
      ...(e.customData && Object.keys(e.customData).length ? { custom_data: e.customData } : {}),
    })),
  }
  if (cfg.testEventCode) payload.test_event_code = cfg.testEventCode
  return payload
}

export interface SendResult {
  sent: boolean
  status?: number
  eventsReceived?: number
  error?: string
}

/**
 * Send one or more events. Resolves `{ sent: false }` when the API is not
 * configured (desktop, dev, any stack without a token) — that is the normal
 * case, not an error.
 */
export async function sendMetaEvents(
  events: MetaEvent[],
  opts: { config?: MetaCapiConfig | null; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SendResult> {
  const cfg = opts.config === undefined ? metaCapiConfig() : opts.config
  if (!cfg || events.length === 0) return { sent: false }
  const doFetch = opts.fetchImpl ?? fetch
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(cfg.pixelId)}/events?access_token=${encodeURIComponent(cfg.token)}`
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildPayload(events, cfg)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    })
    const body = (await res.json().catch(() => ({}))) as { events_received?: number; error?: { message?: string } }
    if (!res.ok) {
      const error = body?.error?.message ?? `HTTP ${res.status}`
      console.warn(`[meta-capi] ${events.map((e) => e.name).join(',')} rejected: ${error}`)
      return { sent: false, status: res.status, error }
    }
    return { sent: true, status: res.status, eventsReceived: body?.events_received }
  } catch (error: any) {
    console.warn('[meta-capi] send failed:', error?.message ?? error)
    return { sent: false, error: String(error?.message ?? error) }
  }
}

export function sendMetaEvent(event: MetaEvent): Promise<SendResult> {
  return sendMetaEvents([event])
}

/** First IP in `x-forwarded-for` (Cloudflare/ingress), else `x-real-ip`. */
export function clientIpFromHeaders(get: (name: string) => string | null | undefined): string | null {
  const cf = get('cf-connecting-ip')
  if (cf) return cf.trim()
  const fwd = get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim() || null
  return get('x-real-ip')?.trim() || null
}

/**
 * `_fbc` from the cookie, or built from a `fbclid` the landing page kept, in
 * Meta's `fb.1.<ms>.<fbclid>` format.
 */
export function fbcFrom(cookieFbc: string | null | undefined, fbclid: string | null | undefined): string | null {
  if (cookieFbc) return cookieFbc
  if (fbclid) return `fb.1.${Date.now()}.${fbclid}`
  return null
}
