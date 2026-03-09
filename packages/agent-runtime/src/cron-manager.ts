// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cron Manager — Agent-Managed Scheduled Jobs
 *
 * Lets the running agent add, modify, and remove named scheduled jobs at runtime.
 * Jobs are persisted to a JSON file so they survive restarts.
 *
 * Each job has a name, interval, prompt, and optional constraints.
 * When a job fires, it triggers an agent turn with the configured prompt.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

export interface CronJob {
  name: string
  /** Interval in seconds between runs */
  intervalSeconds: number
  /** Prompt sent to the agent when the job fires */
  prompt: string
  /** Whether the job is currently enabled */
  enabled: boolean
  /** When the job was created */
  createdAt: string
  /** When the job last ran */
  lastRunAt?: string
  /** Max consecutive failures before auto-disabling (default: 3) */
  maxFailures?: number
  /** Current consecutive failure count */
  failureCount?: number
}

export interface CronManagerConfig {
  /** Path to persist cron jobs */
  persistPath: string
  /** Callback when a job fires */
  onJobFire: (job: CronJob) => Promise<string>
  /** Max concurrent jobs (default: 5) */
  maxConcurrentJobs?: number
  /** Max total jobs (default: 20) */
  maxJobs?: number
  /** Minimum interval in seconds (default: 60) */
  minIntervalSeconds?: number
}

export interface CronJobResult {
  jobName: string
  response: string
  durationMs: number
  success: boolean
  error?: string
}

const DEFAULT_MAX_CONCURRENT = 5
const DEFAULT_MAX_JOBS = 20
const DEFAULT_MIN_INTERVAL = 60
const DEFAULT_MAX_FAILURES = 3

export class CronManager {
  private jobs: Map<string, CronJob> = new Map()
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map()
  private runningJobs: Set<string> = new Set()
  private config: CronManagerConfig
  private maxConcurrent: number
  private maxJobs: number
  private minInterval: number
  private started = false

  constructor(config: CronManagerConfig) {
    this.config = config
    this.maxConcurrent = config.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT
    this.maxJobs = config.maxJobs ?? DEFAULT_MAX_JOBS
    this.minInterval = config.minIntervalSeconds ?? DEFAULT_MIN_INTERVAL
  }

  /** Load persisted jobs and start their timers */
  start(): void {
    this.loadFromDisk()
    for (const [name, job] of this.jobs) {
      if (job.enabled) {
        this.scheduleJob(job)
      }
    }
    this.started = true
  }

