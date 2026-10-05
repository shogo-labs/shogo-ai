// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Composio triggers as a workspace event source.
 *
 * A Composio-backed `EventSubscription` owns one Composio trigger instance,
 * created against the subscription owner's Composio entity (the same
 * `shogo_<user>_<workspace>[_<project>]` id tool calls run as). Composio
 * reports trigger firings to `POST /api/webhooks/composio` (cloud) or over its
 * Pusher channel (`startComposioTriggerListener`, desktop), and both land in
 * `handleIncomingComposioTrigger`, which emits a `composio.<toolkit>.<SLUG>`
 * workspace event for that one subscription.
 */

import { createHash } from 'node:crypto'
import { Composio } from '@composio/core'
import { composioEventType, parseComposioEventType } from '@shogo-ai/sdk/events'
import { prisma } from '../lib/prisma'
import { homeRegionWorkspaceWhere } from '../lib/region'
import { emitWorkspaceEvent } from './workspace-events'
import { actorFromPayload, suggestActorFields } from './event-identity'

const db = prisma as any

export interface ComposioTriggerType {
  slug: string
  name: string
  description: string
  instructions?: string
  toolkit: { slug: string; name: string; logo?: string }
  config: Record<string, unknown>
  payload: Record<string, unknown>
}

/** Normalized trigger firing, as returned by `triggers.verifyWebhook` / `subscribe`. */
export interface IncomingComposioTrigger {
  id: string
  triggerSlug: string
  toolkitSlug?: string
  userId?: string
  payload?: Record<string, unknown>
  metadata?: { id?: string; connectedAccount?: { id?: string } }
}

/** The slice of the Composio SDK this module uses; tests inject a fake. */
export interface ComposioTriggersClient {
  triggers: {
    create(userId: string, slug: string, body?: { connectedAccountId?: string; triggerConfig?: Record<string, unknown> }): Promise<{ triggerId: string }>
    delete(triggerId: string): Promise<unknown>
    disable(triggerId: string): Promise<unknown>
    enable(triggerId: string): Promise<unknown>
    listActive(query?: { triggerIds?: string[]; showDisabled?: boolean; limit?: number }): Promise<{ items: Array<{ id: string; disabledAt?: string | null }> }>
    listTypes(query?: { toolkits?: string[]; limit?: number }): Promise<{ items: ComposioTriggerType[] }>
    getType(slug: string): Promise<ComposioTriggerType>
    verifyWebhook(params: { id: string; payload: string; timestamp: string; signature: string; secret: string; tolerance?: number }): Promise<{ payload: IncomingComposioTrigger }>
    subscribe?(fn: (data: IncomingComposioTrigger) => void, filters?: Record<string, unknown>): Promise<void>
    unsubscribe?(): Promise<void>
  }
  connectedAccounts: {
    list(query: { userIds?: string[]; toolkitSlugs?: string[] }): Promise<unknown>
  }
}

export class ComposioTriggerError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 502 | 503, public code: string, message: string, public details?: Record<string, unknown>) {
    super(message)
    this.name = 'ComposioTriggerError'
  }
}

let clientOverride: ComposioTriggersClient | null | undefined
let realClient: ComposioTriggersClient | null = null

/** Test seam: `null` simulates "Composio not configured", `undefined` restores the real client. */
export function setComposioTriggersClient(client: ComposioTriggersClient | null | undefined): void {
  clientOverride = client
}

export function composioTriggersClient(): ComposioTriggersClient | null {
  if (clientOverride !== undefined) return clientOverride
  if (realClient) return realClient
  const apiKey = process.env.COMPOSIO_API_KEY
  if (!apiKey) return null
  realClient = new Composio({ apiKey, toolkitVersions: 'latest' } as any) as unknown as ComposioTriggersClient
  return realClient
}

function requireClient(): ComposioTriggersClient {
  const client = composioTriggersClient()
  if (!client) throw new ComposioTriggerError(503, 'composio_unavailable', 'Composio is not configured on this server')
  return client
}

function itemsOf(response: unknown): any[] {
  const r = response as { items?: unknown; data?: unknown } | null
  return (Array.isArray(r?.items) ? r!.items : Array.isArray(r?.data) ? r!.data : []) as any[]
}

/** Same entity id `routes/integrations.ts` connects accounts under. */
export async function composioEntityFor(workspaceId: string, userId: string, projectId?: string | null): Promise<string> {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { composioScope: true } })
  return ws?.composioScope === 'project' && projectId
    ? `shogo_${userId}_${workspaceId}_${projectId}`
    : `shogo_${userId}_${workspaceId}`
}

