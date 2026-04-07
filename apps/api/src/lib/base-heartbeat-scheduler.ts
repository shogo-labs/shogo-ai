// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Base Heartbeat Scheduler
 *
 * Shared logic for the production (Kubernetes) and local-dev schedulers.
 * Owns the polling lifecycle, circuit breaker, jitter computation, and the
 * fetch-due-then-trigger batch loop. Subclasses only need to implement:
 *
 *   - fetchDueAgents()  — how to query for agents whose heartbeat is due
 *   - triggerAgent()    — how to reach the runtime and fire the trigger
 *   - onSkipQuietHours() — (optional) handle quiet-hours skip for a given agent
 */

import { isInQuietHours } from '../../../../packages/agent-runtime/src/quiet-hours'

export { isInQuietHours }

// ─── Configuration ───────────────────────────────────────────────────────────

export const JITTER_RATIO = 0.1
const MAX_FAILURES = 3
const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000]

export function computeJitter(intervalSeconds: number): number {
  return Math.floor(Math.random() * intervalSeconds * JITTER_RATIO) * 1000
}

// ─── Circuit Breaker ─────────────────────────────────────────────────────────

interface FailureEntry {
  count: number
  backoffUntil: number
}

export class CircuitBreaker {
  private failures = new Map<string, FailureEntry>()

  constructor(private readonly logPrefix: string) {}

  recordFailure(projectId: string): void {
    const entry = this.failures.get(projectId) || { count: 0, backoffUntil: 0 }
    entry.count++
    const delayIdx = Math.min(entry.count - 1, RETRY_DELAYS_MS.length - 1)
    entry.backoffUntil = Date.now() + RETRY_DELAYS_MS[delayIdx]
    this.failures.set(projectId, entry)

    if (entry.count >= MAX_FAILURES) {
      console.error(
        `[${this.logPrefix}] Project ${projectId} hit ${MAX_FAILURES} consecutive failures — backing off for ${RETRY_DELAYS_MS[delayIdx] / 60_000}m`
      )
    }
  }

  clearFailure(projectId: string): void {
    this.failures.delete(projectId)
  }

  isBackedOff(projectId: string): boolean {
    const entry = this.failures.get(projectId)
    if (!entry) return false
    return Date.now() < entry.backoffUntil
  }
}

// ─── DueAgent type ───────────────────────────────────────────────────────────

export interface DueAgent {
  id: string
  projectId: string
  heartbeatInterval: number
  quietHoursStart?: string | null
  quietHoursEnd?: string | null
  quietHoursTimezone?: string | null
}

// ─── Base Scheduler ──────────────────────────────────────────────────────────

export interface BaseSchedulerConfig {
  pollIntervalMs: number
  batchSize: number
  triggerTimeoutMs: number
  logPrefix: string
}

export abstract class BaseHeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private tickInProgress = false
  protected running = false
  protected readonly breaker: CircuitBreaker
  protected readonly config: BaseSchedulerConfig

  constructor(config: BaseSchedulerConfig) {
    this.config = config
    this.breaker = new CircuitBreaker(config.logPrefix)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    console.log(
      `[${this.config.logPrefix}] Starting (poll every ${this.config.pollIntervalMs}ms, batch ${this.config.batchSize})`
    )

    this.timer = setInterval(() => {
      if (this.tickInProgress) return
      this.tick().catch((err) => {
        console.error(`[${this.config.logPrefix}] Tick error:`, err.message)
      })
    }, this.config.pollIntervalMs)
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    console.log(`[${this.config.logPrefix}] Stopped`)
  }

  async tick(): Promise<void> {
    if (!this.running || this.tickInProgress) return
    this.tickInProgress = true

    try {
      await this.runTick()
    } finally {
      this.tickInProgress = false
    }
  }

  /**
   * Override to wrap the tick with instrumentation (e.g. OpenTelemetry span).
   * Default just calls processBatch directly.
   */
  protected async runTick(): Promise<void> {
    await this.processBatch()
  }

  protected async processBatch(): Promise<void> {
    const { prisma } = await import('./prisma')
    const dueAgents = await this.fetchDueAgents()

    if (dueAgents.length === 0) return

    console.log(`[${this.config.logPrefix}] Found ${dueAgents.length} due heartbeat(s)`)

    const triggers: Promise<void>[] = []

    for (const agent of dueAgents) {
      if (this.breaker.isBackedOff(agent.projectId)) continue

      const jitter = computeJitter(agent.heartbeatInterval)

      if (isInQuietHours(agent.quietHoursStart ?? null, agent.quietHoursEnd ?? null, agent.quietHoursTimezone ?? null)) {
        this.onQuietHoursSkip(agent)
        await prisma.agentConfig.update({
          where: { id: agent.id },
          data: {
            nextHeartbeatAt: new Date(Date.now() + agent.heartbeatInterval * 1000 + jitter),
          },
        })
        continue
      }

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

  /** Override to record metrics when a heartbeat is skipped due to quiet hours. */
  protected onQuietHoursSkip(_agent: DueAgent): void {}

  /**
   * Query the database for agents whose heartbeat is due.
   * Cloud uses raw SQL with FOR UPDATE SKIP LOCKED + subscription join.
   * Local uses Prisma findMany without subscription check.
   */
  protected abstract fetchDueAgents(): Promise<DueAgent[]>

  /**
   * Resolve the runtime URL and fire the heartbeat trigger.
   * Cloud resolves via Knative. Local resolves via RuntimeManager.
   */
  protected abstract triggerAgent(projectId: string): Promise<void>
}
