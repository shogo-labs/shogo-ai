// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Workspace event outbox. Producers call `emitWorkspaceEvent`; it records the
 * event once (per `dedupeKey`) and queues an `EventDelivery` for every enabled
 * subscription that matches. `jobs/run-event-delivery-dispatch.ts` delivers.
 */

import { eventTypeMatches, getEventDefinition, validateEventPayload } from '@shogo-ai/sdk/events'
import { prisma } from '../lib/prisma'

const db = prisma as any

export interface EmitWorkspaceEventInput {
  workspaceId: string
  type: string
  version?: number
  source?: 'shogo' | 'composio'
  payload: unknown
  /** Same key, same event: repeated emits are no-ops. */
  dedupeKey: string
  occurredAt?: Date
  /** Only fan out to these subscriptions (Composio events belong to one). */
  subscriptionIds?: string[]
}

export interface EmitResult {
  eventId: string
  deliveries: number
  duplicate: boolean
}

function valueAtPath(payload: unknown, path: string): unknown {
  let current: any = payload
  for (const key of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/** `{ "member.role": "member" }` or `{ "member.role": ["member", "admin"] }`. */
export function matchesFilter(filter: unknown, payload: unknown): boolean {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return true
  for (const [path, expected] of Object.entries(filter as Record<string, unknown>)) {
    const actual = valueAtPath(payload, path)
    if (Array.isArray(expected)) {
      if (!expected.some((e) => String(e) === String(actual))) return false
    } else if (String(expected) !== String(actual)) {
      return false
    }
  }
  return true
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002'
}

export async function emitWorkspaceEvent(input: EmitWorkspaceEventInput): Promise<EmitResult | null> {
  const def = getEventDefinition(input.type, input.version)
  if (def) {
    const valid = validateEventPayload(def, input.payload)
    if (!valid.ok) {
      console.error(`[WorkspaceEvents] Dropped invalid ${input.type} payload:`, valid.errors.join('; '))
      return null
    }
  }

  const existing = await db.workspaceEvent.findUnique({
    where: { workspaceId_dedupeKey: { workspaceId: input.workspaceId, dedupeKey: input.dedupeKey } },
    select: { id: true },
  })
  if (existing) return { eventId: existing.id, deliveries: 0, duplicate: true }

  let event: { id: string }
  try {
    event = await db.workspaceEvent.create({
      data: {
        workspaceId: input.workspaceId,
        type: input.type,
        version: input.version ?? def?.version ?? 1,
        source: input.source ?? 'shogo',
        payload: input.payload ?? {},
        dedupeKey: input.dedupeKey,
        occurredAt: input.occurredAt ?? new Date(),
      },
      select: { id: true },
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const raced = await db.workspaceEvent.findUnique({
      where: { workspaceId_dedupeKey: { workspaceId: input.workspaceId, dedupeKey: input.dedupeKey } },
      select: { id: true },
    })
    return raced ? { eventId: raced.id, deliveries: 0, duplicate: true } : null
  }

  const subscriptions: Array<{ id: string; eventType: string; filter: unknown }> = await db.eventSubscription.findMany({
    where: {
      workspaceId: input.workspaceId,
      enabled: true,
      ...(input.subscriptionIds ? { id: { in: input.subscriptionIds } } : {}),
    },
    select: { id: true, eventType: true, filter: true },
  })

  let deliveries = 0
  for (const sub of subscriptions) {
    if (!eventTypeMatches(sub.eventType, input.type)) continue
    if (!matchesFilter(sub.filter, input.payload)) continue
    try {
      await db.eventDelivery.create({
        data: { subscriptionId: sub.id, eventId: event.id, workspaceId: input.workspaceId },
      })
      deliveries++
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }
  }

  if (deliveries > 0) {
    void import('../jobs/run-event-delivery-dispatch')
      .then((m) => m.kickEventDeliveryWorker())
      .catch(() => {})
  }
  return { eventId: event.id, deliveries, duplicate: false }
}

/**
 * Every way into a workspace ends here: posts the activity line and emits
 * `member.joined`. Keyed on the membership row, so leaving and rejoining fires
 * again but a retried hook does not.
 */
export async function onWorkspaceMemberJoined(input: {
  workspaceId: string
  userId: string
  memberId: string
  role?: string | null
  source: 'invitation' | 'invite_link'
}): Promise<void> {
  void import('./conversation-activity')
    .then((m) => m.recordMemberJoined(input.workspaceId, input.userId))
    .catch(() => {})
  try {
    const user = await db.user.findUnique({ where: { id: input.userId }, select: { name: true, email: true } })
    await emitWorkspaceEvent({
      workspaceId: input.workspaceId,
      type: 'member.joined',
      source: 'shogo',
      payload: {
        member: {
          userId: input.userId,
          ...(user?.name ? { name: user.name } : {}),
          role: input.role || 'member',
          ...(user?.email ? { email: user.email } : {}),
        },
        source: input.source,
      },
      dedupeKey: `member.joined:${input.memberId}`,
    })
  } catch (error) {
    console.error('[WorkspaceEvents] member.joined emit failed:', error instanceof Error ? error.message : error)
  }
}
