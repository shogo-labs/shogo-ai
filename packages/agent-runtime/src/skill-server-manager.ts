// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Skill Server Manager
 *
 * Manages a per-workspace Hono API server that skills can add endpoints to.
 * The agent authors a Prisma schema, and this manager handles the full pipeline:
 *
 *   schema.prisma change detected →
 *     bun install (if needed) →
 *     shogo generate (routes, types, hooks, server, db) →
 *     prisma generate + db push →
 *     spawn/restart server
 *
 * The agent only needs write_file for schema.prisma — everything else is automatic.
 *
 * Lifecycle:
 *   1. Gateway calls start() — if schema.prisma exists, regenerate + spawn
 *   2. File watcher on schema.prisma — auto-regenerates and restarts
 *   3. File watcher on generated/ — restarts the server (for manual edits)
 *   4. Gateway calls stop() on shutdown — kills the child process
 */

import { spawn, execSync, type ChildProcess } from 'child_process'
import { join, resolve, dirname } from 'path'
import { existsSync, watch, mkdirSync, writeFileSync, type FSWatcher, appendFileSync } from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const MONOREPO_ROOT = resolve(__dirname, '../../..')
const SDK_CLI_PATH = join(MONOREPO_ROOT, 'packages', 'sdk', 'bin', 'shogo.ts')

const LOG_PREFIX = 'skill-server'
const DEFAULT_PORT = 4100
const DEFAULT_HEALTH_CHECK_RETRIES = 10
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 500
const RESTART_DEBOUNCE_MS = 1000
const SCHEMA_DEBOUNCE_MS = 2000
const CRASH_BACKOFF_BASE_MS = 1000
const CRASH_BACKOFF_MAX_MS = 30_000
const MAX_CRASH_RESTARTS = 5

