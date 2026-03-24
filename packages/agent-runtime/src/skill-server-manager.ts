// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Skill Server Manager
 *
 * Manages a per-workspace Hono API server that skills can add endpoints to.
 * The agent authors a Prisma schema + hooks, runs `shogo generate` + `prisma db push`,
 * and this manager keeps the resulting server process alive.
 *
 * Lifecycle:
 *   1. Gateway calls start() — spawns child process if .shogo/server/server.ts exists
 *   2. File watcher detects changes in generated/ — auto-restarts the child
 *   3. Gateway calls stop() on shutdown — kills the child process
 *
 * Modeled on PreviewManager's spawn + ChildProcess pattern.
 */

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync, watch, type FSWatcher, appendFileSync, writeFileSync } from 'fs'

const LOG_PREFIX = 'skill-server'
const DEFAULT_PORT = 4100
const DEFAULT_HEALTH_CHECK_RETRIES = 10
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 500
const RESTART_DEBOUNCE_MS = 1000
const CRASH_BACKOFF_BASE_MS = 1000
const CRASH_BACKOFF_MAX_MS = 30_000
const MAX_CRASH_RESTARTS = 5

export type SkillServerPhase =
  | 'idle'
  | 'starting'
  | 'healthy'
  | 'restarting'
  | 'crashed'
  | 'stopped'

export interface SkillServerManagerConfig {
  workspaceDir: string
  port?: number
  healthCheckRetries?: number
  healthCheckIntervalMs?: number
}

export class SkillServerManager {
  private workspaceDir: string
  private _port: number
  private serverProcess: ChildProcess | null = null
  private _phase: SkillServerPhase = 'idle'
  private watcher: FSWatcher | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private crashCount = 0
  private intentionalStop = false
  private restarting = false
  private serverDir: string
  private healthCheckRetries: number
  private healthCheckIntervalMs: number

  constructor(config: SkillServerManagerConfig) {
    this.workspaceDir = config.workspaceDir
    const envPort = parseInt(process.env.SKILL_SERVER_PORT ?? '', 10)
    this._port = config.port ?? (envPort > 0 ? envPort : DEFAULT_PORT)
    this.serverDir = join(this.workspaceDir, '.shogo', 'server')
    this.healthCheckRetries = config.healthCheckRetries ?? DEFAULT_HEALTH_CHECK_RETRIES
    this.healthCheckIntervalMs = config.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS
  }

  get port(): number {
    return this._port
  }

  get phase(): SkillServerPhase {
    return this._phase
  }

  get isRunning(): boolean {
    return this._phase === 'healthy'
  }

  get url(): string {
    return `http://localhost:${this._port}`
  }

  private get serverEntryPath(): string {
    return join(this.serverDir, 'server.ts')
  }

  private get logPath(): string {
    return join(this.serverDir, '.server.log')
  }

  /**
   * Start the skill server if .shogo/server/server.ts exists.
   * No-op if the entry file doesn't exist or the server is already running.
   */
  async start(): Promise<{ started: boolean; port: number | null }> {
    if (this._phase === 'healthy' || this._phase === 'starting') {
      return { started: true, port: this._port }
    }

    if (!existsSync(this.serverEntryPath)) {
      console.log(`[${LOG_PREFIX}] No server entry at ${this.serverEntryPath} — skipping`)
      return { started: false, port: null }
    }

    this.intentionalStop = false
    this.crashCount = 0
    await this.spawnServer()
    this.startWatcher()

    return { started: this._phase === 'healthy', port: this._phase === 'healthy' ? this._port : null }
  }

  /**
   * Stop the skill server and clean up the file watcher.
   */
  async stop(): Promise<void> {
    this.intentionalStop = true
    this.stopWatcher()

    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }

    await this.killProcess()
    this._phase = 'stopped'
    console.log(`[${LOG_PREFIX}] Stopped`)
  }

  /**
   * Restart the server (stop + start). Used after schema regeneration.
   */
  async restart(): Promise<void> {
    if (!existsSync(this.serverEntryPath)) return

    console.log(`[${LOG_PREFIX}] Restarting...`)
    this._phase = 'restarting'
    this.crashCount = 0
    this.restarting = true
    await this.killProcess()
    this.restarting = false
    await this.spawnServer()
  }

  private async spawnServer(): Promise<void> {
    this._phase = 'starting'
    console.log(`[${LOG_PREFIX}] Spawning server on port ${this._port}...`)

    const proc = spawn('bun', ['run', this.serverEntryPath], {
      cwd: this.serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(this._port),
        DATABASE_URL: `file:${join(this.serverDir, 'skill.db')}`,
        DATABASE_PROVIDER: 'sqlite',
      },
    })

    this.serverProcess = proc

    proc.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      if (line) {
        try { appendFileSync(this.logPath, `[stdout] ${line}\n`) } catch {}
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      if (line) {
        try { appendFileSync(this.logPath, `[stderr] ${line}\n`) } catch {}
      }
    })

    proc.on('exit', (code, signal) => {
      console.log(`[${LOG_PREFIX}] Process exited (code=${code}, signal=${signal})`)
      if (this.serverProcess === proc) {
        this.serverProcess = null
      }

      if (!this.intentionalStop && !this.restarting && this._phase !== 'stopped') {
        this.handleCrash()
      }
    })

    const healthy = await this.waitForHealthy()
    if (healthy) {
      this._phase = 'healthy'
      this.crashCount = 0
      console.log(`[${LOG_PREFIX}] Server healthy on port ${this._port}`)
    } else {
      this._phase = 'crashed'
      console.error(`[${LOG_PREFIX}] Server failed health check after ${this.healthCheckRetries} retries`)
    }
  }

  private async waitForHealthy(): Promise<boolean> {
    for (let i = 0; i < this.healthCheckRetries; i++) {
      await sleep(this.healthCheckIntervalMs)
      try {
        const resp = await fetch(`${this.url}/health`, {
          signal: AbortSignal.timeout(2000),
        })
        if (resp.ok) return true
      } catch {
        // Server not ready yet
      }
    }
    return false
  }

  private handleCrash(): void {
    this.crashCount++
    if (this.crashCount > MAX_CRASH_RESTARTS) {
      console.error(`[${LOG_PREFIX}] Exceeded max crash restarts (${MAX_CRASH_RESTARTS}), giving up`)
      this._phase = 'crashed'
      return
    }

    const backoff = Math.min(CRASH_BACKOFF_BASE_MS * Math.pow(2, this.crashCount - 1), CRASH_BACKOFF_MAX_MS)
    console.log(`[${LOG_PREFIX}] Crash #${this.crashCount}, restarting in ${backoff}ms...`)
    this._phase = 'restarting'

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null
      if (!this.intentionalStop) {
        await this.spawnServer()
      }
    }, backoff)
  }

  private async killProcess(): Promise<void> {
    const proc = this.serverProcess
    if (!proc || proc.killed) {
      this.serverProcess = null
      return
    }

    return new Promise<void>((resolve) => {
      const forceKillTimer = setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL')
        }
        resolve()
      }, 5000)

      proc.once('exit', () => {
        clearTimeout(forceKillTimer)
        resolve()
      })

      proc.kill('SIGTERM')
      this.serverProcess = null
    })
  }

  /**
   * Watch .shogo/server/generated/ for changes and auto-restart.
   * Debounced to avoid rapid restarts during a full regeneration.
   */
  private startWatcher(): void {
    const watchDir = join(this.serverDir, 'generated')
    if (!existsSync(watchDir)) return

    try {
      this.watcher = watch(watchDir, { recursive: true }, (_event, _filename) => {
        if (this.intentionalStop || this._phase === 'stopped') return

        if (this.restartTimer) {
          clearTimeout(this.restartTimer)
        }

        this.restartTimer = setTimeout(async () => {
          this.restartTimer = null
          console.log(`[${LOG_PREFIX}] Generated files changed, restarting...`)
          await this.restart()
        }, RESTART_DEBOUNCE_MS)
      })
    } catch (err: any) {
      console.error(`[${LOG_PREFIX}] Failed to watch ${watchDir}:`, err.message)
    }
  }

  private stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
