// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Loops Service
 *
 * Server-side integration with Loops (loops.so) for lifecycle marketing
 * automation. Loops is a developer-first email platform — one API key,
 * two endpoints: contacts and events.
 *
 * - identifyUser  → POST /api/v1/contacts/create (upsert)
 * - trackEvent    → POST /api/v1/events/send
 * - unsubscribeUser → PUT /api/v1/contacts/update  { unsubscribed: true }
 *
 * All calls are fire-and-forget and never throw into the caller — a failed
 * analytics call must never break a product flow.
 *
 * Env var required (gracefully disabled if absent):
 *   LOOPS_API_KEY — API key from loops.so → Settings → API
 */

const API_KEY = process.env.LOOPS_API_KEY
const BASE = 'https://app.loops.so/api/v1'

function isConfigured(): boolean {
  return !!API_KEY
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}` }
}

async function post(path: string, body: unknown): Promise<void> {
  if (!isConfigured()) return
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[Loops] POST ${path} → ${res.status}: ${text}`)
    }
  } catch (err: any) {
    console.warn(`[Loops] POST ${path} failed: ${err?.message ?? err}`)
  }
}

async function put(path: string, body: unknown): Promise<void> {
  if (!isConfigured()) return
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[Loops] PUT ${path} → ${res.status}: ${text}`)
    }
  } catch (err: any) {
    console.warn(`[Loops] PUT ${path} failed: ${err?.message ?? err}`)
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Upsert a contact in Loops. Call on signup and whenever traits change
 * (e.g. plan upgrade). Loops merges properties — missing keys are left
 * unchanged on existing contacts.
 *
 * https://loops.so/docs/api-reference/contacts/create
 */
export async function identifyUser(
  userId: string,
  traits: {
    email: string
    firstName?: string
    lastName?: string
    plan?: string
    userGroup?: string
    createdAt?: string   // ISO 8601
    [key: string]: unknown
  },
): Promise<void> {
  await post('/contacts/create', { userId, ...traits })
}

/**
 * Send a Loops event for a user. Any workflow whose trigger is set to this
 * event name will fire automatically.
 *
 * https://loops.so/docs/api-reference/events/send
 */
export async function trackEvent(
  userId: string,
  eventName: string,
  eventProperties?: Record<string, unknown>,
  contactProperties?: Record<string, unknown>,
): Promise<void> {
  await post('/events/send', {
    userId,
    eventName,
    ...(eventProperties && Object.keys(eventProperties).length > 0
      ? { eventProperties }
      : {}),
    ...(contactProperties && Object.keys(contactProperties).length > 0
      ? contactProperties
      : {}),
  })
}

/**
 * Unsubscribe a user from all marketing emails (drip + conversion sequences).
 * Call when a free user upgrades to a paid plan so they stop receiving
 * free-tier lifecycle emails.
 *
 * https://loops.so/docs/api-reference/contacts/update
 */
export async function unsubscribeUser(userId: string): Promise<void> {
  await put('/contacts/update', { userId, unsubscribed: true })
}

/**
 * Re-subscribe a user to marketing emails.
 * Exposed for completeness; not currently called in product flows.
 */
export async function resubscribeUser(userId: string): Promise<void> {
  await put('/contacts/update', { userId, unsubscribed: false })
}