export type SkillServerPhase =
  | 'idle'
  | 'starting'
  | 'generating'
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
  private generatedWatcher: FSWatcher | null = null
  private schemaWatcher: FSWatcher | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private schemaTimer: ReturnType<typeof setTimeout> | null = null
  private crashCount = 0
  private intentionalStop = false
  private restarting = false
  private serverDir: string
  private healthCheckRetries: number
  private healthCheckIntervalMs: number
  private _lastGenerateError: string | null = null

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

  get lastGenerateError(): string | null {
    return this._lastGenerateError
  }

  private get schemaPath(): string {
    return join(this.serverDir, 'schema.prisma')
  }

  private get serverEntryPath(): string {
    return join(this.serverDir, 'server.ts')
  }

  private get serverEntryTsxPath(): string {
    return join(this.serverDir, 'server.tsx')
  }

  private get actualServerEntry(): string | null {
    if (existsSync(this.serverEntryPath)) return this.serverEntryPath
    if (existsSync(this.serverEntryTsxPath)) return this.serverEntryTsxPath
    return null
  }

  private get logPath(): string {
    return join(this.serverDir, '.server.log')
  }

  /**
   * Start the skill server. If only schema.prisma exists (no server.ts yet),
   * runs code generation first. Then spawns the server.
   */
  async start(): Promise<{ started: boolean; port: number | null }> {
    if (this._phase === 'healthy' || this._phase === 'starting' || this._phase === 'generating') {
      return { started: true, port: this._port }
    }

    const hasSchema = existsSync(this.schemaPath)
    const hasServer = !!this.actualServerEntry

    if (!hasSchema && !hasServer) {
      console.log(`[${LOG_PREFIX}] No schema or server at ${this.serverDir} — skipping`)
      this.startSchemaWatcher()
      return { started: false, port: null }
    }

    this.intentionalStop = false
    this.crashCount = 0

    if (hasSchema && !hasServer) {
      console.log(`[${LOG_PREFIX}] Schema found but no server.ts — running code generation...`)
      const ok = await this.regenerate()
      if (!ok) {
        console.error(`[${LOG_PREFIX}] Code generation failed, cannot start server`)
        this.startSchemaWatcher()
        return { started: false, port: null }
      }
    }

    if (this.actualServerEntry) {
      await this.spawnServer()
      this.startGeneratedWatcher()
    }
    this.startSchemaWatcher()

    return { started: this.isRunning, port: this.isRunning ? this._port : null }
  }

  /**
   * Stop the skill server and clean up watchers.
   */
  async stop(): Promise<void> {
    this.intentionalStop = true
    this.stopGeneratedWatcher()
    this.stopSchemaWatcher()

    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.schemaTimer) {
      clearTimeout(this.schemaTimer)
      this.schemaTimer = null
    }

    await this.killProcess()
    this._phase = 'stopped'
    console.log(`[${LOG_PREFIX}] Stopped`)
  }

  /**
   * Restart the server (stop + start). Used after schema regeneration.
   */
  async restart(): Promise<void> {
    if (!this.actualServerEntry) return

    console.log(`[${LOG_PREFIX}] Restarting...`)
    this._phase = 'restarting'
    this.crashCount = 0
    this.restarting = true
    await this.killProcess()
    this.restarting = false
    await this.spawnServer()
  }

  /**
   * Full regeneration pipeline:
   * 1. Ensure package.json + bun install
   * 2. Run shogo generate (handles prisma generate, db push, and code gen)
   */
  async regenerate(): Promise<boolean> {
    this._phase = 'generating'
    this._lastGenerateError = null
    console.log(`[${LOG_PREFIX}] Running code generation from schema...`)

    try {
      this.ensurePackageJson()
      this.ensureShogoConfig()
      this.installDeps()
      this.runShogoGenerate()

      this._phase = 'idle'
      console.log(`[${LOG_PREFIX}] Code generation complete`)
      return true
    } catch (err: any) {
      this._lastGenerateError = err.message || String(err)
      console.error(`[${LOG_PREFIX}] Code generation failed:`, this._lastGenerateError)
      this._phase = 'crashed'
      return false
    }
  }

  private ensurePackageJson(): void {
    const pkgPath = join(this.serverDir, 'package.json')
    if (existsSync(pkgPath)) return

    console.log(`[${LOG_PREFIX}] Creating package.json...`)
    writeFileSync(pkgPath, JSON.stringify({
      name: 'skill-server',
      private: true,
      dependencies: {
        'hono': '^4.7.0',
        'prisma': '^7.3.0',
        '@prisma/client': '^7.3.0',
        'prisma-adapter-bun-sqlite': '^0.6.8',
      },
    }, null, 2), 'utf-8')
  }

  private ensureShogoConfig(): void {
    const configPath = join(this.serverDir, 'shogo.config.json')
    if (!existsSync(configPath)) {
      console.log(`[${LOG_PREFIX}] Creating shogo.config.json...`)
      writeFileSync(configPath, JSON.stringify({
        schema: './schema.prisma',
        outputs: [
          { dir: './generated', generate: ['routes', 'hooks', 'types'] },
          {
            dir: '.',
            generate: ['server'],
            serverConfig: {
              routesPath: './generated',
              dbPath: './db',
              port: this._port,
              skipStatic: true,
            },
          },
          { dir: '.', generate: ['db'], dbProvider: 'sqlite' },
        ],
      }, null, 2), 'utf-8')
    }

    const prismaConfigPath = join(this.serverDir, 'prisma.config.ts')
    if (!existsSync(prismaConfigPath)) {
      console.log(`[${LOG_PREFIX}] Creating prisma.config.ts...`)
      writeFileSync(prismaConfigPath, [
        "import { defineConfig } from 'prisma/config'",
        '',
        'export default defineConfig({',
        "  schema: './schema.prisma',",
        '  datasource: {',
        `    url: process.env.DATABASE_URL ?? 'file:./skill.db',`,
        '  },',
        '})',
        '',
      ].join('\n'), 'utf-8')
    }
  }

  private installDeps(): void {
    const nodeModules = join(this.serverDir, 'node_modules')
    if (existsSync(nodeModules)) return

    console.log(`[${LOG_PREFIX}] Installing dependencies...`)
    execSync('bun install', {
      cwd: this.serverDir,
      timeout: 60_000,
      stdio: 'pipe',
      encoding: 'utf-8',
    })
    console.log(`[${LOG_PREFIX}] Dependencies installed`)
  }

  private runShogoGenerate(): void {
    const cliPath = this.resolveSdkCli()
    console.log(`[${LOG_PREFIX}] Running shogo generate via ${cliPath}...`)

    execSync(`bun run ${cliPath} generate`, {
      cwd: this.serverDir,
      timeout: 60_000,
      stdio: 'pipe',
      encoding: 'utf-8',
      env: {
        ...process.env,
        DATABASE_URL: `file:${join(this.serverDir, 'skill.db')}`,
      },
    })
    console.log(`[${LOG_PREFIX}] shogo generate complete`)
  }

  /**
   * Resolve the path to the Shogo SDK CLI.
   * Prefers the local monorepo source, falls back to npx.
   */
  private resolveSdkCli(): string {
    if (existsSync(SDK_CLI_PATH)) {
      return SDK_CLI_PATH
    }

    const localBin = join(this.serverDir, 'node_modules', '.bin', 'shogo')
    if (existsSync(localBin)) {
      return localBin
    }

    return 'npx shogo'
  }

  private async spawnServer(): Promise<void> {
    const entry = this.actualServerEntry
    if (!entry) {
      console.error(`[${LOG_PREFIX}] No server.ts or server.tsx found after generation`)
      this._phase = 'crashed'
      return
    }

    this._phase = 'starting'
    console.log(`[${LOG_PREFIX}] Spawning server on port ${this._port}...`)

    const proc = spawn('bun', ['run', entry], {
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
   * Watch schema.prisma for changes. When the agent modifies the schema,
   * auto-regenerate everything and restart the server.
   */
  private startSchemaWatcher(): void {
    const schemaDir = this.serverDir
    mkdirSync(schemaDir, { recursive: true })

    try {
      this.schemaWatcher = watch(schemaDir, (_event, filename) => {
        if (filename !== 'schema.prisma') return
        if (this.intentionalStop || this._phase === 'stopped' || this._phase === 'generating') return

        if (this.schemaTimer) clearTimeout(this.schemaTimer)

        this.schemaTimer = setTimeout(async () => {
          this.schemaTimer = null
          if (!existsSync(this.schemaPath)) return

          console.log(`[${LOG_PREFIX}] schema.prisma changed, regenerating...`)
          const ok = await this.regenerate()
          if (ok) {
            await this.restart()
          }
        }, SCHEMA_DEBOUNCE_MS)
      })
    } catch (err: any) {
      console.error(`[${LOG_PREFIX}] Failed to watch schema dir:`, err.message)
    }
  }

  private stopSchemaWatcher(): void {
    if (this.schemaWatcher) {
      this.schemaWatcher.close()
      this.schemaWatcher = null
    }
  }

  /**
   * Watch .shogo/server/generated/ for changes and auto-restart.
   * Debounced to avoid rapid restarts during a full regeneration.
   */
  private startGeneratedWatcher(): void {
    const watchDir = join(this.serverDir, 'generated')
    if (!existsSync(watchDir)) return

    try {
      this.generatedWatcher = watch(watchDir, { recursive: true }, (_event, _filename) => {
        if (this.intentionalStop || this._phase === 'stopped' || this._phase === 'generating') return

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

  private stopGeneratedWatcher(): void {
    if (this.generatedWatcher) {
      this.generatedWatcher.close()
      this.generatedWatcher = null
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