  /** Stop all timers and persist state */
  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer)
    }
    this.timers.clear()
    this.runningJobs.clear()
    this.started = false
    this.saveToDisk()
  }

  /** Add or update a cron job */
  addJob(job: Omit<CronJob, 'createdAt' | 'enabled'> & { enabled?: boolean }): CronJob {
    if (this.jobs.size >= this.maxJobs && !this.jobs.has(job.name)) {
      throw new CronError(`Maximum job limit reached (${this.maxJobs})`)
    }

    if (job.intervalSeconds < this.minInterval) {
      throw new CronError(`Minimum interval is ${this.minInterval} seconds`)
    }

    const existing = this.jobs.get(job.name)
    const cronJob: CronJob = {
      ...job,
      enabled: job.enabled ?? true,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastRunAt: existing?.lastRunAt,
      failureCount: existing?.failureCount ?? 0,
      maxFailures: job.maxFailures ?? DEFAULT_MAX_FAILURES,
    }

    // Stop existing timer if updating
    this.stopJobTimer(job.name)

    this.jobs.set(job.name, cronJob)

    if (cronJob.enabled && this.started) {
      this.scheduleJob(cronJob)
    }

    this.saveToDisk()
    return cronJob
  }

  /** Remove a job by name */
  removeJob(name: string): boolean {
    this.stopJobTimer(name)
    const removed = this.jobs.delete(name)
    if (removed) {
      this.saveToDisk()
    }
    return removed
  }

  /** Enable a job */
  enableJob(name: string): boolean {
    const job = this.jobs.get(name)
    if (!job) return false
    job.enabled = true
    job.failureCount = 0
    if (this.started) {
      this.scheduleJob(job)
    }
    this.saveToDisk()
    return true
  }

  /** Disable a job */
  disableJob(name: string): boolean {
    const job = this.jobs.get(name)
    if (!job) return false
    job.enabled = false
    this.stopJobTimer(name)
    this.saveToDisk()
    return true
  }

  /** Get a job by name */
  getJob(name: string): CronJob | undefined {
    return this.jobs.get(name)
  }

  /** List all jobs */
  listJobs(): CronJob[] {
    return Array.from(this.jobs.values())
  }

  /** Manually trigger a job */
  async triggerJob(name: string): Promise<CronJobResult> {
    const job = this.jobs.get(name)
    if (!job) throw new CronError(`Job not found: ${name}`)
    return this.executeJob(job)
  }

  /** Get the number of currently running jobs */
  get runningCount(): number {
    return this.runningJobs.size
  }

  /** Check if the manager is started */
  get isStarted(): boolean {
    return this.started
  }

  private scheduleJob(job: CronJob): void {
    const timer = setInterval(async () => {
      if (!job.enabled) return
      if (this.runningJobs.has(job.name)) return // skip if still running
      if (this.runningJobs.size >= this.maxConcurrent) {
        console.log(`[CronManager] Skipping ${job.name}: max concurrent jobs reached`)
        return
      }

      try {
        await this.executeJob(job)
      } catch (err: any) {
        console.error(`[CronManager] Unhandled error in ${job.name}:`, err.message)
      }
    }, job.intervalSeconds * 1000)

    this.timers.set(job.name, timer)
  }

  private async executeJob(job: CronJob): Promise<CronJobResult> {
    this.runningJobs.add(job.name)
    const startTime = Date.now()

    try {
      const response = await this.config.onJobFire(job)
      const duration = Date.now() - startTime

      job.lastRunAt = new Date().toISOString()
      job.failureCount = 0
      this.saveToDisk()

      console.log(`[CronManager] Job ${job.name} completed in ${duration}ms`)

      return {
        jobName: job.name,
        response,
        durationMs: duration,
        success: true,
      }
    } catch (err: any) {
      const duration = Date.now() - startTime
      job.failureCount = (job.failureCount ?? 0) + 1
      job.lastRunAt = new Date().toISOString()

      const maxFailures = job.maxFailures ?? DEFAULT_MAX_FAILURES
      if (job.failureCount >= maxFailures) {
        job.enabled = false
        this.stopJobTimer(job.name)
        console.error(
          `[CronManager] Job ${job.name} auto-disabled after ${maxFailures} consecutive failures`
        )
      }

      this.saveToDisk()

      return {
        jobName: job.name,
        response: '',
        durationMs: duration,
        success: false,
        error: err.message,
      }
    } finally {
      this.runningJobs.delete(job.name)
    }
  }

  private stopJobTimer(name: string): void {
    const timer = this.timers.get(name)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(name)
    }
  }

  private loadFromDisk(): void {
    try {
      if (existsSync(this.config.persistPath)) {
        const raw = JSON.parse(readFileSync(this.config.persistPath, 'utf-8'))
        if (Array.isArray(raw)) {
          for (const job of raw) {
            if (job.name && job.intervalSeconds && job.prompt) {
              this.jobs.set(job.name, job)
            }
          }
          console.log(`[CronManager] Loaded ${this.jobs.size} jobs from disk`)
        }
      }
    } catch (err: any) {
      console.error('[CronManager] Failed to load cron jobs:', err.message)
    }
  }

  private saveToDisk(): void {
    try {
      const dir = dirname(this.config.persistPath)
      mkdirSync(dir, { recursive: true })
      const data = Array.from(this.jobs.values())
      writeFileSync(this.config.persistPath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err: any) {
      console.error('[CronManager] Failed to save cron jobs:', err.message)
    }
  }
}

export class CronError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CronError'
  }
}
