// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `POST /api/webhooks/mail/:provider`: inbound email and delivery events.
 *
 * Any region may get the webhook, but a mailbox's messages are written in its
 * workspace's home region (conversation `seq` and the unique keys collide
 * otherwise), so each workspace's share is forwarded there over
 * `/api/internal/mail/apply`. A 503 asks the provider to retry when that
 * region is down.
 */

import { routeToHomeRegion } from '../../lib/home-region-route'
import { applyDeliveryEvent, ingestInbound, workspaceForProviderMessage, workspacesForInbound } from './mail.service'
import { getMailProvider, MailProviderError, type DeliveryEvent } from './provider'

export const MAIL_FORWARD_PATH = '/api/internal/mail/apply'

export type MailForward =
  | { kind: 'received'; providerMessageId: string; workspaceId: string }
  | { kind: 'delivery'; event: DeliveryEvent }

export async function handleMailWebhook(input: {
  rawBody: string
  header: (name: string) => string | undefined
}): Promise<{ status: 200 | 400 | 401 | 503; body: Record<string, unknown> }> {
  const provider = getMailProvider()
  let event
  try {
    event = provider.parseWebhook(input.rawBody, input.header)
  } catch (err) {
    if (err instanceof MailProviderError && err.status === 503) return { status: 503, body: { error: 'mail_not_configured' } }
    if (err instanceof SyntaxError) return { status: 400, body: { error: 'invalid_json' } }
    return { status: 401, body: { error: 'invalid_signature' } }
  }

  if (event.kind === 'ignored') return { status: 200, body: { ok: true, ignored: event.type } }

  if (event.kind === 'delivery') {
    const workspaceId = await workspaceForProviderMessage(event.event.providerMessageId)
    if (!workspaceId) return { status: 200, body: { ok: true, unknown: true } }
    const forward: MailForward = { kind: 'delivery', event: event.event }
    const { outcome } = await routeToHomeRegion(workspaceId, MAIL_FORWARD_PATH, forward)
    if (outcome === 'unavailable') return { status: 503, body: { error: 'home_region_unavailable' } }
    if (outcome === 'local') await applyDeliveryEvent(event.event)
    return { status: 200, body: { ok: true } }
  }

  let received
  try {
    received = await provider.fetchReceived(event.providerMessageId)
  } catch (err) {
    // The provider will retry the webhook; a missing email is not worth retrying.
    if (err instanceof MailProviderError && err.status === 404) return { status: 200, body: { ok: true, missing: true } }
    return { status: 503, body: { error: 'fetch_failed' } }
  }
  const workspaces = await workspacesForInbound(received)
  let unavailable = false
  for (const workspaceId of workspaces) {
    const forward: MailForward = { kind: 'received', providerMessageId: event.providerMessageId, workspaceId }
    const { outcome } = await routeToHomeRegion(workspaceId, MAIL_FORWARD_PATH, forward)
    if (outcome === 'unavailable') unavailable = true
    if (outcome === 'local') {
      await ingestInbound({ ...received, provider: provider.name, workspaceId })
    }
  }
  // Ingest is idempotent per mailbox and Message-ID, so a retry only fills the gap.
  if (unavailable) return { status: 503, body: { error: 'home_region_unavailable' } }
  return { status: 200, body: { ok: true, workspaces: workspaces.length } }
}

/** The home region's half of a forwarded webhook. */
export async function applyMailForward(body: MailForward): Promise<void> {
  if (body.kind === 'delivery') {
    await applyDeliveryEvent(body.event)
    return
  }
  const provider = getMailProvider()
  const received = await provider.fetchReceived(body.providerMessageId)
  await ingestInbound({ ...received, provider: provider.name, workspaceId: body.workspaceId })
}
