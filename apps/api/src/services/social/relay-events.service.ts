// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Durable delivery of webhooks for a desktop's local scope.
 *
 * The cloud cannot apply one of those events (a local scope has no rows in the
 * cloud), and an in-memory broadcast is not a transport: it is per process and
 * per restart, while the provider has already been told `200` and will never
 * send it again. So the verified event is written down first, and the desktop
 * polls its scopes, applies each row in its own DB and acks it.
 *
 * `dedupeKey` is `zernio:<provider event id>` — the same key the cloud event
 * outbox uses — so a provider retry (Zernio retries 7×) collapses onto the row
 * that already exists instead of delivering twice.
 *
 * A delivery the desktop cannot apply is **not** acked: it keeps its place in
 * the queue, the failure is written down (`attempts`, `lastError`), and after
 * `MAX_ATTEMPTS` it is dead-lettered (`failedAt`) so one poison payload cannot
 * spin forever. That is the difference between "we dropped it silently" and
 * "we tried, and here is why it did not land".
 *
 * Rows do not accumulate forever either: applied rows live through the backfill
 * window (an inbox needs them when a desktop comes back after a few days), and
 * anything else is dropped after `KEEP_UNDELIVERED_DAYS`.
 */

import { prisma } from '../../lib/prisma'

const db = prisma as any

/** Applied rows are kept this long so a reconnecting desktop can backfill. */
export const KEEP_APPLIED_DAYS = 7
/** Undelivered/dead-lettered rows are dropped after this long. */
export const KEEP_UNDELIVERED_DAYS = 30
/** Attempts before a delivery is dead-lettered instead of retried. */
export const MAX_ATTEMPTS = 8

/**
 * How long a failed delivery waits before the queue hands it out again, indexed
 * by the attempt that just failed. A poison payload is retried about nine times
 * over roughly an hour and a half rather than five times in two and a half
 * minutes — long enough for a transient cause (a locked DB, a bad deploy) to
 * clear, and then it is dead-lettered and visible instead of retried for ever.
 */
const RETRY_BACKOFF_MS = [30_000, 30_000, 120_000, 600_000, 1_800_000, 1_800_000, 1_800_000]

export function retryDelayMs(attempts: number): number {
  if (attempts <= 0) return 0
  const index = Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)
  return RETRY_BACKOFF_MS[index]
}

/** True when a row has waited out its backoff and can be handed out again. */
function isDue(row: any, now: number): boolean {
  const attempts = row.attempts ?? 0
  if (attempts === 0) return true
  const lastAttemptAt = row.lastAttemptAt ? new Date(row.lastAttemptAt).getTime() : 0
  if (!lastAttemptAt) return true
  return lastAttemptAt + retryDelayMs(attempts) <= now
}

export interface SocialRelayedEventEnvelope {
  externalId: string
  localWorkspaceId: string
  eventId: string
  type: string
  account?: { zernioAccountId: string; platform: string; username: string } | null
  detail?: unknown
  /** The whole verified payload, so the desktop applies from it, not Zernio. */
  payload?: unknown
  occurredAt: string
}

export interface SocialRelayedEventRow extends SocialRelayedEventEnvelope {
  id: string
  dedupeKey: string
  workspaceId: string
  attempts: number
  appliedAt?: string | null
}

export function relayedEventDedupeKey(eventId: string): string {
  return `zernio:${eventId}`
}

/**
 * Write the delivery down. Must succeed before the provider gets its `200`:
 * throwing here surfaces a 500, which Zernio retries, which is the only way an
 * event survives a failure on our side.
 *
 * A duplicate is not a failure — it means the provider retried something we
 * already hold.
 */
export async function enqueueRelayedEvent(args: {
  workspaceId: string
  envelope: SocialRelayedEventEnvelope
}): Promise<{ id: string; duplicate: boolean }> {
  const { workspaceId, envelope } = args
  const dedupeKey = relayedEventDedupeKey(envelope.eventId)
  try {
    const row = await db.socialRelayedEvent.create({
      data: {
        dedupeKey,
        workspaceId,
        localWorkspaceId: envelope.localWorkspaceId,
        externalId: envelope.externalId,
        eventType: envelope.type,
        eventJson: JSON.stringify(envelope),
        occurredAt: new Date(envelope.occurredAt),
      },
    })
    return { id: row.id, duplicate: false }
  } catch (err: any) {
    if (err?.code !== 'P2002') throw err
    const existing = await db.socialRelayedEvent.findUnique({ where: { dedupeKey } })
    if (!existing) throw err
    return { id: existing.id, duplicate: true }
  }
}

function readEnvelope(row: any): SocialRelayedEventEnvelope {
  try {
    const parsed = JSON.parse(row.eventJson)
    if (parsed && typeof parsed === 'object') return parsed as SocialRelayedEventEnvelope
  } catch {
    // A row we cannot read is still a row we must not lose: fall back to the
    // columns, which carry everything routing needs.
  }
  return {
    externalId: row.externalId,
    localWorkspaceId: row.localWorkspaceId,
    eventId: row.dedupeKey.replace(/^zernio:/, ''),
    type: row.eventType,
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : String(row.occurredAt),
  }
}

/**
 * Deliveries for the caller's workspace — all of its local scopes, or just one
 * when the desktop names it. Scoping by workspace id comes from the caller's
 * key, never from a request parameter.
 *
 * The default is what is still to deliver: unapplied and not dead-lettered.
 * `includeApplied` widens it to the backfill window, which is how a desktop
 * rebuilds an inbox after being offline (see `inbox.service.backfillInbox`).
 */
