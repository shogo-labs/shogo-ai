// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Heartbeat Scheduler
 *
 * External process that polls the database for agents with due heartbeats,
 * wakes their pods (via the warm pool / Knative), and fires the heartbeat
 * trigger. Uses SELECT ... FOR UPDATE SKIP LOCKED so multiple API pods can
 * run the scheduler concurrently without duplicating work.
 *
 * The agent pod runs the actual heartbeat logic (HEARTBEAT.md, agent turn,
 * alerts) and reports completion back via POST /api/internal/heartbeat/complete.
 */

import { trace, metrics } from '@opentelemetry/api'

const tracer = trace.getTracer('shogo-heartbeat-scheduler')
const meter = metrics.getMeter('shogo-heartbeat-scheduler')

const heartbeatsTriggeredCounter = meter.createCounter('heartbeat_scheduler.triggered', {
  description: 'Total heartbeats triggered by the scheduler',
})
const heartbeatsFailedCounter = meter.createCounter('heartbeat_scheduler.failed', {
  description: 'Total heartbeat trigger failures',
})
const heartbeatsSkippedCounter = meter.createCounter('heartbeat_scheduler.skipped_quiet', {
  description: 'Heartbeats skipped due to quiet hours',
})

// =============================================================================
// Configuration
// =============================================================================

const POLL_INTERVAL_MS = parseInt(process.env.HEARTBEAT_POLL_INTERVAL_MS || '30000', 10)
const BATCH_SIZE = parseInt(process.env.HEARTBEAT_BATCH_SIZE || '10', 10)
const TRIGGER_TIMEOUT_MS = parseInt(process.env.HEARTBEAT_TRIGGER_TIMEOUT_MS || '15000', 10)
const JITTER_RATIO = 0.1
const MAX_FAILURES = 3
const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000]

// =============================================================================
// Quiet Hours Helper
// =============================================================================

function isInQuietHours(
  quietStart: string | null,
  quietEnd: string | null,
  timezone: string | null
): boolean {
  if (!quietStart || !quietEnd) return false

  const now = new Date()
  const tz = timezone || 'UTC'
  let hours: number
  let minutes: number

  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const timeStr = fmt.format(now)
    const [h, m] = timeStr.split(':').map(Number)
    hours = h % 24
    minutes = m
  } catch {
    hours = now.getUTCHours()
    minutes = now.getUTCMinutes()
  }

  const currentTime = hours * 60 + minutes
  const [startH, startM] = quietStart.split(':').map(Number)
  const [endH, endM] = quietEnd.split(':').map(Number)
  const startTime = startH * 60 + startM
  const endTime = endH * 60 + endM

  if (startTime <= endTime) {
    return currentTime >= startTime && currentTime < endTime
  }
  return currentTime >= startTime || currentTime < endTime
}

function computeJitter(intervalSeconds: number): number {
  return Math.floor(Math.random() * intervalSeconds * JITTER_RATIO) * 1000
}

// =============================================================================
// Circuit Breaker (in-memory per-project failure tracking)
// =============================================================================

interface FailureEntry {
  count: number
  backoffUntil: number
}

const failures = new Map<string, FailureEntry>()

function recordFailure(projectId: string): void {
  const entry = failures.get(projectId) || { count: 0, backoffUntil: 0 }
  entry.count++
  const delayIdx = Math.min(entry.count - 1, RETRY_DELAYS_MS.length - 1)
  entry.backoffUntil = Date.now() + RETRY_DELAYS_MS[delayIdx]
  failures.set(projectId, entry)

  if (entry.count >= MAX_FAILURES) {
    console.error(
      `[HeartbeatScheduler] Project ${projectId} hit ${MAX_FAILURES} consecutive failures — backing off for ${RETRY_DELAYS_MS[delayIdx] / 60_000}m`
    )
  }
}

function clearFailure(projectId: string): void {
  failures.delete(projectId)
}

function isBackedOff(projectId: string): boolean {
  const entry = failures.get(projectId)
  if (!entry) return false
  if (Date.now() >= entry.backoffUntil) {
    return false
  }
  return true
}

// =============================================================================
// HeartbeatScheduler
// =============================================================================

