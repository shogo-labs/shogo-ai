// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Preview Manager — Manages Vite dev server for app mode.
 *
 * Lazily started when the agent switches to "app" mode. Handles:
 *   - Vite build --watch for automatic rebuilds
 *   - Static file serving from project/dist/
 *   - Dependency installation (bun install)
 *   - Prisma client generation
 *   - Restart/rebuild on demand
 *
 * Ported from runtime's inline preview logic into a standalone module
 * so the unified runtime can activate it only when needed.
 */

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync } from 'fs'
import { pkg } from '@shogo/shared-runtime'

const LOG_PREFIX = 'preview-manager'
const PREVIEW_PORT = 5173
const BUILD_LOG = '.build.log'

export interface PreviewManagerConfig {
  /** Path to the project/ subdirectory (where package.json lives) */
  projectDir: string
  /** Port for the Hono API process (used by Vite proxy config) */
  runtimePort: number
}

const API_SERVER_PORT = 3001

export type PreviewPhase =
  | 'idle'
  | 'installing'
  | 'generating-prisma'
  | 'pushing-db'
  | 'building'
  | 'starting-api'
  | 'ready'

export class PreviewManager {
  private projectDir: string
  private runtimePort: number
  private buildWatchProcess: ChildProcess | null = null
  private apiServerProcess: ChildProcess | null = null
  private started = false
  private _phase: PreviewPhase = 'idle'

  constructor(config: PreviewManagerConfig) {
    this.projectDir = config.projectDir
    this.runtimePort = config.runtimePort
  }

  get isStarted(): boolean {
    return this.started
  }

  get isRunning(): boolean {
    return this.buildWatchProcess !== null && !this.buildWatchProcess.killed
  }

  get apiServerPort(): number | null {
    return this.apiServerProcess && !this.apiServerProcess.killed ? API_SERVER_PORT : null
  }

  /**
   * Start the preview server (install deps, generate Prisma, start Vite watch).
   * No-op if already started.
   *
   * Optimizations:
   * - If dist/index.html already exists (pre-built in template archive), we mark
   *   the preview as ready immediately so the frontend can render the app, then
   *   run setup tasks (install, prisma, vite watch) in the background.
   * - Skips `bun install` when node_modules/ already exists (pre-installed in archive).
   * - Skips `prisma generate` when the generated client already exists.
   */
  async start(): Promise<{ mode: string; port: number | null; timings: Record<string, number> }> {
    if (this.started) {
      return { mode: 'already-running', port: PREVIEW_PORT, timings: {} }
    }

    const timings: Record<string, number> = {}
    const projectDir = this.projectDir

    if (!existsSync(join(projectDir, 'package.json'))) {
      console.log(`[${LOG_PREFIX}] No package.json in ${projectDir} — skipping preview start`)
      return { mode: 'no-project', port: null, timings }
    }

    const hasPrebuiltDist = existsSync(join(projectDir, 'dist', 'index.html'))

    if (hasPrebuiltDist) {
      console.log(`[${LOG_PREFIX}] Pre-built dist/ found — serving immediately, setup continues in background`)
      this._phase = 'ready'
      this.started = true

      this.backgroundSetup(timings).catch((err) => {
        console.error(`[${LOG_PREFIX}] Background setup failed:`, err.message)
      })

      return { mode: 'prebuilt-dist', port: PREVIEW_PORT, timings }
    }

    await this.runSetupTasks(timings)
    return { mode: this.apiServerProcess ? 'vite-watch+api' : 'vite-watch', port: PREVIEW_PORT, timings }
  }

  private async backgroundSetup(timings: Record<string, number>): Promise<void> {
    const savedPhase = this._phase
    await this.installDepsIfNeeded(timings)
    await this.runPrismaIfNeeded(timings)

    await this.startBuildWatch()
    timings.buildWatch = 0

    await this.startApiServer()
    timings.apiServer = 0

    this._phase = savedPhase

    console.log(`[${LOG_PREFIX}] Background setup complete:`, JSON.stringify(timings))
  }

  private async runSetupTasks(timings: Record<string, number>): Promise<void> {
    await this.installDepsIfNeeded(timings)
    await this.runPrismaIfNeeded(timings)

    this._phase = 'building'
    await this.startBuildWatch()

    this._phase = 'starting-api'
    await this.startApiServer()

    this._phase = 'ready'
    this.started = true
  }

  private async installDepsIfNeeded(timings: Record<string, number>): Promise<void> {
    const projectDir = this.projectDir
    const hasNodeModules = existsSync(join(projectDir, 'node_modules'))

    if (hasNodeModules) {
      console.log(`[${LOG_PREFIX}] node_modules/ exists — skipping bun install`)
      timings.install = 0
      return
    }

    this._phase = 'installing'
    const t0 = Date.now()
    try {
      console.log(`[${LOG_PREFIX}] Installing dependencies...`)
      pkg.installSync(projectDir, { frozen: true })
      timings.install = Date.now() - t0
      console.log(`[${LOG_PREFIX}] Dependencies installed (${timings.install}ms)`)
    } catch (err: any) {
      timings.install = Date.now() - t0
      console.error(`[${LOG_PREFIX}] Dependency install failed:`, err.message)
    }
  }