export async function listRelayedEvents(args: {
  workspaceId: string
  localWorkspaceId?: string
  limit?: number
  includeApplied?: boolean
  /** Only rows received at or after this instant (backfill window). */
  since?: Date
}): Promise<SocialRelayedEventRow[]> {
  const where: Record<string, unknown> = { workspaceId: args.workspaceId }
  if (!args.includeApplied) {
    where.appliedAt = null
    where.failedAt = null
  }
  if (args.since) where.occurredAt = { gte: args.since }
  if (args.localWorkspaceId) where.localWorkspaceId = args.localWorkspaceId
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200)
  const rows = await db.socialRelayedEvent.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    // A row waiting out its backoff is still in the table but not in this page,
    // so fetch deeper than the caller asked for before filtering.
    take: Math.min(limit * 4, 800),
  })
  const now = Date.now()
  return rows
    .filter((row: any) => isDue(row, now))
    .slice(0, limit)
    .map((row: any) => ({
      id: row.id,
      dedupeKey: row.dedupeKey,
      workspaceId: row.workspaceId,
      attempts: row.attempts ?? 0,
      appliedAt: row.appliedAt ? new Date(row.appliedAt).toISOString() : null,
      ...readEnvelope(row),
    }))
}

/**
 * Mark deliveries applied. Only the caller's own workspace can ack, and an id
 * from another tenant is silently not theirs — the count that comes back is
 * what the route reports.
 */
export async function ackRelayedEvents(args: {
  workspaceId: string
  ids: string[]
}): Promise<number> {
  if (args.ids.length === 0) return 0
  const result = await db.socialRelayedEvent.updateMany({
    where: { workspaceId: args.workspaceId, id: { in: args.ids }, appliedAt: null },
    data: { appliedAt: new Date() },
  })
  return result.count
}

export interface RelayedEventFailure {
  id: string
  error: string
}

/**
 * Record deliveries this consumer could not apply. They stay unacked, so the
 * next poll hands them out again — up to `MAX_ATTEMPTS`, after which they are
 * dead-lettered and surfaced instead of silently retried forever.
 *
 * Returns what was dead-lettered now, so the client can say so out loud.
 */
export async function failRelayedEvents(args: {
  workspaceId: string
  failures: RelayedEventFailure[]
}): Promise<{ recorded: number; deadLettered: string[] }> {
  if (args.failures.length === 0) return { recorded: 0, deadLettered: [] }

  const ids = args.failures.map((failure) => failure.id)
  const rows = await db.socialRelayedEvent.findMany({
    where: { workspaceId: args.workspaceId, id: { in: ids }, appliedAt: null },
    select: { id: true, attempts: true, failedAt: true },
  })
  const known = new Map(rows.map((row: any) => [row.id, row]))

  const deadLettered: string[] = []
  let recorded = 0
  for (const failure of args.failures) {
    const row: any = known.get(failure.id)
    // Not ours, already applied, or already dead-lettered: nothing to record.
    if (!row || row.failedAt) continue
    const attempts = (row.attempts ?? 0) + 1
    const dead = attempts >= MAX_ATTEMPTS
    await db.socialRelayedEvent.update({
      where: { id: failure.id },
      data: {
        attempts,
        lastAttemptAt: new Date(),
        lastError: failure.error.slice(0, 1000),
        ...(dead ? { failedAt: new Date() } : {}),
      },
    })
    recorded++
    if (dead) deadLettered.push(failure.id)
  }
  return { recorded, deadLettered }
}

/**
 * Put dead-lettered deliveries back in the queue. A dead letter is not a
 * graveyard: once the cause is fixed (a schema drift, a bad deploy), an operator
 * or the desktop can retry exactly those rows instead of asking the provider to
 * send them again — which it will not do, because it was already told `200`.
 *
 * Only the caller's own workspace, and only rows that are actually
 * dead-lettered; the attempt count restarts so the row gets a full backoff
 * schedule.
 */
export async function requeueRelayedEvents(args: { workspaceId: string; ids: string[] }): Promise<number> {
  if (args.ids.length === 0) return 0
  const result = await db.socialRelayedEvent.updateMany({
    where: { workspaceId: args.workspaceId, id: { in: args.ids }, failedAt: { not: null }, appliedAt: null },
    data: { failedAt: null, attempts: 0, lastAttemptAt: null, lastError: null },
  })
  return result.count
}

/** Deliveries the desktop gave up on, for an operator to look at. */
export async function listDeadLettered(args: {
  workspaceId: string
  limit?: number
}): Promise<SocialRelayedEventRow[]> {
  const rows = await db.socialRelayedEvent.findMany({
    where: { workspaceId: args.workspaceId, failedAt: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(args.limit ?? 20, 1), 100),
  })
  return rows.map((row: any) => ({
    id: row.id,
    dedupeKey: row.dedupeKey,
    workspaceId: row.workspaceId,
    attempts: row.attempts ?? 0,
    appliedAt: null,
    ...readEnvelope(row),
  }))
}

/**
 * Drop rows past their window. Applied rows are kept for the backfill window;
 * anything still undelivered (or dead-lettered) is kept much longer, then
 * dropped — a desktop that never comes back must not leave rows forever.
 */
export async function pruneRelayedEvents(workspaceId: string): Promise<number> {
  const now = Date.now()
  const appliedCutoff = new Date(now - KEEP_APPLIED_DAYS * 86_400_000)
  const undeliveredCutoff = new Date(now - KEEP_UNDELIVERED_DAYS * 86_400_000)
  const result = await db.socialRelayedEvent.deleteMany({
    where: {
      workspaceId,
      OR: [
        { appliedAt: { lt: appliedCutoff } },
        { appliedAt: null, createdAt: { lt: undeliveredCutoff } },
      ],
    },
  })
  return result.count
}