function isActive(account: any): boolean {
  return !account?.status || String(account.status).toUpperCase() === 'ACTIVE'
}

function toolkitOfAccount(account: any): string {
  return String(account?.toolkit?.slug ?? account?.appName ?? account?.app_name ?? '').toLowerCase()
}

export async function connectedToolkits(entityId: string): Promise<Array<{ toolkit: string; connectedAccountId: string }>> {
  const client = composioTriggersClient()
  if (!client) return []
  const accounts = itemsOf(await client.connectedAccounts.list({ userIds: [entityId] }))
  return accounts.filter(isActive).map((a) => ({ toolkit: toolkitOfAccount(a), connectedAccountId: String(a.id) }))
}

export async function findConnectedAccount(entityId: string, toolkit: string): Promise<string | null> {
  const client = requireClient()
  const accounts = itemsOf(await client.connectedAccounts.list({ userIds: [entityId], toolkitSlugs: [toolkit.toLowerCase()] }))
  const match = accounts.find((a) => isActive(a) && (!toolkitOfAccount(a) || toolkitOfAccount(a) === toolkit.toLowerCase()))
  return match ? String(match.id) : null
}

export interface TriggerTypeSummary {
  type: string
  slug: string
  toolkit: string
  name: string
  description: string
  instructions?: string
  config: Record<string, unknown>
  payload: Record<string, unknown>
  /** Payload fields that likely name who did it, for the "acts as" picker. */
  actorFields: { idPaths: string[]; emailPaths: string[] }
}

function summarize(t: ComposioTriggerType): TriggerTypeSummary {
  const toolkit = (t.toolkit?.slug ?? t.slug.split('_')[0] ?? '').toLowerCase()
  return {
    type: composioEventType(toolkit, t.slug),
    slug: t.slug,
    toolkit,
    name: t.name,
    description: t.description,
    ...(t.instructions ? { instructions: t.instructions } : {}),
    config: t.config ?? {},
    payload: t.payload ?? {},
    actorFields: suggestActorFields(t.payload ?? {}),
  }
}

/** Trigger types for `toolkit`, or for every toolkit `entityId` has connected. */
export async function listComposioTriggerTypes(input: { entityId: string; toolkit?: string | null }): Promise<{
  types: TriggerTypeSummary[]
  connectedToolkits: string[]
}> {
  const client = composioTriggersClient()
  if (!client) return { types: [], connectedToolkits: [] }
  const connected = [...new Set((await connectedToolkits(input.entityId)).map((c) => c.toolkit).filter(Boolean))]
  const toolkits = input.toolkit ? [input.toolkit.toLowerCase()] : connected
  if (toolkits.length === 0) return { types: [], connectedToolkits: connected }
  const response = await client.triggers.listTypes({ toolkits, limit: 200 })
  return { types: itemsOf(response).map(summarize), connectedToolkits: connected }
}

export async function getComposioTriggerType(slug: string): Promise<TriggerTypeSummary> {
  return summarize(await requireClient().triggers.getType(slug))
}

/**
 * Create the Composio trigger instance a subscription will own. Throws
 * `needs_connection` (with `toolkit`) when the owner hasn't connected the app.
 */
