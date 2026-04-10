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

import { execSync, spawn, type ChildProcess } from 'child_process'
import { join, resolve, dirname } from 'path'
import { existsSync, watch, mkdirSync, writeFileSync, readFileSync, cpSync, unlinkSync, type FSWatcher, appendFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { pkg } from '@shogo/shared-runtime'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const MONOREPO_ROOT = resolve(__dirname, '../../..')
const SDK_CLI_PATH = join(MONOREPO_ROOT, 'packages', 'sdk', 'bin', 'shogo.ts')

const LOG_PREFIX = 'skill-server'
const SKILL_SERVER_TEMPLATE = '/app/templates/skill-server'
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
  private pendingSchemaChange = false

  constructor(config: SkillServerManagerConfig) {
    this.workspaceDir = config.workspaceDir
    const envPort = parseInt(process.env.SKILL_SERVER_PORT ?? '', 10)
    this._port = envPort > 0 ? envPort : (config.port ?? DEFAULT_PORT)
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

  /**
   * Return the list of API route paths the server is currently serving,
   * read from the generated routes/index.ts.  Returns [] when no routes
   * have been generated yet.
   */
  getActiveRoutes(): string[] {
    // SDK generates generated/index.tsx (not routes/index.ts)
    const candidates = [
      join(this.serverDir, 'generated', 'index.tsx'),
      join(this.serverDir, 'generated', 'index.ts'),
      join(this.serverDir, 'generated', 'routes', 'index.ts'),
      join(this.serverDir, 'generated', 'routes', 'index.tsx'),
    ]
    const routesIndex = candidates.find(existsSync)
    if (!routesIndex) return []
    try {
      const content = readFileSync(routesIndex, 'utf-8')
      const paths: string[] = []
      // Match: app.route("/clients", createClientRoutes())
      for (const m of content.matchAll(/app\.route\(\s*["']\/([^"']+)["']/g)) {
        paths.push(m[1])
      }
      return paths
    } catch {
      return []
    }
  }

  /**
   * Return the model names from the current schema.prisma.
   */
  getSchemaModels(): string[] {
    if (!existsSync(this.schemaPath)) return []
    try {
      const content = readFileSync(this.schemaPath, 'utf-8')
      const models: string[] = []
      for (const m of content.matchAll(/^model\s+(\w+)\s*\{/gm)) {
        models.push(m[1])
      }
      return models
    } catch {
      return []
    }
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

  private get customRoutesPath(): string {
    return join(this.serverDir, 'custom-routes.ts')
  }

  private get customRoutesTsxPath(): string {
    return join(this.serverDir, 'custom-routes.tsx')
  }

  get hasCustomRoutes(): boolean {
    return existsSync(this.customRoutesPath) || existsSync(this.customRoutesTsxPath)
  }

  private get logPath(): string {
    return join(this.serverDir, '.server.log')
  }

  /**
   * Scaffold `.shogo/server/custom-routes.ts` if it doesn't already exist.
   * Called on startup so the agent can always "edit" the file rather than
   * creating it from scratch.
   */
  private ensureCustomRoutes(): void {
    if (this.hasCustomRoutes) return

    mkdirSync(this.serverDir, { recursive: true })
    const scaffold = [
      "import { Hono } from 'hono'",
      '',
      'const app = new Hono()',
      '',
      '// Add custom API routes here. They are mounted at /api/.',
      '// Example:',
      "//   app.get('/hello', (c) => c.json({ message: 'Hello!' }))",
      '//',
      '// The server auto-restarts when you save this file.',
      '',
      'export default app',
      '',
    ].join('\n')
    writeFileSync(this.customRoutesPath, scaffold, 'utf-8')
    console.log(`[${LOG_PREFIX}] Scaffolded custom-routes.ts`)
  }

  /**
   * Detect a server.tsx from a previous SDK version (missing custom-routes
   * support, dynamic CRUD imports, or Bun.serve) and delete it so the next
   * regenerate() recreates it with the current template.
   */
  private upgradeServerEntryIfNeeded(): void {
    const entry = this.actualServerEntry
    if (!entry) return

    try {
      const content = readFileSync(entry, 'utf-8')
      if (!content.includes('customRoutes')) {
        console.log(`[${LOG_PREFIX}] Detected stale server entry from previous SDK version, removing for regeneration...`)
        unlinkSync(entry)
      }
    } catch {
      // File doesn't exist or can't be read — regenerate will create it
    }
  }

  /**
   * Start the skill server. Always starts — the SDK generates a single smart
   * template that works with or without models (dynamic CRUD imports).
   */
  async start(): Promise<{ started: boolean; port: number | null }> {
    if (this._phase === 'healthy' || this._phase === 'starting' || this._phase === 'generating') {
      return { started: true, port: this._port }
    }

    this.ensureCustomRoutes()
    this.upgradeServerEntryIfNeeded()
    this.intentionalStop = false
    this.crashCount = 0

    if (!this.actualServerEntry) {
      console.log(`[${LOG_PREFIX}] No server entry — running code generation...`)
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
   * Force a full regenerate + restart cycle and block until the server is
   * healthy with the latest schema.  Called by the eval harness before
   * runtime checks to eliminate timing races with the file watcher.
   */
  async sync(): Promise<{ ok: boolean; phase: SkillServerPhase; error?: string }> {
    if (!existsSync(this.schemaPath)) {
      return { ok: false, phase: this._phase, error: 'schema.prisma not found' }
    }

    const content = readFileSync(this.schemaPath, 'utf-8')
    if (!/^model\s+\w+/m.test(content)) {
      return { ok: false, phase: this._phase, error: 'no models in schema' }
    }

    // Take full control: stop all watchers and cancel all pending timers
    this.stopSchemaWatcher()
    this.stopGeneratedWatcher()
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    if (this.schemaTimer) { clearTimeout(this.schemaTimer); this.schemaTimer = null }
    this.pendingSchemaChange = false

    console.log(`[${LOG_PREFIX}] sync() — stopping server, regenerate, then restart...`)

    // Set restarting flag so the exit handler doesn't trigger crash recovery
    this.restarting = true
    this.crashCount = 0
    await this.killProcess()
    await this.forceKillPort()
    this.restarting = false

    const genOk = await this.regenerate()
    if (!genOk) {
      this.startSchemaWatcher()
      return { ok: false, phase: this._phase, error: this._lastGenerateError || 'generation failed' }
    }

    // Start fresh
    await this.spawnServer()

    // Restart watchers for future changes
    this.startGeneratedWatcher()
    this.startSchemaWatcher()

    return { ok: this._phase === 'healthy', phase: this._phase }
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
    this.ensureCustomRoutes()
    await this.killProcess()
    await this.waitForPortRelease()
    await this.spawnServer()
    this.restarting = false
  }

  /**
   * Ensure a minimal schema.prisma exists so `shogo generate` can produce
   * at least the server template. The agent will later fill in models.
   */
  private ensureSchema(): void {
    if (existsSync(this.schemaPath)) return

    mkdirSync(this.serverDir, { recursive: true })
    const minimalSchema = [
      'datasource db {',
      '  provider = "sqlite"',
      '}',
      '',
      'generator client {',
      '  provider = "prisma-client"',
      '  output   = "./generated/prisma"',
      '}',
      '',
      '// Add your models below. Each model gets CRUD routes at /api/{model-name-plural}.',
      '// The skill server auto-regenerates when you save this file.',
      '',
    ].join('\n')
    writeFileSync(this.schemaPath, minimalSchema, 'utf-8')
    console.log(`[${LOG_PREFIX}] Created minimal schema.prisma`)
  }

  /**
   * Full regeneration pipeline:
   * 1. Ensure package.json + bun install
   * 2. Run shogo generate (handles prisma generate, db push, and code gen)
   */
  async regenerate(): Promise<boolean> {
    this._phase = 'generating'
    this._lastGenerateError = null
    console.log(`[${LOG_PREFIX}] Running code generation...`)

    try {
      this.ensureSchema()
      this.sanitizeSchema()
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

  /**
   * Prisma 7.x forbids `url` / `directUrl` inside the datasource block
   * (must be in prisma.config.ts). Agents often write `url = env("DATABASE_URL")`
   * because that was standard in Prisma 6.x.
   * Strip these lines so `prisma generate` and `prisma db push` don't fail with P1012.
   */
  private sanitizeSchema(): void {
    if (!existsSync(this.schemaPath)) return

    const original = readFileSync(this.schemaPath, 'utf-8')
    const sanitized = original.replace(
      /^[ \t]*(url|directUrl)\s*=\s*(env\(["'][^"']*["']\)|"[^"]*")\s*$/gm,
      '',
    )

    if (sanitized !== original) {
      console.log(`[${LOG_PREFIX}] Removed deprecated "url"/"directUrl" from datasource block (Prisma 7 compat)`)
      writeFileSync(this.schemaPath, sanitized, 'utf-8')
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
        'prisma': '7.4.1',
        '@prisma/client': '7.4.1',
        'prisma-adapter-bun-sqlite': '^0.6.8',
      },
    }, null, 2), 'utf-8')
  }

  private ensureShogoConfig(): void {
    const configPath = join(this.serverDir, 'shogo.config.json')

    // Always rewrite the config to pick up the latest port and SDK options.
    console.log(`[${LOG_PREFIX}] Writing shogo.config.json...`)
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
            customRoutesPath: './custom-routes',
            dynamicCrudImport: true,
            bunServe: true,
          },
        },
        { dir: '.', generate: ['db'], dbProvider: 'sqlite' },
      ],
    }, null, 2), 'utf-8')

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

    const templateModules = join(SKILL_SERVER_TEMPLATE, 'node_modules')
    if (existsSync(templateModules)) {
      console.log(`[${LOG_PREFIX}] Copying pre-installed dependencies...`)
      cpSync(templateModules, nodeModules, { recursive: true })
      console.log(`[${LOG_PREFIX}] Dependencies copied from template`)
      return
    }

    console.log(`[${LOG_PREFIX}] Installing dependencies...`)
    pkg.installSync(this.serverDir)
    console.log(`[${LOG_PREFIX}] Dependencies installed`)
  }

  private runShogoGenerate(): void {
    const cliPath = this.resolveSdkCli()
    const start = Date.now()
    console.log(`[${LOG_PREFIX}] Running shogo generate via ${cliPath}...`)

    try {
      const { PORT: _p, RUNTIME_PORT: _rp, ...cleanEnv } = process.env
      const cmd = cliPath.startsWith('/') ? `bun run ${cliPath} generate` : `${pkg.bunBinary} x ${cliPath} generate`
      const output = execSync(cmd, {
        cwd: this.serverDir,
        timeout: 120_000,
        stdio: 'pipe',
        encoding: 'utf-8',
        env: {
          ...cleanEnv,
          DATABASE_URL: `file:${join(this.serverDir, 'skill.db')}`,
        },
      })
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`[${LOG_PREFIX}] shogo generate complete (${elapsed}s)`)
      if (output?.trim()) {
        console.log(`[${LOG_PREFIX}] generate stdout: ${output.trim().slice(0, 500)}`)
      }
    } catch (err: any) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.error(`[${LOG_PREFIX}] shogo generate failed after ${elapsed}s`)
      if (err.stdout) console.error(`[${LOG_PREFIX}] generate stdout: ${String(err.stdout).trim().slice(0, 500)}`)
      if (err.stderr) console.error(`[${LOG_PREFIX}] generate stderr: ${String(err.stderr).trim().slice(0, 500)}`)
      throw err
    }
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

    return 'shogo'
  }

  private async spawnServer(): Promise<void> {
    const entry = this.actualServerEntry
    if (!entry) {
      console.error(`[${LOG_PREFIX}] No server.ts or server.tsx found after generation`)
      this._phase = 'crashed'
      return
    }

    // Ensure node_modules exist before spawning — without them Bun cannot
    // resolve imports and the process immediately crashes in a loop.
    const nodeModules = join(this.serverDir, 'node_modules')
    if (!existsSync(nodeModules)) {
      try {
        this.installDeps()
      } catch (err: any) {
        console.error(`[${LOG_PREFIX}] Dependency install failed, cannot start: ${err.message}`)
        this._phase = 'crashed'
        return
      }
    }

    this._phase = 'starting'
    console.log(`[${LOG_PREFIX}] Spawning server on port ${this._port}...`)

    const proc = spawn(pkg.bunBinary, ['run', entry], {
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
        console.error(`[${LOG_PREFIX}] ${line}`)
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
    if (healthy && this.serverProcess === proc && !proc.killed) {
      this._phase = 'healthy'
      this.crashCount = 0
      console.log(`[${LOG_PREFIX}] Server healthy on port ${this._port}`)
    } else if (!healthy) {
      this._phase = 'crashed'
      console.error(`[${LOG_PREFIX}] Server failed health check after ${this.healthCheckRetries} retries`)
    } else {
      console.error(`[${LOG_PREFIX}] Server process exited before health check completed`)
      this._phase = 'crashed'
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

  private async waitForPortRelease(timeoutMs = 5000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const free = await this.isPortFree()
      if (free) return
      await sleep(250)
    }
    console.warn(`[${LOG_PREFIX}] Port ${this._port} still occupied after ${timeoutMs}ms`)
  }

  private isPortFree(): Promise<boolean> {
    return new Promise((resolve) => {
      const net = require('net') as typeof import('net')
      const tester = net.createServer()
        .once('error', () => resolve(false))
        .once('listening', () => {
          tester.close(() => resolve(true))
        })
        .listen(this._port, '127.0.0.1')
    })
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
        this.ensureCustomRoutes()
        await this.killProcess()
        await this.waitForPortRelease()
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
   * Ensure nothing is listening on our port by force-killing any process
   * that may have leaked (e.g. from a crash handler's orphaned spawn).
   */
  private async forceKillPort(): Promise<void> {
    try {
      const result = execSync(
        `lsof -ti :${this._port} 2>/dev/null || fuser ${this._port}/tcp 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim()
      if (result) {
        const pids = result.split(/\s+/).filter(Boolean)
        for (const pid of pids) {
          try {
            process.kill(Number(pid), 'SIGKILL')
            console.log(`[${LOG_PREFIX}] Force-killed zombie process ${pid} on port ${this._port}`)
          } catch {}
        }
        await this.waitForPortRelease()
      }
    } catch {
      // lsof/fuser may not be available — fall back to waitForPortRelease
      await this.waitForPortRelease()
    }
  }

  /**
   * Watch schema.prisma for changes. When the agent modifies the schema,
   * auto-regenerate everything and restart the server.
   *
   * If a change arrives while we're already generating/restarting, we set
   * pendingSchemaChange so handleSchemaChange() re-runs after the current
   * cycle finishes — no schema writes are silently dropped.
   */
  private startSchemaWatcher(): void {
    const schemaDir = this.serverDir
    mkdirSync(schemaDir, { recursive: true })

    try {
      this.schemaWatcher = watch(schemaDir, (_event, filename) => {
        if (this.intentionalStop || this._phase === 'stopped') return

        if (filename === 'custom-routes.ts' || filename === 'custom-routes.tsx') {
          this.handleCustomRoutesChange()
          return
        }

        if (filename !== 'schema.prisma') return

        if (this._phase === 'generating' || this._phase === 'restarting') {
          this.pendingSchemaChange = true
          return
        }

        if (this.schemaTimer) clearTimeout(this.schemaTimer)
        this.schemaTimer = setTimeout(async () => {
          this.schemaTimer = null
          await this.handleSchemaChange()
        }, SCHEMA_DEBOUNCE_MS)
      })
    } catch (err: any) {
      console.error(`[${LOG_PREFIX}] Failed to watch schema dir:`, err.message)
    }
  }

  private customRoutesTimer: ReturnType<typeof setTimeout> | null = null

  private handleCustomRoutesChange(): void {
    if (this._phase === 'generating' || this._phase === 'restarting') return

    if (this.customRoutesTimer) clearTimeout(this.customRoutesTimer)
    this.customRoutesTimer = setTimeout(async () => {
      this.customRoutesTimer = null
      this.ensureCustomRoutes()
      console.log(`[${LOG_PREFIX}] custom-routes changed, restarting...`)
      if (this._phase === 'healthy') {
        await this.restart()
      }
    }, RESTART_DEBOUNCE_MS)
  }

  private async handleSchemaChange(): Promise<void> {
    if (!existsSync(this.schemaPath)) return

    const content = readFileSync(this.schemaPath, 'utf-8')
    if (!/^model\s+\w+/m.test(content)) {
      console.log(`[${LOG_PREFIX}] schema.prisma changed but has no models yet, skipping...`)
      return
    }

    console.log(`[${LOG_PREFIX}] schema.prisma changed, stopping server before regeneration...`)
    this.pendingSchemaChange = false

    // Cancel any pending crash restart timers
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }

    // Set restarting flag so exit handler doesn't trigger crash recovery
    this.restarting = true
    this.crashCount = 0
    await this.killProcess()
    await this.forceKillPort()
    this.restarting = false

    const ok = await this.regenerate()
    if (ok) {
      await this.spawnServer()
    }

    if (this.pendingSchemaChange) {
      console.log(`[${LOG_PREFIX}] Schema changed during generation, re-running...`)
      await this.handleSchemaChange()
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
        if (this._phase !== 'healthy') return

        if (this.restartTimer) {
          clearTimeout(this.restartTimer)
        }

        this.restartTimer = setTimeout(async () => {
          this.restartTimer = null
          if (this._phase !== 'healthy') return
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
