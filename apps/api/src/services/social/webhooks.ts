// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Zernio webhook ingress.
 *
 * Zernio posts every comment, DM and account change to one team-level endpoint
 * (`POST /api/webhooks/zernio`, cloud only). The only key it echoes back is the
 * profile's `externalId`, which is what makes routing a lookup rather than a
 * guess: `externalId → SocialProfile → (workspaceId, localWorkspaceId)`.
 *
 * The same handler runs on both ends of the relay — here for the cloud scope,
 * and in a desktop's own DB for a local scope — so it is written as a
 * `applySocialEvent` that takes whatever the ingress resolved. What an event
 * *means* (signature, routing id, event map) lives in `zernio-webhook.ts`.
 */

import { prisma } from '../../lib/prisma'
import { getSyncEngine } from '../../lib/sync-engine'
import { emitWorkspaceEvent } from '../workspace-events'
import { SocialError } from './client'
import { ingestSocialEvent } from './inbox.service'
import { recordAutomationRun } from './automations.service'
import { enqueueRelayedEvent } from './relay-events.service'
import { getProfileByExternalId, type SocialProfileRow } from './profiles.service'
import {
  ZERNIO_EVENT_ID_HEADER,
  ZERNIO_SIGNATURE_HEADER,
  parseZernioEvent,
  scopeForExternalId,
  socialEventTypeFor,
  verifyZernioSignature,
  type ZernioEvent,
} from './zernio-webhook'

const db = prisma as any

export {
  ZERNIO_EVENT_ID_HEADER,
  ZERNIO_SIGNATURE_HEADER,
  parseZernioEvent,
  scopeForExternalId,
  socialEventTypeFor,
  verifyZernioSignature,
}
export type { ZernioEvent }

export interface ApplySocialEventInput {
  /** The workspace the profile belongs to. */
  workspaceId: string
  externalId: string
  localWorkspaceId?: string
  eventId: string
  /** The provider event name (`comment.received`, …). */
  type: string
  account?: { zernioAccountId: string; platform: string; username: string } | null
  detail?: unknown
  /** The whole verified payload: `conversation` and `post` live here. */
  payload?: unknown
  occurredAt?: Date
}

export interface ApplySocialEventResult {
  status: number
  body: unknown
}

/**
 * Keep the account rows honest for the events that carry an account. Shared by
 * both scopes: the cloud records a desktop scope's accounts when the relay
 * lists them, so a disconnect relayed to that desktop must still flip the
 * cloud's copy — otherwise the meter keeps billing an account the user removed.
 */
async function fixAccountRow(input: {
  workspaceId: string
  type: string
  account?: { zernioAccountId: string; platform: string; username: string } | null
}): Promise<void> {
  const isAccountEvent =
    input.type === 'social.account.connected' || input.type === 'social.account.disconnected'
  if (!isAccountEvent || !input.account?.zernioAccountId) return

  const row = await db.socialAccount.findUnique({
    where: { zernioAccountId: input.account.zernioAccountId },
  })
  if (!row || row.workspaceId !== input.workspaceId) return

  await db.socialAccount.update({
    where: { id: row.id },
    data:
      input.type === 'social.account.disconnected'
        ? { isActive: false, tokenHealthy: false, needsReconnect: true, lastHealthAt: new Date() }
        : { isActive: true, tokenHealthy: true, needsReconnect: false, lastHealthAt: new Date() },
  })
}

/**
 * Apply one already-resolved event: write the inbox rows the event describes,
 * keep the account rows honest, then emit the `social.*` event. Idempotent on
 * the provider's event id — the outbox dedupe key is `zernio:<id>`, so a
 * webhook Zernio retries (it retries 7×) and a desktop that receives the
 * relayed copy both end up as one event.
 *
 * A payload the catalog refuses is **not** a silent success: the ingestion may
 * well have landed (`message.delivered` is inbox-only), but the trigger never
 * fired, so the caller gets a non-2xx. Zernio then retries, and a desktop
 * leaves the delivery unacked until it is dead-lettered — either way somebody
 * can see it, which `200 { ok: true }` would have hidden.
 */
export async function applySocialEvent(input: ApplySocialEventInput): Promise<ApplySocialEventResult> {
  const ingested = await ingestSocialEvent({
    workspaceId: input.workspaceId,
    type: input.type,
    detail: input.detail,
    payload: input.payload,
    account: input.account,
    occurredAt: input.occurredAt,
  })

  const type = socialEventTypeFor(input.type)
  if (!type) {
    return {
      status: 200,
      body: {
        ok: true,
        ignored: `unmapped:${input.type}`,
        ...(ingested.handled ? { inbox: ingested } : {}),
      },
    }
  }

  await fixAccountRow({ workspaceId: input.workspaceId, type, account: input.account })

  // Automation runs are counted from the provider's own run events, one row per
  // execution id, so `analytics.engagement.automationRuns` is a fact rather than
  // a counter that only goes up.
  if (type === 'social.automation.run.completed' || type === 'social.automation.run.failed') {
    await recordAutomationRun({
      workspaceId: input.workspaceId,
      detail: input.detail,
      failed: type === 'social.automation.run.failed',
    }).catch((err) => {
      // A run row is reporting, not delivery: never turn it into a retryable
      // error the provider would redeliver the whole event for.
      console.error('[SocialWebhooks] automation run not recorded', {
        workspaceId: input.workspaceId,
        error: (err as any)?.message ?? err,
      })
    })
  }

  const payload: Record<string, unknown> = { externalId: input.externalId }
  if (input.account) payload.account = input.account
  const detailKey = type === 'social.automation.run.completed' || type === 'social.automation.run.failed'
    ? 'run'
    : type === 'social.comment.received'
      ? 'comment'
      : type.startsWith('social.message.')
        ? 'message'
        : null
  if (detailKey && input.detail !== undefined && input.detail !== null) payload[detailKey] = input.detail

  const emitted = await emitWorkspaceEvent({
    workspaceId: input.workspaceId,
    type,
    source: 'zernio',
    payload,
    dedupeKey: `zernio:${input.eventId}`,
    occurredAt: input.occurredAt,
    actor: { source: 'zernio', externalId: input.externalId, trust: 'platform' },
  })

  if (!emitted) {
    // The catalog refused the payload (see `emitWorkspaceEvent`): the trigger
    // did not run, so do not report success.
    return {
      status: 502,
      body: {
        error: {
          code: 'social_event_rejected',
          message: `The ${type} payload failed the event catalog validator; retrying`,
        },
        ...(ingested.handled ? { inbox: ingested } : {}),
      },
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      type,
      eventId: emitted.eventId,
      duplicate: emitted.duplicate,
      ...(ingested.handled ? { inbox: ingested } : {}),
    },
  }
}

