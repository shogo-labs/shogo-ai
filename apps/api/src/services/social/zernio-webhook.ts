// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a Zernio webhook means, as pure functions.
 *
 * Kept free of database imports (like `relay-plan.ts`) so the signature check
 * and the routing id can be tested on their own, and so a suite that exercises
 * them does not drag Prisma in.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { isScopeId } from './local-scope'
import { zernioId } from './provider-ids'

export const ZERNIO_SIGNATURE_HEADER = 'x-zernio-signature'
export const ZERNIO_EVENT_ID_HEADER = 'x-zernio-event-id'

/** Zernio event → the `social.*` event our triggers subscribe to. */
const EVENT_MAP: Record<string, string> = {
  'comment.received': 'social.comment.received',
  'message.received': 'social.message.received',
  'message.sent': 'social.message.sent',
  'account.connected': 'social.account.connected',
  'account.disconnected': 'social.account.disconnected',
  'workflow.run.completed': 'social.automation.run.completed',
  'workflow.run.succeeded': 'social.automation.run.completed',
  'workflow.run.failed': 'social.automation.run.failed',
}

export function socialEventTypeFor(zernioType: string): string | null {
  return EVENT_MAP[zernioType] ?? null
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/**
 * `X-Zernio-Signature` is our HMAC-SHA256 of the raw body. `sha256=` prefixes
 * are tolerated so a provider that documents the value either way still works.
 */
export function verifyZernioSignature(args: {
  rawBody: string
  signature: string | null | undefined
  secret: string | null | undefined
}): boolean {
  if (!args.secret || !args.signature) return false
  const provided = args.signature.trim().replace(/^sha256=/i, '')
  const expected = createHmac('sha256', args.secret).update(args.rawBody).digest('hex')
  return timingSafeEqualStrings(provided.toLowerCase(), expected)
}

export interface ZernioEvent {
  /** `X-Zernio-Event-Id`, our dedupe key (the body may not carry one). */
  id: string
  /** Provider event name, e.g. `comment.received`. */
  type: string
  /** The routing id of the profile the event belongs to. */
  externalId: string
  account: { zernioAccountId: string; platform: string; username: string } | null
  /** Provider payload for the mapped event (`comment`, `message`, `run`). */
  detail: unknown
  /**
   * The whole verified body. The inbox needs the sibling blocks the mapped
   * detail does not carry (`conversation`, `post`), and a desktop applies the
   * event from what it is given rather than from Zernio.
   */
  payload: unknown
}

function accountFromPayload(payload: any): ZernioEvent['account'] {
  const raw = payload?.account ?? payload?.accounts?.[0] ?? payload?.profiles?.[0]?.accounts?.[0]
  const legacy = raw?.zernioAccountId ?? raw?.accountId
  const id = zernioId(raw) ?? (typeof legacy === 'string' ? legacy : null)
  if (typeof id !== 'string' || !id) return null
  return {
    zernioAccountId: id,
    platform: typeof raw.platform === 'string' ? raw.platform.toLowerCase() : '',
    username: typeof raw.username === 'string' ? raw.username : '',
  }
}

/** Zernio's dashboard/API test delivery; it belongs to no profile. */
export const ZERNIO_TEST_EVENT = 'webhook.test'

/** The event name of a body, or null when it is not a JSON object naming one. */
export function zernioEventType(rawBody: string): string | null {
  try {
    const payload = JSON.parse(rawBody)
    if (!payload || typeof payload !== 'object') return null
    const type = typeof payload.event === 'string' ? payload.event : typeof payload.type === 'string' ? payload.type : ''
    return type || null
  } catch {
    return null
  }
}

/** Read a verified body into the shape routing and the event map need. */
export function parseZernioEvent(rawBody: string, eventIdHeader: string | null | undefined): ZernioEvent | null {
  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null

  const type = typeof payload.type === 'string' ? payload.type : typeof payload.event === 'string' ? payload.event : ''
  const profile = Array.isArray(payload.profiles) ? payload.profiles[0] : payload.profile
  const externalId =
    (typeof profile?.externalId === 'string' && profile.externalId) ||
    (typeof payload.externalId === 'string' && payload.externalId) ||
    ''
  const id =
    (typeof eventIdHeader === 'string' && eventIdHeader.trim()) ||
    zernioId(payload) ||
    (typeof payload.eventId === 'string' && payload.eventId) ||
    ''
  if (!type || !externalId || !id) return null

  // A `workflow.run.*` event carries its execution under `run`, not under the
  // event's own first segment — reading `payload.workflow` there would hand the
  // run recorder `null` and every automation would silently count zero runs.
  const detailKey = type.startsWith('workflow.run') ? 'run' : (type.split('.')[0] ?? '')
  const detail = detailKey && payload[detailKey] !== undefined ? payload[detailKey] : (payload.data ?? null)
  return { id, type, externalId, account: accountFromPayload(payload), detail, payload }
}

/**
 * The local scope of a routing id, validated: `ws_<uuid>` is the cloud scope
 * (`""`) and `lws_<uuid>` names a desktop scope. Anything else is not a routing
 * id we minted, so it is refused rather than silently read as the cloud scope.
 */
export function scopeForExternalId(externalId: string): { ok: true; localWorkspaceId: string } | { ok: false } {
  if (externalId.startsWith('lws_')) {
    const localWorkspaceId = externalId.slice('lws_'.length)
    return isScopeId(localWorkspaceId) ? { ok: true, localWorkspaceId } : { ok: false }
  }
  if (externalId.startsWith('ws_')) {
    const workspaceId = externalId.slice('ws_'.length)
    return isScopeId(workspaceId) ? { ok: true, localWorkspaceId: '' } : { ok: false }
  }
  return { ok: false }
}
