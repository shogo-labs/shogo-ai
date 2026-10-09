// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Heartbeat Scheduler (Production / Kubernetes)
 *
 * Polls the database for agents with due heartbeats, wakes their pods
 * (via the warm pool / Knative), and fires the heartbeat trigger.
 * Claims due rows with UPDATE ... FOR UPDATE SKIP LOCKED so multiple API pods
 * can run the scheduler concurrently without duplicating work.
 *
 * Extends BaseHeartbeatScheduler for shared lifecycle, circuit breaker,
 * jitter, and batch processing logic.
 */

import { trace, metrics } from '@opentelemetry/api'
import {
  BaseHeartbeatScheduler,
  type DueAgent,
} from './base-heartbeat-scheduler'
import type { Prisma } from './prisma'
import type { WorkspaceHomeWhere } from './region'

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

/**
 * Restrict due agents to workspaces homed in this region (the
 * `homeRegionWorkspaceWhere()` ownership rule, alias `w`). Every region runs
 * this scheduler against its own replica of `agent_configs`; without the
 * partition each region claims and triggers every heartbeat, booting a second
 * runtime outside the home region and double-writing `nextHeartbeatAt`.
 */
export function heartbeatHomeRegionFilter(
  P: { sql: typeof Prisma.sql; empty: typeof Prisma.empty },
  home: WorkspaceHomeWhere | null,
): Prisma.Sql {
  if (!home) return P.empty
  if ('OR' in home) {
    const region = home.OR.find((c) => c.homeRegion !== null)?.homeRegion ?? null
    return P.sql`AND (w."homeRegion" = ${region} OR w."homeRegion" IS NULL)`
  }
  return P.sql`AND w."homeRegion" = ${home.homeRegion}`
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
        await this.processBatch()
      } finally {
        span.end()
      }
    })
  }

  protected override onQuietHoursSkip(_agent: DueAgent): void {
    heartbeatsSkippedCounter.add(1)
  }

  protected override onTriggerSuccess(projectId: string): void {
    super.onTriggerSuccess(projectId)
    heartbeatsTriggeredCounter.add(1)
  }

  protected override onTriggerFailure(projectId: string, error?: unknown): void {
    super.onTriggerFailure(projectId, error)
    heartbeatsFailedCounter.add(1)
  }

  /** `fetchDueAgents` advances `nextHeartbeatAt` itself (atomic claim). */
  protected override get claimsOnFetch(): boolean {
    return true
  }

  /**
   * Claim due agents atomically: one statement selects the due rows with
   * `FOR UPDATE SKIP LOCKED` and advances their `nextHeartbeatAt`, so the row
   * lock is held until the new time is committed and concurrent API replicas
   * can never trigger the same project twice. (A bare `SELECT ... FOR UPDATE`
   * outside a transaction releases its lock immediately.)
   *
   * Rows that are enabled but have no `nextHeartbeatAt` are claimed too and
   * flagged `unscheduled`; the base class then skips them instead of firing.
   */
  protected async fetchDueAgents(): Promise<DueAgent[]> {
    const { prisma, Prisma } = await import('./prisma')
    const { homeRegionWorkspaceWhere } = await import('./region')
    const homeFilter = heartbeatHomeRegionFilter(Prisma, homeRegionWorkspaceWhere())

    return prisma.$queryRaw<DueAgent[]>`
      WITH due AS MATERIALIZED (
        SELECT ac."id", (ac."nextHeartbeatAt" IS NULL) AS "unscheduled"
        FROM "agent_configs" ac
        JOIN "projects" p ON p."id" = ac."projectId"
        JOIN "workspaces" w ON w."id" = p."workspaceId"
        JOIN "subscriptions" s ON s."workspaceId" = p."workspaceId"
          AND s."status" IN ('active', 'trialing')
        WHERE ac."heartbeatEnabled" = true
          AND (ac."nextHeartbeatAt" IS NULL OR ac."nextHeartbeatAt" <= NOW())
          ${homeFilter}
        ORDER BY ac."nextHeartbeatAt" ASC NULLS FIRST
        FOR UPDATE OF ac SKIP LOCKED
        LIMIT ${BATCH_SIZE}
      )
      UPDATE "agent_configs" ac
      SET "nextHeartbeatAt" = NOW()
        + (ac."heartbeatInterval" * INTERVAL '1 second')
        + (FLOOR(RANDOM() * ac."heartbeatInterval" * 0.1) * INTERVAL '1 second')
      FROM due
      WHERE ac."id" = due."id"
      RETURNING ac."id", ac."projectId", ac."heartbeatInterval",
                ac."quietHoursStart", ac."quietHoursEnd", ac."quietHoursTimezone",
                due."unscheduled"
    `
  }

  protected async triggerAgent(projectId: string): Promise<void> {
    try {
      const { getProjectPodUrl } = await import('./knative-project-manager')
      const { deriveProjectRuntimeToken } = await import('./project-runtime-token')
      const podUrl = await getProjectPodUrl(projectId)

      const response = await fetch(`${podUrl}/agent/heartbeat/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-runtime-token': await deriveProjectRuntimeToken(projectId),
        },
        // A workspace runtime serves many projects; say which one is due.
        body: JSON.stringify({ projectId }),
        signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => 'unknown')
        // Self-heal "promoted-but-orphaned" pods: heartbeat traffic is
        // always API-internal so a 401 with the missing-auth sentinel
        // is unambiguously a stale assignment — evict on first hit and
        // surface a normal failure for retry.
        const { evictOnSingleMissingAuth } = await import('./warm-pool-self-heal')
        await evictOnSingleMissingAuth(projectId, response.status, body)
        throw new Error(`HTTP ${response.status}: ${body}`)
      }

      this.breaker.clearFailure(projectId)
      this.onTriggerSuccess(projectId)
      console.log(`[HeartbeatScheduler] Triggered heartbeat for ${projectId}`)
    } catch (err: any) {
      this.breaker.recordFailure(projectId)
      this.onTriggerFailure(projectId, err)
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
