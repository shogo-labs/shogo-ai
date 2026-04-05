// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Heartbeat Scheduler (Production / Kubernetes)
 *
 * Polls the database for agents with due heartbeats, wakes their pods
 * (via the warm pool / Knative), and fires the heartbeat trigger.
 * Uses SELECT ... FOR UPDATE SKIP LOCKED so multiple API pods can
 * run the scheduler concurrently without duplicating work.
 *
 * Extends BaseHeartbeatScheduler for shared lifecycle, circuit breaker,
 * jitter, and batch processing logic.
 */

import { trace, metrics } from '@opentelemetry/api'
import {
  BaseHeartbeatScheduler,
  isInQuietHours,
  computeJitter,
  type DueAgent,
} from './base-heartbeat-scheduler'

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

const POLL_INTERVAL_MS = parseInt(process.env.HEARTBEAT_POLL_INTERVAL_MS || '30000', 10)
const BATCH_SIZE = parseInt(process.env.HEARTBEAT_BATCH_SIZE || '10', 10)
const TRIGGER_TIMEOUT_MS = parseInt(process.env.HEARTBEAT_TRIGGER_TIMEOUT_MS || '15000', 10)

// ─── Extended DueAgent with quiet-hours fields (Postgres only) ───────────────

interface CloudDueAgent extends DueAgent {
  quietHoursStart: string | null
  quietHoursEnd: string | null
  quietHoursTimezone: string | null
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export class HeartbeatScheduler extends BaseHeartbeatScheduler {
  constructor() {
    super({
      pollIntervalMs: POLL_INTERVAL_MS,
      batchSize: BATCH_SIZE,
      triggerTimeoutMs: TRIGGER_TIMEOUT_MS,
      logPrefix: 'HeartbeatScheduler',
    })
  }

  /** Wrap each tick in an OpenTelemetry span. */
  protected override async runTick(): Promise<void> {
    await tracer.startActiveSpan('heartbeat_scheduler.tick', async (span) => {
      try {
        await this.processBatchWithQuietHours()
      } finally {
        span.end()
      }
    })
  }

  /**
   * Cloud-specific batch processing that adds quiet-hours filtering
   * on top of the base batch loop. We override the entire batch here
   * because the quiet-hours check must happen between fetch and trigger,
   * and the base processBatch doesn't know about quiet hours.
   */
  private async processBatchWithQuietHours(): Promise<void> {
    const { prisma } = await import('./prisma')

    const dueAgents = await this.fetchDueAgentsWithQuietHours()
    if (dueAgents.length === 0) return

    console.log(`[HeartbeatScheduler] Found ${dueAgents.length} due heartbeat(s)`)

    const triggers: Promise<void>[] = []

    for (const agent of dueAgents) {
      if (this.breaker.isBackedOff(agent.projectId)) continue

      if (isInQuietHours(agent.quietHoursStart, agent.quietHoursEnd, agent.quietHoursTimezone)) {
        heartbeatsSkippedCounter.add(1)
        const jitter = computeJitter(agent.heartbeatInterval)
        await prisma.agentConfig.update({
          where: { id: agent.id },
          data: {
            nextHeartbeatAt: new Date(Date.now() + agent.heartbeatInterval * 1000 + jitter),
          },
        })
        continue
      }

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

  private async fetchDueAgentsWithQuietHours(): Promise<CloudDueAgent[]> {
    const { prisma } = await import('./prisma')

    return prisma.$queryRaw<CloudDueAgent[]>`
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
  }

  /** Required by base class but unused — cloud uses processBatchWithQuietHours instead. */
  protected async fetchDueAgents(): Promise<DueAgent[]> {
    return this.fetchDueAgentsWithQuietHours()
  }

  protected async triggerAgent(projectId: string): Promise<void> {
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
      this.breaker.clearFailure(projectId)
      console.log(`[HeartbeatScheduler] Triggered heartbeat for ${projectId}`)
    } catch (err: any) {
      heartbeatsFailedCounter.add(1)
      this.breaker.recordFailure(projectId)
      console.error(`[HeartbeatScheduler] Failed to trigger ${projectId}:`, err.message)
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

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
