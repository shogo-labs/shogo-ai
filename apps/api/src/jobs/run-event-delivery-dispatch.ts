// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Database-backed worker for `EventDelivery` rows.
 *
 * `emitWorkspaceEvent` writes one pending delivery per matching subscription
 * and kicks this worker; a 15s tick also picks up retries and deliveries
 * orphaned by a crashed replica. Each claim is an `updateMany` guarded on the
 * row's current status and attempt count, so only one replica runs it. Only
 * the workspace's home region claims its deliveries.
 *
 * Retries back off 1m, 5m, 30m, 2h; the fifth failed attempt is final. Five
 * consecutive failures across deliveries, or any forbidden/gone outcome,
 * disables the subscription (and its Composio trigger).
 */

import type { WorkspaceEventEnvelope } from '@shogo-ai/sdk/events'
import { redactEventPayload, scopeForEventType } from '@shogo-ai/sdk/events'
import { prisma } from '../lib/prisma'
import { homeRegionWorkspaceWhere } from '../lib/region'
import { DeliveryError, deliverEvent, type DeliverySubscription } from '../services/event-delivery-targets'
import { startLease, type RuntimeManager } from './agent-turn-runner'

const db = prisma as any

const DISPATCH_INTERVAL_MS = 15_000
const DISPATCH_JITTER_MS = 3_000
const BATCH_SIZE = 25
const MAX_CONCURRENT_DELIVERIES = 10
const HEARTBEAT_INTERVAL_MS = 60_000
const STALE_AFTER_MS = 5 * 60_000
const MAX_DELIVERY_MS = 2 * 60 * 60_000
export const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]
export const MAX_DELIVERY_ATTEMPTS = RETRY_BACKOFF_MS.length + 1
export const MAX_CONSECUTIVE_SUBSCRIPTION_FAILURES = 5
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000
const PRUNE_INTERVAL_MS = 6 * 60 * 60_000

const inFlight = new Set<Promise<void>>()
let workerTimer: ReturnType<typeof setInterval> | null = null
let workerRuntimeManager: RuntimeManager | undefined
let workerStarted = false
let kickPending = false
let lastPruneAt = 0

/** Test seam: replaces the retry backoff table (e.g. zeros so retries are due immediately). */
let backoffOverride: number[] | null = null
export function setEventDeliveryBackoff(backoffMs: number[] | null): void {
  backoffOverride = backoffMs
}

function backoffFor(attempt: number): number | null {
  const table = backoffOverride ?? RETRY_BACKOFF_MS
  if (attempt > table.length) return null
  return table[attempt - 1]
}

/** An event the subscription may not see; recorded as `skipped`, not a failure. */
class SkipDelivery extends Error {}

/**
 * Scopes the subscription's owner was granted over event payloads. User-owned
 * subscriptions see everything; app-owned ones see their install's grant.
 */
async function grantedScopesFor(subscription: DeliverySubscription & { ownerKind?: string; installId?: string | null }): Promise<string[] | '*'> {
  if (subscription.ownerKind !== 'app') return '*'
  const { grantedScopesForInstall } = await import('../services/app-install-grants.service')
  const scopes = subscription.installId ? await grantedScopesForInstall(subscription.installId) : null
  if (!scopes) throw new DeliveryError("The app's access to this workspace was revoked", 'gone')
  return scopes
}

async function disableSubscription(sub: { id: string; composioTriggerId: string | null }, reason: string): Promise<void> {
  await db.eventSubscription.update({
    where: { id: sub.id },
    data: { enabled: false, lastError: reason.slice(0, 2_000) },
  }).catch(() => {})
  if (sub.composioTriggerId) {
    const { setComposioTriggerEnabled } = await import('../services/composio-triggers.service')
    await setComposioTriggerEnabled(sub.composioTriggerId, false).catch(() => {})
  }
}

async function notifyOutcome(sub: any, delivery: { id: string }, text: string, failed: boolean): Promise<void> {
  if (!sub.notifyConversationId) return
  const { deliverAgentResult } = await import('../services/conversation-activity')
  await deliverAgentResult({
    workspaceId: sub.workspaceId,
    conversationId: sub.notifyConversationId,
    projectId: sub.target === 'project' ? sub.targetProjectId : null,
    text,
    failed,
    ref: `event-delivery:${delivery.id}`,
    sessionId: sub.chatSessionId,
    threadRootId: sub.notifyThreadRootId,
  }).catch((error: unknown) => {
    console.error(`[EventDelivery] Could not post the outcome of ${delivery.id}:`, error)
  })
}

