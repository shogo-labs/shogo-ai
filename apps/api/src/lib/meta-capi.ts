// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Meta Conversions API, sent from the server (SHO-611).
 *
 * The pixel alone cannot see most sign-ups or purchases: the studio runs on a
 * second origin, ad blockers drop `fbevents.js`, and a closed tab loses a
 * checkout that Stripe charged. This posts the same conversions straight to
 * Meta, with the *same* `event_id` the browser used (`signup_<userId>`, the
 * checkout session id), which is the only way Meta dedupes the two into one
 * conversion. The ids and cookie names live in
 * `packages/shared-app/src/lib/conversion-events.ts`, imported by the app too,
 * so the two sides cannot drift.
 *
 * Without `META_CAPI_ACCESS_TOKEN` or `FB_PIXEL_ID` every send here is a no-op
 * and stays silent: desktop, local dev, CI and staging have no token, and that
 * is a configuration fact, not an error.
 */
import { createHash } from 'node:crypto'
import { buildFbcFromFbclid } from '../../../../packages/shared-app/src/lib/conversion-events'

const META_GRAPH_VERSION = 'v21.0'
const META_TIMEOUT_MS = 5_000

/** One conversion, built and ready to POST. */
export interface MetaServerEvent {
  event_name: string
  event_time: number
  event_id: string
  action_source: 'website'
  user_data: {
    /** SHA-256 of the lowercased, trimmed email — never the email itself. */
    em?: string[]
    /** SHA-256 of the user id. */
    external_id?: string[]
    fbc?: string
    fbp?: string
    client_ip_address?: string
    client_user_agent?: string
  }
  custom_data?: Record<string, unknown>
  event_source_url?: string
}

export interface MetaEventInput {
  eventName: string
  eventId: string
  /** Unix milliseconds; defaults to now. Meta takes seconds. */
  eventTime?: number
  email?: string | null
  externalId?: string | null
  /** The `_fbc` cookie. When absent, `fbclid` is turned into one. */
  fbc?: string | null
  fbclid?: string | null
  fbp?: string | null
  clientIp?: string | null
  userAgent?: string | null
  sourceUrl?: string | null
  customData?: Record<string, unknown>
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Meta wants the email lowercased and trimmed before it is hashed. */
export function hashEmail(email: string): string {
  return sha256(email.trim().toLowerCase())
}

function trimmed(value: string | null | undefined): string | undefined {
  const v = value?.trim()
  return v ? v : undefined
}

/**
 * Build the event Meta receives. Pure: no clock of its own, no I/O, so a test
 * can pin the time and compare the whole object.
 */
export function buildMetaEvent(input: MetaEventInput, now: number = Date.now()): MetaServerEvent {
  const userData: MetaServerEvent['user_data'] = {}

  const email = trimmed(input.email)
  if (email) userData.em = [hashEmail(email)]

  const externalId = trimmed(input.externalId)
  if (externalId) userData.external_id = [sha256(externalId)]

  // Meta's documented `_fbc` format when only the click id reached us.
  const fbc = trimmed(input.fbc) ?? (trimmed(input.fbclid) ? buildFbcFromFbclid(trimmed(input.fbclid)!, now) : undefined)
  if (fbc) userData.fbc = fbc

  const fbp = trimmed(input.fbp)
  if (fbp) userData.fbp = fbp

  const clientIp = trimmed(input.clientIp)
  if (clientIp) userData.client_ip_address = clientIp

  const userAgent = trimmed(input.userAgent)
  if (userAgent) userData.client_user_agent = userAgent

  const event: MetaServerEvent = {
    event_name: input.eventName,
    event_time: Math.floor((input.eventTime ?? now) / 1000),
    event_id: input.eventId,
    action_source: 'website',
    user_data: userData,
  }

  const sourceUrl = trimmed(input.sourceUrl)
  if (sourceUrl) event.event_source_url = sourceUrl

  if (input.customData && Object.keys(input.customData).length > 0) {
    event.custom_data = input.customData
  }

  return event
}

/** Whether this stack can reach Meta at all. Silent — it is a config check. */
export function isMetaCapiConfigured(): boolean {
  return !!process.env.META_CAPI_ACCESS_TOKEN?.trim() && !!process.env.FB_PIXEL_ID?.trim()
}

/**
 * One POST, all the events in it. Never throws; a failure is a warning that
 * carries the status only — never the payload (it holds the hashed email) and
 * never the token. Returns whether Meta accepted the batch.
 */
export async function sendMetaEvents(events: MetaServerEvent[]): Promise<boolean> {
  if (events.length === 0) return false

  const accessToken = process.env.META_CAPI_ACCESS_TOKEN?.trim()
  const pixelId = process.env.FB_PIXEL_ID?.trim()
  if (!accessToken || !pixelId) return false

  const testEventCode = process.env.META_CAPI_TEST_EVENT_CODE?.trim()
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${pixelId}/events`

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: events,
        access_token: accessToken,
        ...(testEventCode ? { test_event_code: testEventCode } : {}),
      }),
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
    })
    if (!response.ok) {
      console.warn(`[MetaCAPI] ${events.map((e) => e.event_name).join(',')} not accepted: HTTP ${response.status}`)
      return false
    }
    return true
  } catch (error: any) {
    console.warn(`[MetaCAPI] ${events.map((e) => e.event_name).join(',')} failed: ${error?.name ?? 'error'}`)
    return false
  }
}
