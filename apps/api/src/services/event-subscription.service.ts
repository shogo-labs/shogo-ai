// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Create, change and inspect `EventSubscription`s ("triggers"). Shared by the
 * session routes, the runtime's `trigger_*` tools (through the internal
 * mount), and the settings UI.
 *
 * A Composio subscription owns one Composio trigger instance: it is created
 * before the row and deleted with it, and enable/disable is mirrored.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import {
  NATIVE_EVENTS,
  eventTypeMatches,
  getEventDefinition,
  parseComposioEventType,
} from '@shogo-ai/sdk/events'
import { prisma } from '../lib/prisma'
import { encryptSecret } from '../lib/secret-crypto'
import { assertWebhookUrlAllowed, WebhookUrlError } from '../lib/webhook-url-guard'
import {
  ComposioTriggerError,
  composioEntityFor,
  composioTriggersClient,
  createComposioTrigger,
  deleteComposioTrigger,
  listComposioTriggerTypes,
  setComposioTriggerEnabled,
} from './composio-triggers.service'
import { emitWorkspaceEvent } from './workspace-events'

const db = prisma as any

export const MAX_SUBSCRIPTIONS_PER_WORKSPACE = 100
const MAX_FILTER_KEYS = 20
const TARGETS = ['agent', 'project', 'webhook'] as const
const PROJECT_MODES = ['agent', 'hook'] as const

export class EventSubscriptionError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 502 | 503,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'EventSubscriptionError'
  }
}

function invalid(message: string, code = 'invalid_field'): never {
  throw new EventSubscriptionError(400, code, message)
}

/** The row as callers see it; the webhook secret never leaves the server after creation. */
export function serializeSubscription(sub: any) {
  if (!sub) return sub
  const { webhookSecret, ...rest } = sub
  return { ...rest, hasWebhookSecret: !!webhookSecret }
}