async function runDelivery(deliveryId: string, runningAt: Date): Promise<void> {
  const delivery = await db.eventDelivery.findUnique({
    where: { id: deliveryId },
    include: { subscription: true, event: true },
  })
  if (!delivery || delivery.status !== 'running') return
  const sub = delivery.subscription
  const event = delivery.event

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new DeliveryError(`Timed out after ${Math.round(MAX_DELIVERY_MS / 60_000)} minutes`, 'retry'))
  }, MAX_DELIVERY_MS)
  ;(timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
  const lease = startLease(
    runningAt,
    async (current, next) => {
      const renewed = await db.eventDelivery.updateMany({
        where: { id: deliveryId, status: 'running', runningAt: current },
        data: { runningAt: next },
      })
      return renewed.count > 0
    },
    () => controller.abort(new DeliveryError('The delivery was reclaimed during the run', 'retry')),
    HEARTBEAT_INTERVAL_MS,
    `event delivery ${deliveryId}`,
  )

  let ok = false
  let skipped = false
  let summary: string | null = null
  let responseStatus: number | null = null
  let failure: DeliveryError | null = null
  try {
    const granted = await grantedScopesFor(sub)
    const needed = scopeForEventType(event.type)
    if (granted !== '*' && needed && !granted.includes(needed)) {
      throw new SkipDelivery(`Skipped: the app was not granted ${needed}`)
    }
    const envelope: WorkspaceEventEnvelope = {
      id: event.id,
      type: event.type,
      version: event.version,
      workspaceId: event.workspaceId,
      occurredAt: new Date(event.occurredAt).toISOString(),
      payload: redactEventPayload(event.type, event.payload, granted),
    }
    const result = await deliverEvent({
      deliveryId,
      subscription: sub,
      envelope,
      signal: controller.signal,
      runtimeManager: workerRuntimeManager,
    })
    ok = true
    summary = result.summary?.slice(0, 8_000) ?? null
    responseStatus = result.responseStatus ?? null
  } catch (error) {
    if (error instanceof SkipDelivery) {
      skipped = true
      summary = error.message
    } else {
      const reason = controller.signal.aborted && controller.signal.reason instanceof DeliveryError
        ? controller.signal.reason
        : error
      failure = reason instanceof DeliveryError
        ? reason
        : new DeliveryError(reason instanceof Error ? reason.message : String(reason), 'retry')
      responseStatus = failure.status ?? null
    }
  } finally {
    clearTimeout(timeout)
  }

  const leaseAt = await lease.release()
  if (lease.lost) return

  if (skipped) {
    await db.eventDelivery.updateMany({
      where: { id: deliveryId, status: 'running', runningAt: leaseAt },
      data: { status: 'skipped', runningAt: null, error: null, summary },
    })
    return
  }

  if (ok) {
    await db.eventDelivery.updateMany({
      where: { id: deliveryId, status: 'running', runningAt: leaseAt },
      data: { status: 'ok', runningAt: null, error: null, summary, responseStatus },
    })
    await db.eventSubscription.update({
      where: { id: sub.id },
      data: { consecutiveFailures: 0, lastDeliveredAt: new Date(), lastError: null },
    }).catch(() => {})
    await notifyOutcome(sub, delivery, summary || `Trigger "${sub.name}" handled ${event.type}.`, false)
    return
  }

  const err = failure!
  const message = err.message.slice(0, 2_000)
  const terminal = err.kind !== 'retry'
  const wait = terminal ? null : backoffFor(delivery.attempts)
  const dead = terminal || wait === null
  await db.eventDelivery.updateMany({
    where: { id: deliveryId, status: 'running', runningAt: leaseAt },
    data: dead
      ? { status: 'dead', runningAt: null, error: message, responseStatus }
      : { status: 'failed', runningAt: null, error: message, responseStatus, nextAttemptAt: new Date(Date.now() + wait!) },
  })
  const failures = sub.consecutiveFailures + 1
  await db.eventSubscription.update({
    where: { id: sub.id },
    data: { consecutiveFailures: failures, lastError: message },
  }).catch(() => {})
  console.error(`[EventDelivery] ${deliveryId} ${dead ? 'dead' : 'failed'} (attempt ${delivery.attempts}):`, {
    workspaceId: sub.workspaceId,
    subscriptionId: sub.id,
    kind: err.kind,
    error: message,
  })

  if (err.kind === 'forbidden') {
    await disableSubscription(sub, `Disabled: the trigger can no longer run in this workspace${err.status ? ` (HTTP ${err.status})` : ''}. ${message}`)
  } else if (err.kind === 'gone') {
    await disableSubscription(sub, `Disabled: the trigger's target is no longer usable. ${message}`)
  } else if (failures >= MAX_CONSECUTIVE_SUBSCRIPTION_FAILURES) {
    await disableSubscription(sub, `Disabled after ${failures} consecutive failed deliveries. Last error: ${message}`)
  }
  if (dead) await notifyOutcome(sub, delivery, `Trigger "${sub.name}" could not handle ${event.type}: ${message}`, true)
}

