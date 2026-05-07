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

export interface BreakerSnapshotEntry {
  projectId: string
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

  snapshot(): BreakerSnapshotEntry[] {
    const out: BreakerSnapshotEntry[] = []
    for (const [projectId, entry] of this.failures.entries()) {
      out.push({ projectId, count: entry.count, backoffUntil: entry.backoffUntil })
    }
    return out
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

// ─── Scheduler stats ─────────────────────────────────────────────────────────

export interface SchedulerStats {
  running: boolean
  paused: boolean
  startedAt: Date | null
  lastTickAt: Date | null
  lastBatchSize: number
  lastTickDurationMs: number
  totalTicks: number
  totalTriggered: number
  totalFailed: number
  totalQuietSkips: number
  pollIntervalMs: number
  batchSize: number
  triggerTimeoutMs: number
  logPrefix: string
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
  protected paused = false
  protected readonly breaker: CircuitBreaker
  protected readonly config: BaseSchedulerConfig

  // Stats
  protected startedAt: Date | null = null
  protected lastTickAt: Date | null = null
  protected lastBatchSize = 0
  protected lastTickDurationMs = 0
  protected totalTicks = 0
  protected totalTriggered = 0
  protected totalFailed = 0
  protected totalQuietSkips = 0

  constructor(config: BaseSchedulerConfig) {
    this.config = config
    this.breaker = new CircuitBreaker(config.logPrefix)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.startedAt = new Date()

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

  pause(): void {
    if (this.paused) return
    this.paused = true
    console.log(`[${this.config.logPrefix}] Paused (in-memory, this instance only)`)
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    console.log(`[${this.config.logPrefix}] Resumed`)
  }

  isPaused(): boolean {
    return this.paused
  }

  isRunning(): boolean {
    return this.running
  }

  getStats(): SchedulerStats {
    return {
      running: this.running,
      paused: this.paused,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      lastBatchSize: this.lastBatchSize,
      lastTickDurationMs: this.lastTickDurationMs,
      totalTicks: this.totalTicks,
      totalTriggered: this.totalTriggered,
      totalFailed: this.totalFailed,
      totalQuietSkips: this.totalQuietSkips,
      pollIntervalMs: this.config.pollIntervalMs,
      batchSize: this.config.batchSize,
      triggerTimeoutMs: this.config.triggerTimeoutMs,
      logPrefix: this.config.logPrefix,
    }
  }

  getBreakerSnapshot(): BreakerSnapshotEntry[] {
    return this.breaker.snapshot()
  }

  /**
   * Manually fire a heartbeat for a project, bypassing schedule and pause/breaker
   * gating. Used by the super-admin "Trigger now" action. Resolves with `ok: true`
   * if the runtime accepted the trigger, `ok: false` with `error` otherwise.
   */
  async triggerNow(projectId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.triggerAgent(projectId)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  }

  /** Clear circuit-breaker state for a single project. */
  clearFailures(projectId: string): void {
    this.breaker.clearFailure(projectId)
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
    if (this.paused) return

    const tickStart = Date.now()
    const { prisma } = await import('./prisma')
    const dueAgents = await this.fetchDueAgents()

    this.totalTicks++
    this.lastTickAt = new Date()
    this.lastBatchSize = dueAgents.length

    if (dueAgents.length === 0) {
      this.lastTickDurationMs = Date.now() - tickStart
      return
    }

    console.log(`[${this.config.logPrefix}] Found ${dueAgents.length} due heartbeat(s)`)

    const triggers: Promise<void>[] = []

    for (const agent of dueAgents) {
      if (this.breaker.isBackedOff(agent.projectId)) continue

      const jitter = computeJitter(agent.heartbeatInterval)

      if (isInQuietHours(agent.quietHoursStart ?? null, agent.quietHoursEnd ?? null, agent.quietHoursTimezone ?? null)) {
        this.totalQuietSkips++
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
    this.lastTickDurationMs = Date.now() - tickStart
  }

  /** Override to record metrics when a heartbeat is skipped due to quiet hours. */
  protected onQuietHoursSkip(_agent: DueAgent): void {}

  /**
   * Subclasses MUST call this from their triggerAgent on a successful trigger
   * so the scheduler stats stay accurate. Cloud subclass also bumps OTel counters.
   */
  protected onTriggerSuccess(_projectId: string): void {
    this.totalTriggered++
  }

  /**
   * Subclasses MUST call this from their triggerAgent on a failed trigger.
   * Cloud subclass also bumps OTel counters.
   */
  protected onTriggerFailure(_projectId: string, _error?: unknown): void {
    this.totalFailed++
  }

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
