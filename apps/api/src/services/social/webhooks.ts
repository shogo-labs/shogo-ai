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
import { routeToHomeRegion } from '../../lib/home-region-route'
import { getSyncEngine } from '../../lib/sync-engine'
import { emitWorkspaceEvent } from '../workspace-events'
import { SocialError } from './client'
import { ingestSocialEvent } from './inbox.service'
import { recordAutomationRun } from './automations.service'
import { enqueueRelayedEvent } from './relay-events.service'
import { getProfileByExternalId, type SocialProfileRow } from './profiles.service'
import { applyProviderPostState } from './publishing.service'
import { zernioId } from './provider-ids'
import {
  ZERNIO_EVENT_ID_HEADER,
  ZERNIO_SIGNATURE_HEADER,
  ZERNIO_TEST_EVENT,
  parseZernioEvent,
  scopeForExternalId,
  socialEventTypeFor,
  verifyZernioSignature,
  zernioEventType,
  type ZernioEvent,
} from './zernio-webhook'

const db = prisma as any

/**
 * The home region's half of a forwarded Zernio event (`POST
 * /api/internal/social/apply`). Mirrors `MAIL_FORWARD_PATH`.
 */
export const SOCIAL_APPLY_PATH = '/api/internal/social/apply'

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
 * Provider events that report where a post ended up. Zernio fires exactly one
 * of `post.published` / `post.partial` / `post.failed` once every target of a
 * publishing job has finished, and `post.platform.*` per target meanwhile.
 * `post.id` is the `zernioPostId` we saved when we dispatched it.
 */
const POST_RESULT_EVENTS = new Set([
  'post.published',
  'post.partial',
  'post.failed',
  'post.platform.published',
  'post.platform.failed',
])

export function isPostResultEvent(type: string): boolean {
  return POST_RESULT_EVENTS.has(type)
}

/**
 * Fold a `post.*` event onto our row, through the same writer the read path
 * uses, so the two can never disagree. An unknown id is ignored rather than
 * retried: the provider will keep redelivering something we do not have.
 */
async function applyPostResultEvent(
  workspaceId: string,
  detail: unknown,
  payload: unknown,
): Promise<{ handled: boolean; postId?: string; status?: string }> {
  const record = (detail ?? (payload as any)?.post) as any
  const zernioPostId = zernioId(record, 'post')
  if (!zernioPostId) return { handled: false }
  const row = await db.socialPost.findFirst({
    where: { workspaceId, zernioPostId },
    include: {
      targets: {
        include: { account: { select: { id: true, username: true, platform: true, zernioAccountId: true } } },
      },
    },
  })
  if (!row) return { handled: false }
  await applyProviderPostState(row, record)
  return { handled: true, postId: row.id, status: row.status }
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

  // A `post.*` event is not in the trigger catalog: it reports where a post we
  // already dispatched ended up, so it is written straight onto our row instead
  // of being dropped as unmapped. Same writer as the read path.
  if (isPostResultEvent(input.type)) {
    const applied = await applyPostResultEvent(input.workspaceId, input.detail, input.payload)
    return applied.handled
      ? { status: 200, body: { ok: true, ...applied, ...(ingested.handled ? { inbox: ingested } : {}) } }
      : { status: 200, body: { ok: true, ignored: 'unknown_post' } }
  }

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

  const eventType = zernioEventType(input.rawBody)
  if (eventType === ZERNIO_TEST_EVENT) {
    return { status: 200, body: { ok: true, test: true } }
  }
  const event = parseZernioEvent(input.rawBody, input.eventId)
  if (!event) {
    if (eventType) {
      // A signed, named event with no profile routing id (`webhook.test` aside,
      // Zernio sends `workflow.run.*`, `support.run.*` and `verification.*` this
      // way). A 400 would make Zernio retry it seven times, so accept and drop.
      return { status: 200, body: { ok: true, ignored: 'no_profile' } }
    }
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
    // Same reason for the post: `recordPost` wrote the cloud's copy of a
    // desktop's post, so a result webhook has to land on it too — otherwise the
    // cloud's analytics and billing keep counting a delivered post as scheduled.
    if (isPostResultEvent(event.type)) {
      await applyPostResultEvent(profile.workspaceId, event.detail, event.payload).catch((err) => {
        // The desktop owns the post; a copy we could not update is not a reason
        // to make the provider redeliver the whole event.
        console.error('[SocialWebhooks] cloud copy of a relayed post not updated', {
          workspaceId: profile.workspaceId,
          zernioPostId: zernioId((event.detail ?? event.payload) as any, 'post'),
          error: (err as any)?.message ?? err,
        })
      })
    }
    await relayToDesktop(profile, event)
    return { status: 200, body: { ok: true, relayed: profile.localWorkspaceId } }
  }

  // Inbox rows are written only in the workspace's home region. Any region can
  // receive this webhook, and `SocialComment.zernioCommentId` (and the
  // conversation/message provider ids) are unique per region, so two regions
  // importing the same event collide and poison logical replication (SHO-585:
  // both regions imported the same Samsara Instagram comments). A 503 makes
  // Zernio retry into the region that owns the workspace.
  if (!profile.localWorkspaceId) {
    const forward = socialForwardBody(profile, event)
    const routed = await routeToHomeRegion<{ status: number; body: unknown }>(
      profile.workspaceId,
      SOCIAL_APPLY_PATH,
      forward,
    )
    if (routed.outcome === 'unavailable') {
      return {
        status: 503,
        body: { error: { code: 'home_region_unavailable', message: 'This workspace is served from another region right now' } },
      }
    }
    if (routed.outcome === 'forwarded') return routed.data ?? { status: 200, body: { ok: true } }
    return applySocialEvent(forward)
  }
  return applySocialEvent(socialForwardBody(profile, event))
}

/** The event, normalised to the fields `applySocialEvent` reads. */
function socialForwardBody(profile: SocialProfileRow, event: ZernioEvent): ApplySocialEventInput {
  return {
    workspaceId: profile.workspaceId,
    externalId: profile.externalId,
    localWorkspaceId: '',
    eventId: event.id,
    type: event.type,
    account: event.account,
    detail: event.detail,
    payload: event.payload,
  }
}

/** Re-exported so callers get one error shape from this module. */
export { SocialError }
