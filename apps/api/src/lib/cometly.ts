// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cometly conversions, sent from the server (SHO-441).
 *
 * The marketing site (shogo.ai) loads the Cometly pixel and reports
 * `custom_event_1`; the app at studio.shogo.ai is a different origin, so its
 * sign-ups need their own Create Event — one `sign_up` per new Google account,
 * carrying the `comet_token` the pixel minted on the sign-in page so Cometly
 * can tie the click to the account.
 *
 * Without `COMETLY_API_KEY` in the environment every send here is a no-op: the
 * local/desktop stack never has one, and staging has none until the secret is
 * created. That is not an error, so it must not log.
 */
const COMETLY_EVENTS_URL = 'https://app.cometly.com/public-api/v1/events/track'
const COMETLY_TIMEOUT_MS = 5_000

/**
 * The first-party cookie the web sign-in page writes right before it hands off
 * to Google (`apps/mobile/lib/cometly.ts`). It rides along on the OAuth
 * callback, which is the request the signup hook runs on.
 */
export const COMET_TOKEN_COOKIE = '__shogo_comet_token'

export interface CometlyEventInput {
  /** A Cometly standard or custom event name, e.g. `sign_up`. */
  eventName: string
  email?: string | null
  firstName?: string | null
  lastName?: string | null
  /** `window.cometToken()` from the pixel on the sign-in page. */
  cometToken?: string | null
  /** Deduplicates a retried or multi-region replayed event. */
  idempotencyKey?: string | null
  /** ISO 8601 or Unix seconds; defaults to Cometly's receive time. */
  eventTime?: string | null
  url?: string | null
}

/**
 * `"Ada Lovelace"` → first word / the rest. Both halves can be empty, and an
 * empty half is left out of the request rather than sent as `""`.
 */
export function splitName(name: string | null | undefined): {
  firstName: string
  lastName: string
} {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: '', lastName: '' }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

/**
 * Whether this stack can reach Cometly at all. Silent — it is a config check,
 * and the answer is "no" on desktop, in CI and on any stack without the secret.
 */
export function isCometlyConfigured(): boolean {
  return !!process.env.COMETLY_API_KEY?.trim()
}

/** One Create Event call. Never throws; a failure is a warning, not an error. */
export async function sendCometlyEvent(input: CometlyEventInput): Promise<boolean> {
  const apiKey = process.env.COMETLY_API_KEY?.trim()
  if (!apiKey) return false

  const body: Record<string, string> = { event_name: input.eventName }
  if (input.email) body.email = input.email
  if (input.firstName) body.first_name = input.firstName
  if (input.lastName) body.last_name = input.lastName
  if (input.cometToken) body.comet_token = input.cometToken
  if (input.idempotencyKey) body.idempotency_key = input.idempotencyKey
  if (input.eventTime) body.event_time = input.eventTime
  if (input.url) body.url = input.url

  try {
    const response = await fetch(COMETLY_EVENTS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(COMETLY_TIMEOUT_MS),
    })
    if (!response.ok) {
      // Status only — never the key, and never the payload (it carries the email).
      console.warn(`[Cometly] ${input.eventName} not accepted: HTTP ${response.status}`)
      return false
    }
    return true
  } catch (error: any) {
    console.warn(`[Cometly] ${input.eventName} failed: ${error?.name ?? 'error'}`)
    return false
  }
}
