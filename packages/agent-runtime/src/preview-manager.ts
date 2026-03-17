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
 * Ported from project-runtime's inline preview logic into a standalone module
 * so the unified runtime can activate it only when needed.
 */

import { spawn, type ChildProcess, execSync } from 'child_process'
import { join, resolve } from 'path'
import { existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync } from 'fs'

const LOG_PREFIX = 'preview-manager'
const PREVIEW_PORT = 5173
const BUILD_LOG = '.build.log'

export interface PreviewManagerConfig {
  /** Path to the project/ subdirectory (where package.json lives) */
  projectDir: string
  /** Port for the Hono API process (used by Vite proxy config) */
  runtimePort: number
}

export class PreviewManager {
  private projectDir: string
  private runtimePort: number
  private buildWatchProcess: ChildProcess | null = null
  private started = false

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

  /**
   * Start the preview server (install deps, generate Prisma, start Vite watch).
   * No-op if already started.
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

    // Install dependencies
    const t0 = Date.now()
    try {
      console.log(`[${LOG_PREFIX}] Installing dependencies...`)
      execSync('bun install --frozen-lockfile 2>&1 || bun install 2>&1', {
        cwd: projectDir,
        timeout: 120_000,
        stdio: 'pipe',
      })
      timings.install = Date.now() - t0
      console.log(`[${LOG_PREFIX}] Dependencies installed (${timings.install}ms)`)
    } catch (err: any) {
      timings.install = Date.now() - t0
      console.error(`[${LOG_PREFIX}] Dependency install failed:`, err.message)
    }

    // Generate Prisma client if schema exists
    const prismaSchema = join(projectDir, 'prisma', 'schema.prisma')
    if (existsSync(prismaSchema)) {
      const t1 = Date.now()
      try {
        execSync('bunx prisma generate 2>&1', { cwd: projectDir, timeout: 30_000, stdio: 'pipe' })
        timings.prisma = Date.now() - t1
      } catch (err: any) {
        timings.prisma = Date.now() - t1
        console.error(`[${LOG_PREFIX}] Prisma generate failed:`, err.message)
      }

      // Push schema to SQLite if dev.db doesn't exist
      const devDb = join(projectDir, 'prisma', 'dev.db')
      if (!existsSync(devDb)) {
        try {
          execSync('bunx prisma db push --skip-generate 2>&1', {
            cwd: projectDir,
            timeout: 30_000,
            stdio: 'pipe',
            env: { ...process.env, DATABASE_URL: `file:${devDb}` },
          })
        } catch { /* non-fatal */ }
      }
    }

    // Start Vite build --watch
    await this.startBuildWatch()
    this.started = true

    return { mode: 'vite-watch', port: PREVIEW_PORT, timings }
  }

  /**
   * Stop the preview server and kill the Vite process.
   */
  stop(): void {
    if (this.buildWatchProcess) {
      console.log(`[${LOG_PREFIX}] Stopping Vite build watch...`)
      this.buildWatchProcess.kill('SIGTERM')
      this.buildWatchProcess = null
    }
    this.started = false
  }

  /**
   * Restart: stop, reinstall, rebuild.
   */
  async restart(): Promise<{ mode: string; port: number | null; timings: Record<string, number> }> {
    this.stop()
    return this.start()
  }

  /**
   * Get the current preview status.
   */
  getStatus(): { running: boolean; port: number | null; projectDir: string } {
    return {
      running: this.isRunning,
      port: this.isRunning ? PREVIEW_PORT : null,
      projectDir: this.projectDir,
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
}