export class HeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private tickInProgress = false

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    console.log(
      `[HeartbeatScheduler] Starting (poll every ${POLL_INTERVAL_MS}ms, batch ${BATCH_SIZE})`
    )

    this.timer = setInterval(() => {
      if (this.tickInProgress) return
      this.tick().catch((err) => {
        console.error('[HeartbeatScheduler] Tick error:', err.message)
      })
    }, POLL_INTERVAL_MS)
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    console.log('[HeartbeatScheduler] Stopped')
  }

  async tick(): Promise<void> {
    if (!this.running || this.tickInProgress) return
    this.tickInProgress = true

    try {
      await tracer.startActiveSpan('heartbeat_scheduler.tick', async (span) => {
        try {
          await this.processBatch()
        } finally {
          span.end()
        }
      })
    } finally {
      this.tickInProgress = false
    }
  }

  private async processBatch(): Promise<void> {
    const { prisma } = await import('./prisma')

    // Use raw SQL with FOR UPDATE SKIP LOCKED for multi-pod safety.
    // Atomically select and claim due heartbeats in a single transaction.
    // Only trigger for workspaces with an active paid subscription.
    const dueAgents = await prisma.$queryRaw<Array<{
      id: string
      projectId: string
      heartbeatInterval: number
      quietHoursStart: string | null
      quietHoursEnd: string | null
      quietHoursTimezone: string | null
    }>>`
      SELECT ac."id", ac."projectId", ac."heartbeatInterval",
             ac."quietHoursStart", ac."quietHoursEnd", ac."quietHoursTimezone"
      FROM "agent_configs" ac
      JOIN "projects" p ON p."id" = ac."projectId"
      JOIN "subscriptions" s ON s."workspaceId" = p."workspaceId"
        AND s."status" IN ('active', 'trialing')
      WHERE ac."heartbeatEnabled" = true
        AND ac."nextHeartbeatAt" <= NOW()
      ORDER BY ac."nextHeartbeatAt" ASC
      FOR UPDATE OF ac SKIP LOCKED
      LIMIT ${BATCH_SIZE}
    `

    if (dueAgents.length === 0) return

    console.log(`[HeartbeatScheduler] Found ${dueAgents.length} due heartbeat(s)`)

    const triggers: Promise<void>[] = []

    for (const agent of dueAgents) {
      if (isBackedOff(agent.projectId)) {
        continue
      }

      if (isInQuietHours(agent.quietHoursStart, agent.quietHoursEnd, agent.quietHoursTimezone)) {
        heartbeatsSkippedCounter.add(1)
        // Advance nextHeartbeatAt past quiet hours so we don't re-check every tick
        const jitter = computeJitter(agent.heartbeatInterval)
        await prisma.agentConfig.update({
          where: { id: agent.id },
          data: {
            nextHeartbeatAt: new Date(Date.now() + agent.heartbeatInterval * 1000 + jitter),
          },
        })
        continue
      }

      // Pre-claim: advance nextHeartbeatAt before triggering so other scheduler
      // instances don't pick up the same agent on their next tick.
      const jitter = computeJitter(agent.heartbeatInterval)
      await prisma.agentConfig.update({
        where: { id: agent.id },
        data: {
          nextHeartbeatAt: new Date(Date.now() + agent.heartbeatInterval * 1000 + jitter),
        },
      })

      triggers.push(this.triggerAgent(agent.projectId))
    }

    await Promise.allSettled(triggers)
  }

  private async triggerAgent(projectId: string): Promise<void> {
    try {
      const { getProjectPodUrl } = await import('./knative-project-manager')
      const { deriveRuntimeToken } = await import('./runtime-token')
      const podUrl = await getProjectPodUrl(projectId)

      const response = await fetch(`${podUrl}/agent/heartbeat/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-runtime-token': deriveRuntimeToken(projectId),
        },
        signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => 'unknown')}`)
      }

      heartbeatsTriggeredCounter.add(1)
      clearFailure(projectId)
      console.log(`[HeartbeatScheduler] Triggered heartbeat for ${projectId}`)
    } catch (err: any) {
      heartbeatsFailedCounter.add(1)
      recordFailure(projectId)
      console.error(`[HeartbeatScheduler] Failed to trigger ${projectId}:`, err.message)
    }
  }
}

// =============================================================================
// Singleton
// =============================================================================

let _scheduler: HeartbeatScheduler | null = null

export function getHeartbeatScheduler(): HeartbeatScheduler {
  if (!_scheduler) {
    _scheduler = new HeartbeatScheduler()
  }
  return _scheduler
}

export async function startHeartbeatScheduler(): Promise<HeartbeatScheduler> {
  const scheduler = getHeartbeatScheduler()
  await scheduler.start()
  return scheduler
}