function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`
}

/** Exact native type, a native `prefix.*`, or an exact `composio.<toolkit>.<SLUG>`. */
export function validateEventType(eventType: unknown): { eventType: string; source: 'shogo' | 'composio' } {
  if (typeof eventType !== 'string' || !eventType.trim()) invalid('eventType is required', 'invalid_body')
  const type = eventType.trim()
  if (type.startsWith('composio.')) {
    if (type.endsWith('*')) invalid('Composio triggers need an exact event type, e.g. composio.github.GITHUB_STAR_ADDED_EVENT')
    if (!parseComposioEventType(type)) invalid(`${type} is not a valid Composio event type`)
    return { eventType: type, source: 'composio' }
  }
  if (type.endsWith('.*') || type === '*') {
    if (!NATIVE_EVENTS.some((def) => eventTypeMatches(type, def.type))) invalid(`No Shogo event matches ${type}`)
    return { eventType: type, source: 'shogo' }
  }
  if (!getEventDefinition(type)) {
    invalid(`Unknown event type ${type}. Call trigger_types_list for the available types.`)
  }
  return { eventType: type, source: 'shogo' }
}

export function validateFilter(filter: unknown): Record<string, unknown> | null {
  if (filter === undefined || filter === null) return null
  if (typeof filter !== 'object' || Array.isArray(filter)) invalid('filter must be an object of payload path → value')
  const entries = Object.entries(filter as Record<string, unknown>)
  if (entries.length > MAX_FILTER_KEYS) invalid(`filter may have at most ${MAX_FILTER_KEYS} keys`)
  for (const [key, value] of entries) {
    if (!/^[\w-]+(\.[\w-]+)*$/.test(key)) invalid(`filter key "${key}" must be a dot path like member.role`)
    const scalar = (v: unknown) => ['string', 'number', 'boolean'].includes(typeof v)
    if (!(scalar(value) || (Array.isArray(value) && value.length > 0 && value.length <= 50 && value.every(scalar)))) {
      invalid(`filter value for "${key}" must be a string, number, boolean, or a list of them`)
    }
  }
  return entries.length ? (filter as Record<string, unknown>) : null
}

async function validateWebhookUrl(url: unknown): Promise<string> {
  if (typeof url !== 'string' || !url.trim()) invalid('webhookUrl is required for webhook targets')
  try {
    return (await assertWebhookUrlAllowed(url.trim(), { resolve: true })).toString()
  } catch (error) {
    if (error instanceof WebhookUrlError) invalid(error.message)
    throw error
  }
}

async function requireWorkspaceProject(workspaceId: string, projectId: unknown): Promise<string> {
  if (typeof projectId !== 'string' || !projectId) invalid('targetProjectId is required for project targets')
  const project = await db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } })
  if (!project || project.workspaceId !== workspaceId) {
    throw new EventSubscriptionError(404, 'project_not_found', 'That project is not in this workspace')
  }
  return projectId
}

function asComposioError(error: unknown): never {
  if (error instanceof ComposioTriggerError) {
    throw new EventSubscriptionError(error.status as any, error.code, error.message, error.details)
  }
  throw error
}

export interface CreateSubscriptionInput {
  workspaceId: string
  ownerUserId: string
  name: string
  eventType: string
  filter?: unknown
  target?: string
  targetProjectId?: string | null
  targetMode?: string | null
  prompt?: string | null
  notifyConversationId?: string | null
  notifyThreadRootId?: string | null
  webhookUrl?: string | null
  triggerConfig?: Record<string, unknown> | null
  enabled?: boolean
  /** Set by app installs; such subscriptions follow the install's lifecycle. */
  installId?: string | null
}

export async function createSubscription(input: CreateSubscriptionInput): Promise<{ subscription: any; webhookSecret?: string }> {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 200) : ''
  if (!name) invalid('name is required', 'invalid_body')
  const { eventType, source } = validateEventType(input.eventType)
  const filter = validateFilter(input.filter)
  const target = (input.target ?? 'agent') as (typeof TARGETS)[number]
  if (!TARGETS.includes(target)) invalid(`target must be one of ${TARGETS.join(', ')}`)
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim().slice(0, 10_000) : null

  let targetProjectId: string | null = null
  let targetMode: string | null = null
  let webhookUrl: string | null = null
  let webhookSecret: string | null = null
  if (target === 'project') {
    targetProjectId = await requireWorkspaceProject(input.workspaceId, input.targetProjectId)
    targetMode = input.targetMode ?? 'agent'
    if (!PROJECT_MODES.includes(targetMode as any)) invalid(`targetMode must be one of ${PROJECT_MODES.join(', ')}`)
  }
  if (target === 'webhook') {
    webhookUrl = await validateWebhookUrl(input.webhookUrl)
    webhookSecret = newWebhookSecret()
  }
  const runsAgent = target === 'agent' || (target === 'project' && targetMode === 'agent')
  if (runsAgent && !prompt) invalid('prompt is required: say what the agent should do when the event fires', 'invalid_body')

  const count = await db.eventSubscription.count({ where: { workspaceId: input.workspaceId } })
  if (count >= MAX_SUBSCRIPTIONS_PER_WORKSPACE) {
    throw new EventSubscriptionError(409, 'limit_reached', `A workspace can have at most ${MAX_SUBSCRIPTIONS_PER_WORKSPACE} triggers`)
  }

  let composio: Awaited<ReturnType<typeof createComposioTrigger>> | null = null
  if (source === 'composio') {
    composio = await createComposioTrigger({
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      projectId: targetProjectId,
      eventType,
      triggerConfig: input.triggerConfig ?? null,
    }).catch(asComposioError)
  }

  try {
    const subscription = await db.eventSubscription.create({
      data: {
        workspaceId: input.workspaceId,
        name,
        enabled: input.enabled ?? true,
        eventType,
        filter,
        ownerUserId: input.ownerUserId,
        ownerKind: input.installId ? 'app' : 'user',
        installId: input.installId ?? null,
        source,
        composioTriggerSlug: composio?.triggerSlug ?? null,
        composioTriggerId: composio?.triggerId ?? null,
        composioConnectedAccountId: composio?.connectedAccountId ?? null,
        composioEntityId: composio?.entityId ?? null,
        triggerConfig: source === 'composio' ? (input.triggerConfig ?? {}) : null,
        target,
        targetProjectId,
        targetMode,
        prompt,
        notifyConversationId: input.notifyConversationId ?? null,
        notifyThreadRootId: input.notifyThreadRootId ?? null,
        webhookUrl,
        webhookSecret: webhookSecret ? encryptSecret(webhookSecret) : null,
      },
    })
    if (composio && input.enabled === false) await setComposioTriggerEnabled(composio.triggerId, false)
    return { subscription: serializeSubscription(subscription), ...(webhookSecret ? { webhookSecret } : {}) }
  } catch (error) {
    if (composio) await deleteComposioTrigger(composio.triggerId)
    throw error
  }
}

export async function listSubscriptions(workspaceId: string) {
  const rows = await db.eventSubscription.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map(serializeSubscription)
}

export async function getSubscription(workspaceId: string, id: string) {
  const row = await db.eventSubscription.findUnique({ where: { id } })
  return row && row.workspaceId === workspaceId ? row : null
}

export interface UpdateSubscriptionInput {
  name?: string
  enabled?: boolean
  filter?: unknown
  prompt?: string | null
  targetMode?: string
  notifyConversationId?: string | null
  notifyThreadRootId?: string | null
  webhookUrl?: string
  rotateWebhookSecret?: boolean
}

export async function updateSubscription(
  workspaceId: string,
  id: string,
  patch: UpdateSubscriptionInput,
): Promise<{ subscription: any; webhookSecret?: string } | null> {
  const current = await getSubscription(workspaceId, id)
  if (!current) return null
  if (current.ownerKind === 'app' && Object.entries(patch).some(([k, v]) => v !== undefined && k !== 'enabled' && k !== 'name')) {
    throw new EventSubscriptionError(409, 'app_managed', 'This trigger belongs to an installed app; you can only enable, disable or rename it. Uninstall the app to remove it.')
  }
  const data: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) invalid('name must be a non-empty string')
    data.name = patch.name.trim().slice(0, 200)
  }
  if (patch.filter !== undefined) data.filter = validateFilter(patch.filter)
  if (patch.prompt !== undefined) data.prompt = typeof patch.prompt === 'string' ? patch.prompt.trim().slice(0, 10_000) || null : null
  if (patch.targetMode !== undefined) {
    if (current.target !== 'project') invalid('targetMode only applies to project targets')
    if (!PROJECT_MODES.includes(patch.targetMode as any)) invalid(`targetMode must be one of ${PROJECT_MODES.join(', ')}`)
    data.targetMode = patch.targetMode
  }
  const runsAgent = current.target === 'agent' || (current.target === 'project' && (data.targetMode ?? current.targetMode) === 'agent')
  if (runsAgent && 'prompt' in data && !data.prompt) invalid('An agent trigger needs a prompt')
  if (runsAgent && 'targetMode' in data && !(data.prompt ?? current.prompt)) invalid('An agent trigger needs a prompt')
  if (patch.notifyConversationId !== undefined) data.notifyConversationId = patch.notifyConversationId
  if (patch.notifyThreadRootId !== undefined) data.notifyThreadRootId = patch.notifyThreadRootId
  let webhookSecret: string | undefined
  if (patch.webhookUrl !== undefined || patch.rotateWebhookSecret) {
    if (current.target !== 'webhook') invalid('webhookUrl only applies to webhook targets')
    if (patch.webhookUrl !== undefined) data.webhookUrl = await validateWebhookUrl(patch.webhookUrl)
    if (patch.rotateWebhookSecret) {
      webhookSecret = newWebhookSecret()
      data.webhookSecret = encryptSecret(webhookSecret)
    }
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') invalid('enabled must be a boolean')
    data.enabled = patch.enabled
    if (patch.enabled && !current.enabled) {
      data.consecutiveFailures = 0
      data.lastError = null
    }
  }
  const updated = await db.eventSubscription.update({ where: { id }, data })
  if (patch.enabled !== undefined && patch.enabled !== current.enabled) {
    await setComposioTriggerEnabled(current.composioTriggerId, patch.enabled)
  }
  return { subscription: serializeSubscription(updated), ...(webhookSecret ? { webhookSecret } : {}) }
}

export async function deleteSubscription(workspaceId: string, id: string, opts: { allowAppManaged?: boolean } = {}): Promise<boolean> {
  const current = await getSubscription(workspaceId, id)
  if (!current) return false
  if (current.ownerKind === 'app' && !opts.allowAppManaged) {
    throw new EventSubscriptionError(409, 'app_managed', 'This trigger belongs to an installed app. Uninstall the app (or revoke its access) to remove it.')
  }
  await deleteComposioTrigger(current.composioTriggerId)
  await db.eventSubscription.delete({ where: { id } })
  return true
}

/**
 * Fire a synthetic event at one subscription. Uses `payload` when given, else
 * the event's catalog example; Composio payloads wrap `payload` as `data`.
 */
export async function testSubscription(workspaceId: string, id: string, payload?: unknown) {
  const sub = await getSubscription(workspaceId, id)
  if (!sub) return null
  if (!sub.enabled) throw new EventSubscriptionError(409, 'disabled', 'Enable the trigger before testing it')
  let type: string = sub.eventType
  let eventPayload: unknown
  if (sub.source === 'composio') {
    const parsed = parseComposioEventType(sub.eventType)
    eventPayload = {
      toolkit: parsed?.toolkit ?? '',
      triggerSlug: sub.composioTriggerSlug ?? parsed?.triggerSlug ?? '',
      connectedAccountId: sub.composioConnectedAccountId ?? '',
      data: payload ?? {},
      test: true,
    }
  } else {
    const def = NATIVE_EVENTS.find((d) => eventTypeMatches(sub.eventType, d.type))
    if (!def) throw new EventSubscriptionError(400, 'invalid_event', `No Shogo event matches ${sub.eventType}`)
    type = def.type
    eventPayload = payload ?? def.example
  }
  const result = await emitWorkspaceEvent({
    workspaceId,
    type,
    source: sub.source === 'composio' ? 'composio' : 'shogo',
    payload: eventPayload,
    dedupeKey: `test:${randomUUID()}`,
    subscriptionIds: [sub.id],
  })
  if (!result) throw new EventSubscriptionError(400, 'invalid_payload', `The test payload is not a valid ${type} payload`)
  if (result.deliveries === 0) {
    throw new EventSubscriptionError(409, 'filtered', "The test event didn't pass this trigger's filter")
  }
  const delivery = await db.eventDelivery.findFirst({
    where: { subscriptionId: sub.id, eventId: result.eventId },
    select: { id: true, status: true },
  })
  return { eventId: result.eventId, type, delivery }
}

export async function listDeliveries(workspaceId: string, subscriptionId: string, limit = 20) {
  const sub = await getSubscription(workspaceId, subscriptionId)
  if (!sub) return null
  return db.eventDelivery.findMany({
    where: { subscriptionId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
    include: { event: { select: { id: true, type: true, occurredAt: true, source: true } } },
  })
}

/** Queue a finished delivery (ok, failed, dead or skipped) to run again now, with a fresh attempt budget. */
export async function redeliver(workspaceId: string, subscriptionId: string, deliveryId: string) {
  const sub = await getSubscription(workspaceId, subscriptionId)
  if (!sub) return null
  if (!sub.enabled) throw new EventSubscriptionError(409, 'disabled', 'Enable the trigger before redelivering to it')
  const delivery = await db.eventDelivery.findFirst({ where: { id: deliveryId, subscriptionId } })
  if (!delivery) return null
  if (delivery.status === 'pending' || delivery.status === 'running') {
    throw new EventSubscriptionError(409, 'in_flight', 'This delivery is still queued or running')
  }
  return db.eventDelivery.update({
    where: { id: deliveryId },
    data: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), runningAt: null, error: null, responseStatus: null, summary: null },
  })
}

/** Shogo events, plus Composio trigger types for the apps `userId` has connected (or `toolkit`). */
export async function listTriggerTypes(workspaceId: string, userId: string, opts: { toolkit?: string | null; projectId?: string | null } = {}) {
  const native = NATIVE_EVENTS.map((def) => ({
    type: def.type,
    version: def.version,
    description: def.description,
    scope: def.scope,
    payload: def.payload,
    example: def.example,
  }))
  if (!composioTriggersClient()) {
    return { native, composio: { available: false, connectedToolkits: [], types: [] } }
  }
  try {
    const entityId = await composioEntityFor(workspaceId, userId, opts.projectId)
    const result = await listComposioTriggerTypes({ entityId, toolkit: opts.toolkit })
    return { native, composio: { available: true, ...result } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { native, composio: { available: true, connectedToolkits: [], types: [], error: message } }
  }
}