  private async runPrismaIfNeeded(timings: Record<string, number>): Promise<void> {
    const projectDir = this.projectDir
    const prismaSchema = join(projectDir, 'prisma', 'schema.prisma')
    if (!existsSync(prismaSchema)) return

    const prismaClientPath = join(projectDir, 'node_modules', '.prisma', 'client')
    if (existsSync(prismaClientPath)) {
      console.log(`[${LOG_PREFIX}] Prisma client exists — skipping generate`)
      timings.prisma = 0
    } else {
      this._phase = 'generating-prisma'
      const t1 = Date.now()
      try {
        pkg.prismaGenerate(projectDir)
        timings.prisma = Date.now() - t1
      } catch (err: any) {
        timings.prisma = Date.now() - t1
        console.error(`[${LOG_PREFIX}] Prisma generate failed:`, err.message)
      }
    }

    this._phase = 'pushing-db'
    const devDb = join(projectDir, 'prisma', 'dev.db')
    if (existsSync(devDb)) {
      console.log(`[${LOG_PREFIX}] SQLite db exists — skipping db push`)
      timings.dbPush = 0
      return
    }

    const t2 = Date.now()
    try {
      pkg.prismaDbPush(projectDir, { env: { ...process.env, DATABASE_URL: `file:${devDb}` } as NodeJS.ProcessEnv })
      timings.dbPush = Date.now() - t2
      console.log(`[${LOG_PREFIX}] Prisma db push succeeded (${timings.dbPush}ms)`)
    } catch (err: any) {
      timings.dbPush = Date.now() - t2
      console.error(`[${LOG_PREFIX}] Prisma db push failed:`, err.message?.slice(0, 200))
    }
  }

  /**
   * Stop the preview server and kill the Vite process.
   */
  stop(): void {
    if (this.apiServerProcess) {
      console.log(`[${LOG_PREFIX}] Stopping template API server...`)
      this.apiServerProcess.kill('SIGTERM')
      this.apiServerProcess = null
    }
    if (this.buildWatchProcess) {
      console.log(`[${LOG_PREFIX}] Stopping Vite build watch...`)
      this.buildWatchProcess.kill('SIGTERM')
      this.buildWatchProcess = null
    }
    this.started = false
    this._phase = 'idle'
  }

  /**
   * Restart: stop, reinstall, rebuild.
   */
  async restart(): Promise<{ mode: string; port: number | null; timings: Record<string, number> }> {
    this.stop()
    return this.start()
  }

  get phase(): PreviewPhase {
    return this._phase
  }

  /**
   * Get the current preview status.
   * `running` is true when the preview is serveable — either because a pre-built
   * dist/ exists (started=true immediately) or because vite build --watch is live.
   */
  getStatus(): { running: boolean; port: number | null; projectDir: string; phase: PreviewPhase } {
    const running = this.started && this._phase === 'ready'
    return {
      running,
      port: running ? PREVIEW_PORT : null,
      projectDir: this.projectDir,
      phase: this._phase,
    }
  }

  private async startBuildWatch(): Promise<void> {
    const projectDir = this.projectDir
    const buildLogPath = join(projectDir, BUILD_LOG)

    if (!existsSync(join(projectDir, 'node_modules', '.bin', 'vite'))) {
      console.log(`[${LOG_PREFIX}] Vite not found in node_modules — skipping watch`)
      return
    }

    console.log(`[${LOG_PREFIX}] Starting vite build --watch...`)

    const viteProcess = spawn('node_modules/.bin/vite', ['build', '--watch'], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        VITE_RUNTIME_PORT: String(this.runtimePort),
        VITE_SKILL_SERVER_PORT: process.env.SKILL_SERVER_PORT || '4100',
      },
    })

    this.buildWatchProcess = viteProcess

    viteProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      if (line) {
        appendFileSync(buildLogPath, `[stdout] ${line}\n`)
      }
    })

    viteProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      if (line) {
        appendFileSync(buildLogPath, `[stderr] ${line}\n`)
      }
    })

    viteProcess.on('exit', (code, signal) => {
      console.log(`[${LOG_PREFIX}] Vite build --watch exited (code=${code}, signal=${signal})`)
      if (this.buildWatchProcess === viteProcess) {
        this.buildWatchProcess = null
      }
    })

    // Wait briefly for initial build
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }

  private async startApiServer(): Promise<void> {
    const serverFile = join(this.projectDir, 'server.tsx')
    if (!existsSync(serverFile)) return

    const buildLogPath = join(this.projectDir, BUILD_LOG)
    console.log(`[${LOG_PREFIX}] Starting template API server on port ${API_SERVER_PORT}...`)

    const proc = spawn(pkg.bunBinary, ['run', 'server.tsx'], {
      cwd: this.projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(API_SERVER_PORT),
        DATABASE_URL: `file:${join(this.projectDir, 'prisma', 'dev.db')}`,
      },
    })

    this.apiServerProcess = proc

    proc.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      if (line) appendFileSync(buildLogPath, `[api-stdout] ${line}\n`)
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      if (line) appendFileSync(buildLogPath, `[api-stderr] ${line}\n`)
    })

    proc.on('exit', (code, signal) => {
      console.log(`[${LOG_PREFIX}] Template API server exited (code=${code}, signal=${signal})`)
      if (this.apiServerProcess === proc) this.apiServerProcess = null
    })

    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}