export async function createComposioTrigger(input: {
  workspaceId: string
  ownerUserId: string
  projectId?: string | null
  eventType: string
  triggerConfig?: Record<string, unknown> | null
}): Promise<{ triggerId: string; triggerSlug: string; entityId: string; connectedAccountId: string }> {
  const parsed = parseComposioEventType(input.eventType)
  if (!parsed) throw new ComposioTriggerError(400, 'invalid_event', `${input.eventType} is not a Composio event type`)
  const client = requireClient()
  const entityId = await composioEntityFor(input.workspaceId, input.ownerUserId, input.projectId)
  const connectedAccountId = await findConnectedAccount(entityId, parsed.toolkit)
  if (!connectedAccountId) {
    throw new ComposioTriggerError(409, 'needs_connection', `Connect ${parsed.toolkit} before creating this trigger`, {
      toolkit: parsed.toolkit,
    })
  }
  try {
    const created = await client.triggers.create(entityId, parsed.triggerSlug, {
      connectedAccountId,
      triggerConfig: input.triggerConfig ?? {},
    })
    return { triggerId: created.triggerId, triggerSlug: parsed.triggerSlug, entityId, connectedAccountId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ComposioTriggerError(502, 'composio_error', `Composio rejected the trigger: ${message}`)
  }
}

async function bestEffort(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (error) {
    console.warn(`[ComposioTriggers] ${what} failed:`, error instanceof Error ? error.message : error)
  }
}

export async function deleteComposioTrigger(triggerId: string | null | undefined): Promise<void> {
  const client = composioTriggersClient()
  if (!triggerId || !client) return
  await bestEffort(`delete ${triggerId}`, () => client.triggers.delete(triggerId))
}

export async function setComposioTriggerEnabled(triggerId: string | null | undefined, enabled: boolean): Promise<void> {
  const client = composioTriggersClient()
  if (!triggerId || !client) return
  await bestEffort(`${enabled ? 'enable' : 'disable'} ${triggerId}`, () =>
    enabled ? client.triggers.enable(triggerId) : client.triggers.disable(triggerId))
}

/**
 * Turn a firing into a workspace event for the subscription that owns the
 * trigger. Unknown triggers are ignored (deleted subscription, other env).
 */
export async function handleIncomingComposioTrigger(
  trigger: IncomingComposioTrigger,
  eventKey: string,
): Promise<{ delivered: boolean; reason?: string }> {
  const triggerId = trigger.metadata?.id || trigger.id
  if (!triggerId) return { delivered: false, reason: 'missing_trigger_id' }
  const sub = await db.eventSubscription.findUnique({
    where: { composioTriggerId: triggerId },
    select: {
      id: true, workspaceId: true, eventType: true, enabled: true, composioTriggerSlug: true,
      actorIdPath: true, actorEmailPath: true,
    },
  })
  if (!sub) return { delivered: false, reason: 'unknown_trigger' }
  if (!sub.enabled) return { delivered: false, reason: 'disabled' }
  const parsed = parseComposioEventType(sub.eventType)
  const toolkit = parsed?.toolkit ?? (trigger.toolkitSlug ?? '').toLowerCase()
  const slug = sub.composioTriggerSlug ?? trigger.triggerSlug
  const actor = actorFromPayload(trigger.payload ?? {}, {
    source: `composio:${toolkit}`,
    idPath: sub.actorIdPath,
    emailPath: sub.actorEmailPath,
  })
  const result = await emitWorkspaceEvent({
    workspaceId: sub.workspaceId,
    type: composioEventType(toolkit, slug),
    source: 'composio',
    payload: {
      toolkit,
      triggerSlug: slug,
      connectedAccountId: trigger.metadata?.connectedAccount?.id ?? null,
      data: trigger.payload ?? {},
    },
    dedupeKey: `composio:${eventKey}`,
    subscriptionIds: [sub.id],
    actor,
  })
  return { delivered: !!result && result.deliveries > 0, reason: result?.duplicate ? 'duplicate' : undefined }
}

/**
 * Verify and route a Composio webhook. Returns the HTTP status to answer
 * with; Composio retries non-2xx, so unknown triggers still get 200.
 */
export async function handleComposioWebhook(input: {
  rawBody: string
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null }
}): Promise<{ status: 200 | 401 | 503; body: Record<string, unknown> }> {
  const secret = process.env.COMPOSIO_WEBHOOK_SECRET
  const client = composioTriggersClient()
  if (!secret || !client) return { status: 503, body: { error: 'composio_webhooks_not_configured' } }
  let trigger: IncomingComposioTrigger
  try {
    const verified = await client.triggers.verifyWebhook({
      id: input.headers.id ?? '',
      timestamp: input.headers.timestamp ?? '',
      signature: input.headers.signature ?? '',
      payload: input.rawBody,
      secret,
    })
    trigger = verified.payload
  } catch (error) {
    console.warn('[ComposioTriggers] Rejected webhook:', error instanceof Error ? error.message : error)
    return { status: 401, body: { error: 'invalid_signature' } }
  }
  const result = await handleIncomingComposioTrigger(trigger, input.headers.id!)
  return { status: 200, body: { ok: true, ...result } }
}

let listening = false

/**
 * Desktop has no public webhook URL, so it listens on Composio's realtime
 * channel instead. Firings carry no event id; the payload hash stands in.
 */