function track(run: Promise<void>): void {
  const tracked = run
    .catch((error) => console.error('[EventDelivery] Run crashed:', error))
    .finally(() => inFlight.delete(tracked))
  inFlight.add(tracked)
}

/** Resolves once every delivery started by this process has finished. */
export async function waitForEventDeliveries(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight])
}

async function pruneOldEvents(now: number): Promise<void> {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return
  lastPruneAt = now
  await db.workspaceEvent.deleteMany({ where: { occurredAt: { lt: new Date(now - EVENT_RETENTION_MS) } } }).catch(() => {})
}

/** Claims and starts due deliveries; returns how many were started. */
export async function dispatchDueDeliveries(runtimeManager?: RuntimeManager): Promise<number> {
  if (runtimeManager) workerRuntimeManager = runtimeManager
  const now = new Date()
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS)
  const homeFilter = homeRegionWorkspaceWhere()
  const capacity = MAX_CONCURRENT_DELIVERIES - inFlight.size
  if (capacity <= 0) return 0

  const due = await db.eventDelivery.findMany({
    where: {
      OR: [
        { status: { in: ['pending', 'failed'] }, nextAttemptAt: { lte: now } },
        { status: 'running', runningAt: { lt: staleBefore } },
      ],
      subscription: { enabled: true, ...(homeFilter ? { workspace: homeFilter } : {}) },
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    take: Math.min(BATCH_SIZE, capacity),
    select: { id: true, status: true, attempts: true, runningAt: true },
  })

  let started = 0
  for (const row of due) {
    if (inFlight.size >= MAX_CONCURRENT_DELIVERIES) break
    const runningAt = new Date()
    const claimed = await db.eventDelivery.updateMany({
      where: {
        id: row.id,
        status: row.status,
        attempts: row.attempts,
        ...(row.status === 'running' ? { runningAt: row.runningAt } : {}),
      },
      data: { status: 'running', runningAt, attempts: { increment: 1 } },
    })
    if (claimed.count === 0) continue
    started++
    track(runDelivery(row.id, runningAt))
  }
  void pruneOldEvents(now.getTime())
  return started
}

export async function runEventDeliveryDispatch(runtimeManager?: RuntimeManager): Promise<number> {
  return dispatchDueDeliveries(runtimeManager)
}

/** Ask a running worker to look for new deliveries now rather than on its next tick. */
export function kickEventDeliveryWorker(): void {
  if (!workerStarted || kickPending) return
  kickPending = true
  const timer = setTimeout(() => {
    kickPending = false
    void dispatchDueDeliveries().catch((error) => console.error('[EventDelivery] Kick failed:', error))
  }, 50)
  ;(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
}

export function startEventDeliveryWorker(runtimeManager?: RuntimeManager): () => void {
  if (workerTimer) return stopEventDeliveryWorker
  workerRuntimeManager = runtimeManager
  workerStarted = true
  const tick = () => {
    const jitter = setTimeout(() => {
      void dispatchDueDeliveries().catch((error) => console.error('[EventDelivery] Dispatcher tick failed:', error))
    }, Math.random() * DISPATCH_JITTER_MS)
    ;(jitter as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
  }
  tick()
  workerTimer = setInterval(tick, DISPATCH_INTERVAL_MS)
  ;(workerTimer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
  return stopEventDeliveryWorker
}

export function stopEventDeliveryWorker(): void {
  if (workerTimer) clearInterval(workerTimer)
  workerTimer = null
  workerStarted = false
}
