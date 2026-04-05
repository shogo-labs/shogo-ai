// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local Heartbeat Scheduler
 *
 * Simplified version of HeartbeatScheduler for local development.
 * Extends BaseHeartbeatScheduler for shared lifecycle, circuit breaker,
 * jitter, and batch processing logic. Key differences:
 *
 *  - No subscription JOIN (local mode treats all workspaces as paid)
 *  - No FOR UPDATE SKIP LOCKED (single API process, no contention)
 *  - Resolves runtime URLs via RuntimeManager instead of Knative
 *  - No quiet-hours check (columns don't exist in local SQLite schema)
 */

import { BaseHeartbeatScheduler, type DueAgent } from './base-heartbeat-scheduler'

const POLL_INTERVAL_MS = parseInt(process.env.HEARTBEAT_POLL_INTERVAL_MS || '15000', 10)
const BATCH_SIZE = parseInt(process.env.HEARTBEAT_BATCH_SIZE || '5', 10)
const TRIGGER_TIMEOUT_MS = parseInt(process.env.HEARTBEAT_TRIGGER_TIMEOUT_MS || '15000', 10)

export interface IRuntimeStatusProvider {
  status(projectId: string): { agentPort?: number } | null
  start(projectId: string): Promise<{ agentPort?: number }>
}

export class LocalHeartbeatScheduler extends BaseHeartbeatScheduler {
  private runtimeProvider: IRuntimeStatusProvider | null = null

  constructor() {
    super({
      pollIntervalMs: POLL_INTERVAL_MS,
      batchSize: BATCH_SIZE,
      triggerTimeoutMs: TRIGGER_TIMEOUT_MS,
      logPrefix: 'LocalHeartbeat',
    })
  }

  async start(runtimeProvider?: IRuntimeStatusProvider): Promise<void> {
    if (runtimeProvider) this.runtimeProvider = runtimeProvider
    return super.start()
  }

  protected async fetchDueAgents(): Promise<DueAgent[]> {
    const { prisma } = await import('./prisma')

    // Prisma query builder works with both SQLite and Postgres.
    // No subscription check — local mode treats all workspaces as paid.
    return prisma.agentConfig.findMany({
      where: {
        heartbeatEnabled: true,
        nextHeartbeatAt: { lte: new Date() },
      },
      select: {
        id: true,
        projectId: true,
        heartbeatInterval: true,
      },
      orderBy: { nextHeartbeatAt: 'asc' },
      take: BATCH_SIZE,
    })
  }

  protected async triggerAgent(projectId: string): Promise<void> {
    try {
      const { deriveRuntimeToken } = await import('./runtime-token')

      let runtime = this.runtimeProvider?.status(projectId)
      if (!runtime?.agentPort) {
        console.log(`[LocalHeartbeat] Runtime not running for ${projectId}, starting...`)
        try {
          runtime = await this.runtimeProvider?.start(projectId) ?? null
        } catch (err: any) {
          console.error(`[LocalHeartbeat] Failed to start runtime for ${projectId}:`, err.message)
          return
        }
        if (!runtime?.agentPort) {
          console.error(`[LocalHeartbeat] Runtime started but no agentPort for ${projectId}`)
          return
        }
        console.log(`[LocalHeartbeat] Runtime started for ${projectId} on port ${runtime.agentPort}`)
      }

      const podUrl = `http://localhost:${runtime.agentPort}`
      const token = deriveRuntimeToken(projectId)

      const response = await fetch(`${podUrl}/agent/heartbeat/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-runtime-token': token,
        },
        signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => 'unknown')}`)
      }

      this.breaker.clearFailure(projectId)
      console.log(`[LocalHeartbeat] Triggered heartbeat for ${projectId}`)
    } catch (err: any) {
      this.breaker.recordFailure(projectId)
      console.error(`[LocalHeartbeat] Failed to trigger ${projectId}:`, err.message)
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _scheduler: LocalHeartbeatScheduler | null = null

export function getLocalHeartbeatScheduler(): LocalHeartbeatScheduler {
  if (!_scheduler) {
    _scheduler = new LocalHeartbeatScheduler()
  }
  return _scheduler
}

export async function startLocalHeartbeatScheduler(
  runtimeProvider?: IRuntimeStatusProvider
): Promise<LocalHeartbeatScheduler> {
  const scheduler = getLocalHeartbeatScheduler()
  await scheduler.start(runtimeProvider)
  return scheduler
}