export async function startComposioTriggerListener(): Promise<() => Promise<void>> {
  const client = composioTriggersClient()
  const noop = async () => {}
  if (!client?.triggers.subscribe || listening) return noop
  listening = true
  try {
    await client.triggers.subscribe((data) => {
      const hash = createHash('sha256').update(JSON.stringify(data.payload ?? {})).digest('hex').slice(0, 32)
      void handleIncomingComposioTrigger(data, `rt:${data.metadata?.id || data.id}:${hash}`).catch((error) => {
        console.error('[ComposioTriggers] Realtime trigger failed:', error)
      })
    })
  } catch (error) {
    listening = false
    console.warn('[ComposioTriggers] Realtime subscribe failed:', error instanceof Error ? error.message : error)
    return noop
  }
  return async () => {
    listening = false
    await client.triggers.unsubscribe?.().catch(() => {})
  }
}

/**
 * Disable subscriptions whose Composio account went away. Called from the
 * integrations disconnect route with either the exact account or every
 * account of a toolkit for a set of entities.
 */
export async function disableSubscriptionsForConnections(input: {
  connectedAccountIds?: string[]
  entityIds?: string[]
  toolkit?: string
}): Promise<number> {
  const or: any[] = []
  if (input.connectedAccountIds?.length) or.push({ composioConnectedAccountId: { in: input.connectedAccountIds } })
  if (input.entityIds?.length && input.toolkit) {
    or.push({ composioEntityId: { in: input.entityIds }, eventType: { startsWith: `composio.${input.toolkit.toLowerCase()}.` } })
  }
  if (or.length === 0) return 0
  const subs = await db.eventSubscription.findMany({
    where: { source: 'composio', enabled: true, OR: or },
    select: { id: true, composioTriggerId: true },
  })
  for (const sub of subs) {
    await db.eventSubscription.update({
      where: { id: sub.id },
      data: { enabled: false, lastError: 'Disabled: the connected account was disconnected.' },
    })
    await deleteComposioTrigger(sub.composioTriggerId)
  }
  return subs.length
}

/**
 * Keep Composio and the database in agreement: a trigger that Composio no
 * longer has disables its subscription, and a disabled subscription's
 * trigger is disabled upstream.
 */
export async function reconcileComposioTriggers(): Promise<{ checked: number; disabled: number }> {
  const client = composioTriggersClient()
  if (!client) return { checked: 0, disabled: 0 }
  const homeFilter = homeRegionWorkspaceWhere()
  const subs: Array<{ id: string; enabled: boolean; composioTriggerId: string }> = await db.eventSubscription.findMany({
    where: { source: 'composio', composioTriggerId: { not: null }, ...(homeFilter ? { workspace: homeFilter } : {}) },
    select: { id: true, enabled: true, composioTriggerId: true },
  })
  let disabled = 0
  for (let i = 0; i < subs.length; i += 100) {
    const batch = subs.slice(i, i + 100)
    let upstream: Map<string, { disabledAt?: string | null }>
    try {
      const response = await client.triggers.listActive({ triggerIds: batch.map((s) => s.composioTriggerId), showDisabled: true, limit: 100 })
      upstream = new Map(itemsOf(response).map((item: any) => [String(item.id), item]))
    } catch (error) {
      console.warn('[ComposioTriggers] Reconcile listActive failed:', error instanceof Error ? error.message : error)
      continue
    }
    for (const sub of batch) {
      const remote = upstream.get(sub.composioTriggerId)
      if (!remote && sub.enabled) {
        await db.eventSubscription.update({
          where: { id: sub.id },
          data: { enabled: false, lastError: 'Disabled: the Composio trigger no longer exists.' },
        })
        disabled++
      } else if (remote && !sub.enabled && !remote.disabledAt) {
        await setComposioTriggerEnabled(sub.composioTriggerId, false)
      }
    }
  }
  return { checked: subs.length, disabled }
}

const RECONCILE_INTERVAL_MS = 60 * 60_000
let reconcileTimer: ReturnType<typeof setInterval> | null = null

export function startComposioTriggerReconciler(): () => void {
  if (reconcileTimer || !composioTriggersClient()) return () => {}
  const tick = () => void reconcileComposioTriggers().catch((error) => {
    console.error('[ComposioTriggers] Reconcile failed:', error)
  })
  const first = setTimeout(tick, 60_000)
  ;(first as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
  reconcileTimer = setInterval(tick, RECONCILE_INTERVAL_MS)
  ;(reconcileTimer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
  return () => {
    clearTimeout(first)
    if (reconcileTimer) clearInterval(reconcileTimer)
    reconcileTimer = null
  }
}