/**
 * A webhook for a desktop-sourced profile is handled on the desktop, in its own
 * DB: the cloud cannot write rows it does not own. Two things happen here, in
 * this order, and both matter:
 *
 * 1. The delivery is persisted (`social_relayed_event`) *before* the provider
 *    gets its `200`. Zernio retries only what it saw fail, so an event that
 *    only existed in memory would be lost for good.
 * 2. A live hint goes out on the sync stream for a desktop that is already
 *    listening; the poll is what actually guarantees delivery.
 */
async function relayToDesktop(profile: SocialProfileRow, event: ZernioEvent): Promise<void> {
  const occurredAt = new Date().toISOString()
  const envelope = {
    externalId: event.externalId,
    localWorkspaceId: profile.localWorkspaceId,
    eventId: event.id,
    type: event.type,
    account: event.account ?? null,
    detail: event.detail ?? null,
    /** The room the inbox needs: `conversation`, `post`, `comment`, `message`. */
    payload: event.payload ?? null,
    occurredAt,
  }

  await enqueueRelayedEvent({ workspaceId: profile.workspaceId, envelope })

  try {
    getSyncEngine().publish({
      id: `social:${event.id}`,
      type: 'SOCIAL_EVENT',
      entityId: profile.id,
      payload: envelope,
      timestamp: Date.now(),
      source: 'api',
      version: 1,
      workspaceId: profile.workspaceId,
    })
  } catch {
    // The durable row is the delivery; a live hint that nobody is listening
    // for is not a failure worth a provider retry.
  }
}

export interface ZernioWebhookInput {
  rawBody: string
  signature?: string | null
  eventId?: string | null
  secret?: string | null
}

/**
 * The endpoint's whole job. Always 2xx for anything we understood — Zernio
 * retries a non-2xx seven times, and an event we chose to ignore is not an
 * error. The exceptions are a payload we cannot read (400) and a bad signature
 * (401), which the provider should not retry into a hole.
 */
export async function handleZernioWebhook(input: ZernioWebhookInput): Promise<{ status: number; body: unknown }> {
  const secret = input.secret ?? process.env.ZERNIO_WEBHOOK_SECRET ?? null
  if (!secret) {
    return { status: 503, body: { error: { code: 'social_webhook_unconfigured', message: 'ZERNIO_WEBHOOK_SECRET is not configured' } } }
  }
  if (!verifyZernioSignature({ rawBody: input.rawBody, signature: input.signature, secret })) {
    return { status: 401, body: { error: { code: 'invalid_signature', message: 'Signature check failed' } } }
  }

  const event = parseZernioEvent(input.rawBody, input.eventId)
  if (!event) {
    return { status: 400, body: { error: { code: 'invalid_body', message: 'Not a Zernio event we can read' } } }
  }

  const scope = scopeForExternalId(event.externalId)
  if (!scope.ok) {
    // A routing id we minted can only ever be `lws_<uuid>`: anything else is a
    // caller bug, and writing on it would be writing for an unknown workspace.
    return { status: 400, body: { error: { code: 'invalid_local_workspace', message: 'Malformed profile externalId' } } }
  }

  const profile = await getProfileByExternalId(event.externalId)
  if (!profile) {
    // Not ours yet (or a profile that was deleted): accept and drop, so the
    // provider stops retrying something we will never want.
    return { status: 200, body: { ok: true, ignored: 'unknown_profile' } }
  }
  if (profile.localWorkspaceId !== scope.localWorkspaceId) {
    return { status: 400, body: { error: { code: 'invalid_local_workspace', message: 'externalId does not match the profile scope' } } }
  }

  if (profile.localWorkspaceId) {
    // The account row is the cloud's copy either way: the relay recorded it on
    // sync, so a disconnect must not leave a healthy-looking row the meter
    // keeps billing. Only the *event* stays out of the cloud.
    await fixAccountRow({
      workspaceId: profile.workspaceId,
      type: socialEventTypeFor(event.type) ?? event.type,
      account: event.account,
    })
    await relayToDesktop(profile, event)
    return { status: 200, body: { ok: true, relayed: profile.localWorkspaceId } }
  }

  const result = await applySocialEvent({
    workspaceId: profile.workspaceId,
    externalId: profile.externalId,
    localWorkspaceId: '',
    eventId: event.id,
    type: event.type,
    account: event.account,
    detail: event.detail,
    payload: event.payload,
  })
  return result
}

/** Re-exported so callers get one error shape from this module. */
export { SocialError }
