// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Preview Manager — Manages dev bundlers (Vite, Metro/Expo) for app mode.
 *
 * Lazily started when the agent switches to "app" mode. Handles:
 *   - Stack-aware dev bundler (vite build --watch OR expo + metro)
 *   - Static file serving from project/dist/
 *   - Dependency installation (bun install)
 *   - Prisma client generation (Vite stacks only)
 *   - Restart/rebuild on demand
 *
 * The bundler is selected from the project's `.tech-stack` marker file:
 * stack.json's `runtime.devServer` field decides between strategies. A
 * missing or unrecognised value falls back to Vite for backwards compat.
 */

import { spawn, execSync, type ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync, watch, type FSWatcher } from 'fs'
import { createServer } from 'net'
import { pkg } from '@shogo/shared-runtime'
import { BUILD_LOG_FILE, CONSOLE_LOG_FILE } from './runtime-log-paths'
import {
  loadTechStackMeta,
  computePackageJsonHash,
  readInstallMarker,
  writeInstallMarker,
} from './workspace-defaults'

const LOG_PREFIX = 'preview-manager'

// The agent runtime serves the built `project/dist/` at the **root** of its own
// HTTP port (see server.ts `app.get('*', ...)`). So the "preview URL" is literally
// the runtime's own port — not 5173, not 3001. Those constants historically here
// were either dead (5173: nothing listens on it) or referred to the template API
// sidecar (3001), which is a different thing.

export interface PreviewManagerConfig {
  /**
   * Workspace root for this project. The bundler's actual cwd (where
   * package.json lives) is derived from this via {@link PreviewManager.bundlerCwd}:
   *   - Legacy Vite layout: `<workspaceDir>/project/`
   *   - Expo / RN / etc.: `<workspaceDir>/`
   *
   * Callers should pass the workspace dir, not the bundler cwd. Historically
   * this field was named `projectDir` and was assumed to always be
   * `<workspaceDir>/project/`; that assumption broke once Expo support shipped.
   */
  workspaceDir: string
  /** Port of the agent runtime itself — this IS the preview port (runtime serves dist/ at root). */
  runtimePort: number
  /**
   * Public / externally-reachable URL of the running preview (e.g. in k8s this is the
   * `preview--{id}.{env}.shogo.ai` subdomain). Falls back to the localhost internal
   * URL when unset (local dev).
   */
  publicUrl?: string
  /** Clear agent `consoleLogs` buffer when `.console.log` is reset (preview start). */
  onConsoleLogReset?: () => void
  /**
   * Forward a single line of Metro/Expo bundler output to the runtime's
   * console log buffer. Same downstream destination as the
   * `/console-log/append` endpoint that apps/api hits for Vite output —
   * this just routes Metro lines to the same place without going over
   * HTTP, so the studio's "Server" tab shows them live.
   *
   * If unset, Metro output only lands in `.build.log` on disk.
   */
  onLogLine?: (line: string, stream: 'stdout' | 'stderr') => void
  /**
   * Local mode (developer machine, Shogo Desktop) versus cloud (Knative pod).
   * In local mode we can spawn `expo start --tunnel` to expose Metro to a real
   * phone via Expo's tunnel infrastructure; in cloud mode we ship only the web
   * preview (`expo export -p web`) and surface a "device preview not yet
   * available in cloud" indicator. Defaults to auto-detecting via
   * `KUBERNETES_SERVICE_HOST` / `SHOGO_RUNTIME_MODE`.
   */
  localMode?: boolean
}

// API sidecar port (Hono `server.tsx`) — NOT the app URL. The app is served
// by the runtime itself on `runtimePort`, and this sidecar is proxied at
// `/api/*`.
//
// This is the *single* backend for any app the agent builds: editing the
// project's root `prisma/schema.prisma` triggers regenerate + restart of
// this server. There is no longer a parallel "skill server" on a different
// port; PreviewManager owns the whole pipeline. See migrations/skill-server-to-root.ts
// for the one-shot migration that retires `.shogo/server/` on workspace boot.
//
// Port resolution preserves the dynamic-port contract from the retired
// `SkillServerManager`: callers that already wire a per-instance port via
// `SKILL_SERVER_PORT` (local-worker, VM harness, ...) keep working without
// changes. Precedence:
//   1. `API_SERVER_PORT` — preferred new name; pinned by the docker
//      eval-worker (`-e API_SERVER_PORT=<container>`).
//   2. `SKILL_SERVER_PORT` — legacy alias still emitted by local-worker
//      and rolled-back binaries; mirrors the pre-merge behaviour.
//   3. `3001` — runtime template default (matches package.json scripts
//      and SDK examples) when nothing is provided.
// Resolved per-instance so multiple managers in the same process (eg.
// tests) can vary the env without import-time leakage.
const DEFAULT_API_SERVER_PORT = 3001
function resolveApiServerPort(): number {
  const candidates = [process.env.API_SERVER_PORT, process.env.SKILL_SERVER_PORT]
  for (const raw of candidates) {
    if (!raw) continue
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return DEFAULT_API_SERVER_PORT
}

const SCHEMA_DEBOUNCE_MS = 1500
const HEALTH_CHECK_RETRIES = 10
const HEALTH_CHECK_INTERVAL_MS = 500

// Crash-recovery tunables. Mirrors the pre-merge `SkillServerManager`
// behaviour: exponential backoff capped at 30s, give up after 5 attempts
// in a row. The crash counter resets to 0 on every successful health
// probe so steady-state edits-while-running don't accumulate budget.
const CRASH_BACKOFF_BASE_MS = 1000
const CRASH_BACKOFF_MAX_MS = 30_000
const MAX_CRASH_RESTARTS = 5

// `custom-routes.ts` is the agent-editable surface for non-CRUD routes
// — see `templates/runtime-template/custom-routes.ts`. Saves trigger a
// fast restart (no shogo generate, no `prisma db push`) so the server
// reloads with the new routes in well under a second. Debounce avoids
// a flurry of restarts when an editor saves several times in quick
// succession (file-watch APIs frequently emit duplicate events on the
// same write).
const CUSTOM_ROUTES_DEBOUNCE_MS = 500

// Default starting port for Metro when running via `expo start --tunnel`.
// Expo's historic default is 8081, but during `bun dev:all` the studio's own
// dev server frequently sits on 8081 already — so we probe upward from this
// base until we find a free port. The tunnel URL Expo prints is what users
// scan with Expo Go; we never proxy raw Metro traffic ourselves.
const METRO_PORT_BASE = 8081
const METRO_PORT_RANGE = 50

/**
 * Probe a port range and return the first available port. Uses an ephemeral
 * `net.Server` listen on `0.0.0.0` to test, since Expo Metro listens on the
 * same. Returns `null` if no port in [base, base+range) is free — caller
 * should fall back to letting Expo pick one (CLI default behaviour).
 *
 * Synchronous-style check via a Promise: each probe takes <2ms when the port
 * is free, so the total cost across the whole range is bounded.
 */
async function pickFreePort(
  base: number = METRO_PORT_BASE,
  range: number = METRO_PORT_RANGE,
): Promise<number | null> {
  for (let port = base; port < base + range; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => {
        server.close(() => resolve(true))
      })
      server.listen(port, '0.0.0.0')
    })
    if (free) return port
  }
  return null
}

export type DevServerKind = 'vite' | 'metro' | 'none'

/**
 * Where the device-preview Metro tunnel lives.
 *  - `cloud-todo`: cloud pod, no Metro spawn yet. Studio renders an
 *    "on-device preview not yet supported in cloud" message.
 *  - `local-tunnel`: local agent-runtime spawned `expo start --tunnel`;
 *    the captured `exp://...exp.direct/...` URL is the QR target.
 *  - `local-tunnel-unavailable`: local agent-runtime in a Metro stack, but
 *    the `@expo/ngrok` dependency is missing from node_modules so we
 *    can't actually open a tunnel. Studio surfaces the install hint.
 *  - `not-applicable`: the project isn't a Metro stack.
 */
export type DeviceMode =
  | 'cloud-todo'
  | 'local-tunnel'
  | 'local-tunnel-unavailable'
  | 'not-applicable'

function detectLocalMode(): boolean {
  if (process.env.SHOGO_RUNTIME_MODE === 'local') return true
  if (process.env.SHOGO_RUNTIME_MODE === 'cloud') return false
  // K8s pods set KUBERNETES_SERVICE_HOST; absence implies local dev.
  return !process.env.KUBERNETES_SERVICE_HOST
}

export type PreviewPhase =
  | 'idle'
  | 'installing'
  | 'generating-prisma'
  | 'pushing-db'
  | 'building'
  | 'starting-api'
  | 'ready'

export type ApiServerPhase = 'idle' | 'generating' | 'starting' | 'healthy' | 'restarting' | 'crashed' | 'stopped'

export class PreviewManager {
  private workspaceDir: string
  private runtimePort: number
  private publicUrl?: string
  private onConsoleLogReset?: () => void
  private buildWatchProcess: ChildProcess | null = null
  private apiServerProcess: ChildProcess | null = null
  private metroProcess: ChildProcess | null = null
  private metroUrl: string | null = null
  private metroPort: number | null = null
  private schemaWatcher: FSWatcher | null = null
  private schemaTimer: ReturnType<typeof setTimeout> | null = null
  private customRoutesWatcher: FSWatcher | null = null
  private customRoutesTimer: ReturnType<typeof setTimeout> | null = null
  private apiPhase: ApiServerPhase = 'idle'
  private regenerating = false
  private pendingSchemaChange = false
  private lastGenerateError: string | null = null
  /**
   * Crash-recovery state.
   *
   *   `intentionalStop` — `true` while `stop()` / `restartApiServerOnly()` /
   *      `sync()` are tearing the API server down on purpose. The exit
   *      handler consults this so a deliberate SIGTERM doesn't trip the
   *      backoff/restart loop.
   *   `crashCount` — number of consecutive unexpected exits. Resets to 0
   *      when a fresh process passes its health check, so a long-running
   *      server that crashes once doesn't immediately use up its budget.
   *   `crashRestartTimer` — pending `handleCrash()` setTimeout handle so
   *      `stop()` can cancel it instead of leaking a delayed respawn.
   */
  private intentionalStop = false
  private crashCount = 0
  private crashRestartTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * `true` if `@expo/ngrok` was found at the time the last Metro tunnel
   * spawn was attempted. `null` means we haven't tried yet (no metro
   * stack, or `start()` hasn't been called) and should report the
   * starting/unavailable state purely from disk on each `getDevicePreview`.
   */
  private metroNgrokAvailable: boolean | null = null
  private localMode: boolean
  private onLogLine?: (line: string, stream: 'stdout' | 'stderr') => void
  private started = false
  private _phase: PreviewPhase = 'idle'
  /**
   * Port the spawned project API server (`server.tsx`) binds to. Resolved
   * once in the constructor — subsequent `process.env` mutations don't
   * hot-swap the bound port mid-flight.
   */
  private readonly apiPort: number

  constructor(config: PreviewManagerConfig) {
    this.workspaceDir = config.workspaceDir
    this.runtimePort = config.runtimePort
    this.publicUrl = config.publicUrl
    this.onConsoleLogReset = config.onConsoleLogReset
    this.onLogLine = config.onLogLine
    this.localMode = config.localMode ?? detectLocalMode()
    this.apiPort = resolveApiServerPort()
  }

  /**
   * Best-effort log forwarding — never throws, never blocks. Called from
   * the Metro/Expo stdout+stderr pumps so `.build.log` and the runtime's
   * live console buffer stay in sync.
   */
  private forwardLogLine(line: string, stream: 'stdout' | 'stderr'): void {
    if (!this.onLogLine || !line) return
    try {
      this.onLogLine(line, stream)
    } catch {
      // Listener crashes must never take down the bundler. Drop silently.
    }
  }

  /**
   * Read the project's `.tech-stack` marker and resolve the dev bundler
   * declared in stack.json. Defaults to `vite` when no marker exists or
   * the field is missing — preserves the historic default for the
   * `react-app` / `threejs-game` / `phaser-game` stacks.
   *
   * The marker is always at the workspace root, regardless of whether the
   * stack uses the legacy `<workspace>/project/` layout or seeds at the
   * workspace root (Expo, RN).
   */
  private resolveDevServer(): DevServerKind {
    try {
      const markerPath = join(this.workspaceDir, '.tech-stack')
      if (!existsSync(markerPath)) return 'vite'
      const stackId = readFileSync(markerPath, 'utf-8').trim()
      if (!stackId) return 'vite'
      const meta = loadTechStackMeta(stackId)
      const decl = meta?.runtime?.devServer
      if (decl === 'metro' || decl === 'vite' || decl === 'none') return decl
      return 'vite'
    } catch {
      return 'vite'
    }
  }

  /**
   * Single source of truth for "where does the bundler run?". Mirrored in
   * `runtime-log-paths.ts::resolveBundlerCwd` for non-PreviewManager
   * callers (gateway log readers etc.) — keep them in sync.
   *
   * Resolution:
   *   1. `<workspaceDir>/project/package.json` → legacy Vite layout.
   *   2. `<workspaceDir>/package.json` → Expo / RN / anything seeded at
   *      the workspace root.
   *   3. Otherwise → fall back to `<workspaceDir>/project/`. The bundler
   *      will fail later when no package.json exists; resolveBundlerCwd
   *      itself does not signal that — see `start()` for the bail.
   */
  private resolveBundlerCwd(): string {
    const legacy = join(this.workspaceDir, 'project')
    if (existsSync(join(legacy, 'package.json'))) return legacy
    if (existsSync(join(this.workspaceDir, 'package.json'))) return this.workspaceDir
    return legacy
  }

  /**
   * Public read-only view of where the bundler runs. Stable across
   * `start()` calls (recomputed each time, not cached, so changes on disk
   * — e.g. a fresh Expo seed — are picked up automatically).
   */
  get bundlerCwd(): string {
    return this.resolveBundlerCwd()
  }

  /**
   * URL the runtime exposes for device clients (Expo Go) when Metro is up.
   * Only populated in local mode after `expo start --tunnel` prints its
   * `exp://...exp.direct/...` URL. Cloud mode never sets this.
   */
  get metroDeviceUrl(): string | null {
    return this.metroUrl
  }

  /** Whether this PreviewManager will attempt to spawn `expo start --tunnel`. */
  get isLocalMode(): boolean {
    return this.localMode
  }

  /** URL the agent can hit from inside the pod / local machine. */
  get internalUrl(): string {
    return `http://localhost:${this.runtimePort}/`
  }

  /** URL the end user (or a QA subagent's browser) should navigate to. */
  get externalUrl(): string {
    return this.publicUrl && this.publicUrl.length > 0 ? this.publicUrl : this.internalUrl
  }

  get isStarted(): boolean {
    return this.started
  }

  get isRunning(): boolean {
    return this.buildWatchProcess !== null && !this.buildWatchProcess.killed
  }

  get apiServerPort(): number | null {
    return this.apiServerProcess && !this.apiServerProcess.killed ? this.apiPort : null
  }

  /**
   * Phase of the project's API sidecar (root `server.tsx`). Mirrors the
   * legacy `SkillServerManager.phase` getter so callers (gateway prompts,
   * eval runtime checks) can render a single signal regardless of which
   * pipeline produced the server.
   */
  get apiServerPhase(): ApiServerPhase {
    return this.apiPhase
  }

  /** Last error from `bun x shogo generate`, or null on success. */
  get apiLastGenerateError(): string | null {
    return this.lastGenerateError
  }

  /**
   * URL the agent uses to talk to the API sidecar from inside the pod
   * (i.e. for tools like `web`). The sidecar listens on
   * `localhost:<apiPort>`; the runtime then proxies `/api/*` to
   * the same port — both are valid origins.
   */
  get apiServerUrl(): string {
    return `http://localhost:${this.apiPort}`
  }

  /** Quick health check against `<apiServerUrl>/health`. */
  async isApiHealthy(): Promise<boolean> {
    if (!this.apiServerPort) return false
    try {
      const resp = await fetch(`${this.apiServerUrl}/health`, { signal: AbortSignal.timeout(2000) })
      return resp.ok
    } catch {
      return false
    }
  }

  /**
   * List of API route paths currently registered, derived from the
   * SDK-generated `src/generated/routes/index.{ts,tsx}` (or fallback
   * locations the SDK has used historically).  Returns [] when no
   * routes have been generated yet.
   */
  getActiveRoutes(): string[] {
    const cwd = this.bundlerCwd
    const candidates = [
      join(cwd, 'src', 'generated', 'routes', 'index.tsx'),
      join(cwd, 'src', 'generated', 'routes', 'index.ts'),
      join(cwd, 'src', 'generated', 'index.tsx'),
      join(cwd, 'src', 'generated', 'index.ts'),
    ]
    const found = candidates.find(existsSync)
    if (!found) return []
    try {
      const content = readFileSync(found, 'utf-8')
      const paths: string[] = []
      for (const m of content.matchAll(/app\.route\(\s*["']\/([^"']+)["']/g)) {
        paths.push(m[1])
      }
      // The SDK's createAllRoutes also exports a manifest — fall back
      // to scanning for `routesByModel` style entries if the regex
      // produced nothing.
      if (paths.length === 0) {
        for (const m of content.matchAll(/createRoutes['"]?\s*:\s*\(\)\s*=>\s*create(\w+)Routes/g)) {
          paths.push(m[1].toLowerCase() + 's')
        }
      }
      return paths
    } catch {
      return []
    }
  }

  /** List of model names parsed from root `prisma/schema.prisma`. */
  getSchemaModels(): string[] {
    const schemaPath = join(this.bundlerCwd, 'prisma', 'schema.prisma')
    if (!existsSync(schemaPath)) return []
    try {
      const content = readFileSync(schemaPath, 'utf-8')
      const models: string[] = []
      for (const m of content.matchAll(/^model\s+(\w+)\s*\{/gm)) {
        models.push(m[1])
      }
      return models
    } catch {
      return []
    }
  }

  /**
   * Force a full regenerate + restart cycle and block until the API
   * server is healthy with the latest schema.  Called by the eval
   * harness and the agent's `server_sync` tool to eliminate timing
   * races with the file watcher.
   */
  async sync(): Promise<{ ok: boolean; phase: ApiServerPhase; error?: string }> {
    const cwd = this.bundlerCwd
    const schemaPath = join(cwd, 'prisma', 'schema.prisma')
    if (!existsSync(schemaPath)) {
      return { ok: false, phase: this.apiPhase, error: 'prisma/schema.prisma not found' }
    }

    this.stopSchemaWatcher()
    if (this.schemaTimer) {
      clearTimeout(this.schemaTimer)
      this.schemaTimer = null
    }
    this.pendingSchemaChange = false

    console.log(`[${LOG_PREFIX}] sync() — stopping API server, regenerating, then restarting...`)
    this.regenerating = true
    await this.killApiServer()

    const ok = await this.runShogoGenerate()
    if (ok) {
      const timings: Record<string, number> = {}
      await this.runPrismaIfNeeded(timings)
      await this.startApiServer()
    }
    this.regenerating = false
    this.startSchemaWatcher()

    return ok
      ? { ok: this.apiPhase === 'healthy', phase: this.apiPhase }
      : { ok: false, phase: this.apiPhase, error: this.lastGenerateError ?? 'generation failed' }
  }

  /**
   * Run code generation at the project root. Picks up new models from
   * `prisma/schema.prisma` and regenerates `src/generated/`,
   * `server.tsx`, etc.
   *
   * Strategy:
   *   1. If `package.json` declares a `generate` script, run
   *      `bun run generate`. The runtime template ships such a script
   *      that points at the SDK CLI and is the canonical surface for
   *      project-specific tweaks (e.g. running `db:push` afterwards,
   *      pausing the watcher around the writes, etc.).
   *   2. Otherwise fall back to `bun x shogo generate`. This is the
   *      escape hatch for workspaces that haven't been re-seeded onto
   *      the new template; it still picks up `shogo.config.json` if
   *      present, or runs the SDK's legacy single-dir mode if not.
   *
   * Both paths read the workspace's `shogo.config.json` (when it
   * exists), so generated `server.tsx` ends up with the right
   * `customRoutesPath`, `dynamicCrudImport`, and `bunServe` settings
   * regardless of which entry point was used.
   *
   * Returns false on any failure; the error message is exposed via
   * `apiLastGenerateError` for the caller to surface to the agent.
   */
  private async runShogoGenerate(): Promise<boolean> {
    const cwd = this.bundlerCwd
    const pkgJsonPath = join(cwd, 'package.json')
    if (!existsSync(pkgJsonPath)) return false

    this.apiPhase = 'generating'
    this.lastGenerateError = null
    const start = Date.now()

    // Prefer the project's own `generate` script when one exists. The
    // runtime template ships `"generate": "bun x shogo generate"`, so
    // both paths converge on the SDK CLI; the indirection lets
    // user-customised projects splice extra steps into the pipeline
    // without us having to teach PreviewManager about every variation.
    let useBunRun = false
    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as {
        scripts?: Record<string, string>
      }
      if (pkgJson.scripts && typeof pkgJson.scripts.generate === 'string' && pkgJson.scripts.generate.trim()) {
        useBunRun = true
      }
    } catch {
      // Malformed package.json — fall through to `bun x shogo generate`.
    }

    const args = useBunRun ? ['run', 'generate'] : ['x', 'shogo', 'generate']
    const cmdLabel = useBunRun ? 'bun run generate' : 'bun x shogo generate'
    console.log(`[${LOG_PREFIX}] Running ${cmdLabel} at ${cwd}...`)

    return await new Promise<boolean>((resolveResult) => {
      // Use async spawn rather than execSync. The runtime's startup path
      // already drives a vite watcher, an LSP server, and the agent
      // gateway concurrently — blocking the event loop with execSync
      // starves their stdio pipes and frequently deadlocks `bun x shogo`'s
      // own child processes (notably `prisma generate`, which speaks to
      // the parent through pipes). spawn + 'ignore' for stdin sidesteps
      // both issues and matches the manual CLI invocation shape.
      const proc = spawn(pkg.bunBinary, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DATABASE_URL: `file:${join(cwd, 'prisma', 'dev.db')}`,
          // Hint to non-TTY child processes (Prisma's spinner library,
          // chalk, etc.) so they don't waste cycles on TTY queries.
          CI: '1',
        },
      })

      let stdout = ''
      let stderr = ''
      proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      const TIMEOUT_MS = 120_000
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch {}
      }, TIMEOUT_MS)

      proc.on('error', (err) => {
        clearTimeout(timer)
        const elapsed = ((Date.now() - start) / 1000).toFixed(1)
        this.lastGenerateError = err.message
        console.error(`[${LOG_PREFIX}] ${cmdLabel} spawn error after ${elapsed}s: ${err.message}`)
        this.apiPhase = 'crashed'
        resolveResult(false)
      })

      proc.on('close', (code) => {
        clearTimeout(timer)
        const elapsed = ((Date.now() - start) / 1000).toFixed(1)
        if (code === 0) {
          console.log(`[${LOG_PREFIX}] ${cmdLabel} complete (${elapsed}s)`)
          if (stdout.trim()) console.log(`[${LOG_PREFIX}] generate stdout: ${stdout.trim().slice(0, 500)}`)
          resolveResult(true)
        } else {
          this.lastGenerateError = stderr.trim().slice(0, 500) || stdout.trim().slice(0, 500) || `exit code ${code}`
          console.error(`[${LOG_PREFIX}] ${cmdLabel} failed after ${elapsed}s (exit=${code})`)
          if (stdout.trim()) console.error(`[${LOG_PREFIX}] generate stdout: ${stdout.trim().slice(0, 500)}`)
          if (stderr.trim()) console.error(`[${LOG_PREFIX}] generate stderr: ${stderr.trim().slice(0, 500)}`)
          this.apiPhase = 'crashed'
          resolveResult(false)
        }
      })
    })
  }

  /**
   * Watch `prisma/schema.prisma` for changes. When the agent edits the
   * schema, debounce briefly, then run `shogo generate` and restart the
   * API server.
   *
   * Uses `fs.watch` on the parent directory because `prisma/` may not
   * exist when the watcher first starts (older workspaces, fresh
   * clones). The handler ignores events for unrelated files.
   */
  private startSchemaWatcher(): void {
    const cwd = this.bundlerCwd
    const prismaDir = join(cwd, 'prisma')
    if (!existsSync(prismaDir)) {
      try {
        mkdirSync(prismaDir, { recursive: true })
      } catch {
        return
      }
    }

    if (this.schemaWatcher) return

    try {
      this.schemaWatcher = watch(prismaDir, (_event, filename) => {
        if (filename !== 'schema.prisma') return
        if (this.regenerating) {
          this.pendingSchemaChange = true
          return
        }

        if (this.schemaTimer) clearTimeout(this.schemaTimer)
        this.schemaTimer = setTimeout(() => {
          this.schemaTimer = null
          void this.handleSchemaChange()
        }, SCHEMA_DEBOUNCE_MS)
      })
    } catch (err: any) {
      console.error(`[${LOG_PREFIX}] Failed to watch ${prismaDir}: ${err.message}`)
    }
  }

  private stopSchemaWatcher(): void {
    if (this.schemaWatcher) {
      this.schemaWatcher.close()
      this.schemaWatcher = null
    }
  }

  private async handleSchemaChange(): Promise<void> {
    const cwd = this.bundlerCwd
    const schemaPath = join(cwd, 'prisma', 'schema.prisma')
    if (!existsSync(schemaPath)) return

    const content = readFileSync(schemaPath, 'utf-8')
    if (!/^model\s+\w+/m.test(content)) {
      console.log(`[${LOG_PREFIX}] schema.prisma changed but has no models yet, skipping...`)
      return
    }

    console.log(`[${LOG_PREFIX}] schema.prisma changed, regenerating...`)
    this.regenerating = true
    this.pendingSchemaChange = false
    await this.killApiServer()

    const ok = await this.runShogoGenerate()
    if (ok) {
      const timings: Record<string, number> = {}
      await this.runPrismaIfNeeded(timings)
      await this.startApiServer()
    }
    this.regenerating = false

    if (this.pendingSchemaChange) {
      console.log(`[${LOG_PREFIX}] Schema changed during regeneration, re-running...`)
      await this.handleSchemaChange()
    }
  }

  private async killApiServer(): Promise<void> {
    // Mark every shutdown initiated through this method as intentional
    // so the exit handler doesn't trigger crash recovery. Callers that
    // want to relax that (none currently) can flip the flag back after.
    this.intentionalStop = true
    if (this.crashRestartTimer) {
      clearTimeout(this.crashRestartTimer)
      this.crashRestartTimer = null
    }
    const proc = this.apiServerProcess
    if (!proc || proc.killed) {
      this.apiServerProcess = null
      return
    }

    return new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL')
        resolve()
      }, 5000)

      proc.once('exit', () => {
        clearTimeout(force)
        resolve()
      })

      proc.kill('SIGTERM')
      this.apiServerProcess = null
    })
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
      return { mode: 'already-running', port: this.runtimePort, timings: {} }
    }

    // Fresh preview session — align console buffer with an empty on-disk log (matches build refresh UX).
    this.clearRuntimeConsoleLog()

    const timings: Record<string, number> = {}
    const bundlerCwd = this.resolveBundlerCwd()

    if (!existsSync(join(bundlerCwd, 'package.json'))) {
      console.log(`[${LOG_PREFIX}] No package.json in ${bundlerCwd} — skipping preview start`)
      return { mode: 'no-project', port: null, timings }
    }

    const devServer = this.resolveDevServer()

    if (devServer === 'metro') {
      // Web preview is always built; the device-preview Metro tunnel only
      // runs in local mode. Cloud pods skip the tunnel and surface a
      // "device preview not yet available in cloud" indicator via
      // /preview/metro.
      await this.runSetupTasksMetro(timings, bundlerCwd)
      const mode = this.metroProcess
        ? 'metro-web+tunnel'
        : this.localMode
          ? 'metro-web (tunnel-failed)'
          : 'metro-web (cloud-todo)'
      return { mode, port: this.runtimePort, timings }
    }

    if (devServer === 'none') {
      console.log(`[${LOG_PREFIX}] Stack declares devServer=none — skipping bundler`)
      this._phase = 'ready'
      this.started = true
      return { mode: 'no-bundler', port: this.runtimePort, timings }
    }

    const hasPrebuiltDist = existsSync(join(bundlerCwd, 'dist', 'index.html'))

    if (hasPrebuiltDist) {
      console.log(`[${LOG_PREFIX}] Pre-built dist/ found — serving immediately, setup continues in background`)
      this._phase = 'ready'
      this.started = true

      this.backgroundSetup(timings).catch((err) => {
        console.error(`[${LOG_PREFIX}] Background setup failed:`, err.message)
      })

      return { mode: 'prebuilt-dist', port: this.runtimePort, timings }
    }

    await this.runSetupTasks(timings)
    return { mode: this.apiServerProcess ? 'vite-watch+api' : 'vite-watch', port: this.runtimePort, timings }
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

  /**
   * Metro/Expo setup path:
   *   1. install deps
   *   2. produce a static `dist/` via `expo export --platform web` so the
   *      runtime can serve a working iframe preview using react-native-web
   *   3. (LOCAL ONLY) start `expo start --tunnel`; capture the `exp://`
   *      URL Expo's tunnel server prints. Cloud mode skips this — see
   *      DEVICE_PREVIEW_CLOUD_TODO below.
   *
   * DEVICE_PREVIEW_CLOUD_TODO:
   *   Real-device preview from a cloud pod requires either:
   *     (a) WebSocket-aware proxy of Metro through the preview subdomain,
   *     (b) `eas update` per change against an OTA channel, or
   *     (c) per-pod `@expo/ngrok` tunnel.
   *   Until one is picked we ship web preview only in cloud and direct
   *   users to a local Shogo install for device preview.
   */
  private async runSetupTasksMetro(timings: Record<string, number>, bundlerCwd: string): Promise<void> {
    await this.installDepsIfNeeded(timings, bundlerCwd)

    this._phase = 'building'
    await this.runExpoExportWeb(timings, bundlerCwd)

    if (this.localMode) {
      await this.startMetroTunnel(bundlerCwd)
      timings.metro = 0
    } else {
      console.log(`[${LOG_PREFIX}] Cloud mode — skipping Metro tunnel (DEVICE_PREVIEW_CLOUD_TODO)`)
    }

    this._phase = 'ready'
    this.started = true
  }

  private async installDepsIfNeeded(timings: Record<string, number>, cwd?: string): Promise<void> {
    const installCwd = cwd ?? this.bundlerCwd
    const hasNodeModules = existsSync(join(installCwd, 'node_modules'))

    // Hash-based install gate: write `.shogo/install-marker` containing
    // sha256(package.json) after each successful install; on next start,
    // compare. Same hash → skip install. Replaces the older anchor-deps
    // heuristic, which had two failure modes:
    //   1. False positive — anchors present but other deps were stale,
    //      e.g. a project that pinned react@18 then bumped to 19.
    //   2. False negative — every install ran the anchor check from disk,
    //      which is technically O(deps) stat calls vs. one stat + read.
    //
    // The marker logic lives in workspace-defaults so `ensureWorkspaceDeps`
    // (host-side, host-spawned RuntimeManager) can write the same marker
    // after its install. Without that shared helper, a stack switch
    // (Vite → Expo) would always trip the "hash changed" path here even
    // though ensureWorkspaceDeps had just installed the right deps —
    // and on Windows boxes without Node.js the resulting reinstall blew
    // up with NodeMissingError.
    //
    // The marker is best-effort: any read/parse failure falls through to a
    // full install, so a corrupted marker can never cause a stale-deps
    // crash — only at most one redundant install.
    const expectedHash = computePackageJsonHash(installCwd)
    const recordedHash = readInstallMarker(installCwd)

    if (
      hasNodeModules &&
      expectedHash != null &&
      recordedHash != null &&
      expectedHash === recordedHash
    ) {
      console.log(`[${LOG_PREFIX}] install-marker matches package.json sha256 — skipping bun install`)
      timings.install = 0
      return
    }

    // First-ever start with a pre-installed node_modules and no marker: trust
    // that the install matches package.json (this is the runtime template's
    // pre-warmed fast path) and just record the marker so we hit the cheap
    // skip path on subsequent starts. Avoids redundant `bun install` on every
    // fresh workspace, which was the original anchor-deps heuristic's whole
    // job. If the bundled node_modules doesn't actually match package.json —
    // e.g. a Vite template copied into an Expo workspace — the bundler will
    // fail on first build and the user can `bun install` manually; we'd
    // rather not unconditionally install on every start.
    if (hasNodeModules && expectedHash != null && recordedHash == null) {
      console.log(
        `[${LOG_PREFIX}] node_modules/ present but install-marker missing — recording hash without reinstall`,
      )
      writeInstallMarker(installCwd, expectedHash)
      timings.install = 0
      return
    }

    if (hasNodeModules && expectedHash != null && recordedHash !== expectedHash) {
      console.log(
        `[${LOG_PREFIX}] package.json hash changed since last install (${recordedHash?.slice(0, 8)} → ${expectedHash.slice(0, 8)}) — reinstalling`,
      )
    }

    this._phase = 'installing'
    const t0 = Date.now()
    try {
      console.log(`[${LOG_PREFIX}] Installing dependencies in ${installCwd}...`)
      // installAsync (vs. installSync) lets the platform layer apply its
      // Windows fallback policy — npm if available, else
      // `bun install --backend=copyfile` to dodge the bun-1.x hardlink
      // bug that produces empty package dirs (see platform-pkg.ts).
      // No `frozen: true` here: we may be recovering from a stale
      // template node_modules with no user-owned lockfile.
      await pkg.installAsync(installCwd, { frozen: false })
      timings.install = Date.now() - t0
      console.log(`[${LOG_PREFIX}] Dependencies installed (${timings.install}ms)`)

      // Best-effort marker write — a failure here just means we'll run
      // install one more time on the next start, never anything worse.
      writeInstallMarker(installCwd, expectedHash ?? undefined)
    } catch (err: any) {
      timings.install = Date.now() - t0
      console.error(`[${LOG_PREFIX}] Dependency install failed:`, err.message)
    }
  }

  private async runPrismaIfNeeded(timings: Record<string, number>): Promise<void> {
    const cwd = this.bundlerCwd
    const prismaSchema = join(cwd, 'prisma', 'schema.prisma')
    if (!existsSync(prismaSchema)) return

    const prismaClientPath = join(cwd, 'node_modules', '.prisma', 'client')
    if (existsSync(prismaClientPath)) {
      console.log(`[${LOG_PREFIX}] Prisma client exists — skipping generate`)
      timings.prisma = 0
    } else {
      this._phase = 'generating-prisma'
      const t1 = Date.now()
      try {
        pkg.prismaGenerate(cwd)
        timings.prisma = Date.now() - t1
      } catch (err: any) {
        timings.prisma = Date.now() - t1
        console.error(`[${LOG_PREFIX}] Prisma generate failed:`, err.message)
      }
    }

    this._phase = 'pushing-db'
    const devDb = join(cwd, 'prisma', 'dev.db')
    if (existsSync(devDb)) {
      console.log(`[${LOG_PREFIX}] SQLite db exists — skipping db push`)
      timings.dbPush = 0
      return
    }

    const t2 = Date.now()
    try {
      pkg.prismaDbPush(cwd, { env: { ...process.env, DATABASE_URL: `file:${devDb}` } as NodeJS.ProcessEnv })
      timings.dbPush = Date.now() - t2
      console.log(`[${LOG_PREFIX}] Prisma db push succeeded (${timings.dbPush}ms)`)
    } catch (err: any) {
      timings.dbPush = Date.now() - t2
      console.error(`[${LOG_PREFIX}] Prisma db push failed:`, err.message?.slice(0, 200))
    }
  }

  /**
   * Stop the preview server and kill the bundler process.
   */
  stop(): void {
    this.intentionalStop = true
    this.stopSchemaWatcher()
    this.stopCustomRoutesWatcher()
    if (this.schemaTimer) {
      clearTimeout(this.schemaTimer)
      this.schemaTimer = null
    }
    if (this.crashRestartTimer) {
      clearTimeout(this.crashRestartTimer)
      this.crashRestartTimer = null
    }
    if (this.apiServerProcess) {
      console.log(`[${LOG_PREFIX}] Stopping API server...`)
      this.apiServerProcess.kill('SIGTERM')
      this.apiServerProcess = null
    }
    if (this.buildWatchProcess) {
      console.log(`[${LOG_PREFIX}] Stopping Vite build watch...`)
      this.buildWatchProcess.kill('SIGTERM')
      this.buildWatchProcess = null
    }
    if (this.metroProcess) {
      console.log(`[${LOG_PREFIX}] Stopping Metro bundler...`)
      this.metroProcess.kill('SIGTERM')
      this.metroProcess = null
      this.metroUrl = null
    }
    this.started = false
    this._phase = 'idle'
    this.apiPhase = 'stopped'
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
   *
   * `url` is the canonical URL to give to humans / browsers (external if set,
   * else localhost). `internalUrl` and `publicUrl` are always populated so
   * callers can pick the right one for their context (e.g. an in-pod agent
   * should use `internalUrl`, a QA subagent driving a real browser should use
   * `publicUrl`/`url`).
   *
   * `port` is kept for backwards compatibility with the `/preview/status`
   * endpoint and equals `runtimePort` (the port the runtime is actually
   * bound on, which is where dist/ is served from).
   */
  getStatus(): {
    running: boolean
    port: number | null
    url: string | null
    internalUrl: string | null
    publicUrl: string | null
    workspaceDir: string
    bundlerCwd: string
    phase: PreviewPhase
    devServer: DevServerKind
    metroUrl: string | null
  } {
    const running = this.started && this._phase === 'ready'
    return {
      running,
      port: running ? this.runtimePort : null,
      url: running ? this.externalUrl : null,
      internalUrl: running ? this.internalUrl : null,
      publicUrl: running && this.publicUrl ? this.publicUrl : null,
      workspaceDir: this.workspaceDir,
      bundlerCwd: this.bundlerCwd,
      phase: this._phase,
      devServer: this.resolveDevServer(),
      metroUrl: running ? this.metroUrl : null,
    }
  }

  /** Truncate project `.console.log` and clear the server's in-memory buffer (if wired). */
  private clearRuntimeConsoleLog(): void {
    const consolePath = join(this.bundlerCwd, CONSOLE_LOG_FILE)
    try {
      writeFileSync(consolePath, '', 'utf-8')
    } catch (err: any) {
      console.warn(`[${LOG_PREFIX}] Could not truncate ${CONSOLE_LOG_FILE}:`, err.message)
    }
    this.onConsoleLogReset?.()
  }

  private async startBuildWatch(): Promise<void> {
    const cwd = this.bundlerCwd
    const buildLogPath = join(cwd, BUILD_LOG_FILE)

    // On Windows the bun/npm-installed shim at `.bin/vite` is a POSIX shell
    // script that `child_process.spawn` cannot execute directly — it has to
    // be `.bin/vite.CMD`. Pick the right shim per-platform and bail out
    // cleanly if neither exists (e.g. dependency install failed earlier).
    const binDir = join(cwd, 'node_modules', '.bin')
    const isWindows = process.platform === 'win32'
    const viteCandidates = isWindows
      ? [join(binDir, 'vite.CMD'), join(binDir, 'vite.cmd'), join(binDir, 'vite.exe')]
      : [join(binDir, 'vite')]
    const viteBin = viteCandidates.find((p) => existsSync(p))
    if (!viteBin) {
      console.log(`[${LOG_PREFIX}] Vite not found in node_modules — skipping watch`)
      return
    }

    console.log(`[${LOG_PREFIX}] Starting vite build --watch...`)

    let viteProcess: ChildProcess
    try {
      viteProcess = spawn(viteBin, ['build', '--watch'], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // `.CMD` shims must go through cmd.exe on Windows.
        shell: isWindows,
        env: {
          ...process.env,
          NODE_ENV: 'development',
          VITE_RUNTIME_PORT: String(this.runtimePort),
        },
      })
    } catch (err: any) {
      console.error(`[${LOG_PREFIX}] Failed to spawn vite build --watch: ${err?.message ?? err}`)
      return
    }

    this.buildWatchProcess = viteProcess

    // Async spawn errors (e.g. ENOENT surfaced after the call returns) must
    // not bubble up — without this listener Node treats them as uncaught and
    // tears down the entire agent runtime process.
    viteProcess.on('error', (err: Error) => {
      console.error(`[${LOG_PREFIX}] Vite build --watch error: ${err.message}`)
      if (this.buildWatchProcess === viteProcess) {
        this.buildWatchProcess = null
      }
    })

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

    await new Promise((resolve) => setTimeout(resolve, 3000))
  }

  private async startApiServer(): Promise<void> {
    const cwd = this.bundlerCwd

    // The runtime template no longer ships a hand-written `server.tsx`
    // — it's generated by the SDK from `shogo.config.json` (see
    // `templates/runtime-template/shogo.config.json`). We treat both
    // `server.tsx` AND the per-model routes index as required artifacts:
    // missing either means we need to run code generation before
    // spawning. Generate-on-first-boot is cheap (~1s) and idempotent;
    // after that the schema watcher / `sync()` handle subsequent runs.
    const serverFile = join(cwd, 'server.tsx')
    const routesIndexTsx = join(cwd, 'src', 'generated', 'index.tsx')
    const routesIndexTs = join(cwd, 'src', 'generated', 'index.ts')
    const hasGeneratedIndex = existsSync(routesIndexTsx) || existsSync(routesIndexTs)
    const hasServerEntry = existsSync(serverFile)

    if (!hasServerEntry || !hasGeneratedIndex) {
      // Skip the call when there's nothing to generate from. A workspace
      // with neither `package.json` nor `prisma/schema.prisma` yet is
      // simply pre-bootstrap — leave apiPhase=idle so the gateway
      // surfaces the "available, edit prisma/schema.prisma to begin"
      // message rather than "crashed".
      const schemaPath = join(cwd, 'prisma', 'schema.prisma')
      if (!existsSync(join(cwd, 'package.json')) || !existsSync(schemaPath)) {
        this.apiPhase = 'idle'
        return
      }

      const ok = await this.runShogoGenerate()
      if (!ok) {
        console.warn(
          `[${LOG_PREFIX}] Initial shogo generate failed — server.tsx will likely crash. ` +
            `Last error: ${this.lastGenerateError ?? 'unknown'}`,
        )
      }

      // Re-check after generation. If `server.tsx` still isn't on disk,
      // bail before spawn — the SDK CLI failed silently or
      // `shogo.config.json` isn't configured to emit it.
      if (!existsSync(serverFile)) {
        this.apiPhase = ok ? 'idle' : 'crashed'
        return
      }
    }

    const buildLogPath = join(cwd, BUILD_LOG_FILE)
    console.log(`[${LOG_PREFIX}] Starting API server on port ${this.apiPort}...`)
    this.apiPhase = 'starting'

    // Make sure the port is actually free before we spawn — a previous
    // run may have leaked a process or had its EADDRINUSE handler skip
    // cleanup. `forceKillPort()` no-ops when nothing is listening.
    await this.waitForPortRelease()

    // Each fresh spawn is also a fresh chance to recover from a crash
    // loop; the running counter only matters across consecutive failures
    // without an intervening spawn.
    this.intentionalStop = false

    // Pass the resolved port through every name `server.tsx` and the SDK
    // template scripts might consult: `PORT` is the canonical Bun.serve
    // input; `API_SERVER_PORT` and the legacy `SKILL_SERVER_PORT` alias
    // keep generated code / rolled-back binaries consistent with the
    // host-side runtime checks.
    const portStr = String(this.apiPort)
    const proc = spawn(pkg.bunBinary, ['run', 'server.tsx'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: portStr,
        API_SERVER_PORT: portStr,
        SKILL_SERVER_PORT: portStr,
        DATABASE_URL: `file:${join(cwd, 'prisma', 'dev.db')}`,
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
      console.log(`[${LOG_PREFIX}] API server exited (code=${code}, signal=${signal})`)
      if (this.apiServerProcess === proc) this.apiServerProcess = null

      // Don't downgrade an `idle`/`stopped` phase set by `stop()`, and
      // don't trigger crash recovery when the exit was intentional
      // (`stop()`, `restartApiServerOnly()`, `sync()`, schema-driven
      // restart). Schema-driven `runShogoGenerate` flips `regenerating`
      // so we treat that the same as an intentional teardown.
      if (this.apiPhase === 'starting' || this.apiPhase === 'healthy') {
        this.apiPhase = 'crashed'
      }
      if (!this.intentionalStop && !this.regenerating && this.apiPhase === 'crashed') {
        this.handleCrash()
      }
    })

    // Poll /health up to HEALTH_CHECK_RETRIES * HEALTH_CHECK_INTERVAL_MS
    // before declaring the server healthy. Falls back to a fixed delay
    // (matches old behaviour) when the health endpoint never appears.
    let healthy = false
    for (let i = 0; i < HEALTH_CHECK_RETRIES; i++) {
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS))
      if (proc.killed || this.apiServerProcess !== proc) break
      try {
        const resp = await fetch(`${this.apiServerUrl}/health`, { signal: AbortSignal.timeout(2000) })
        if (resp.ok) {
          healthy = true
          break
        }
      } catch {
        // not ready yet
      }
    }

    if (healthy) {
      this.apiPhase = 'healthy'
      // A fresh, healthy process clears the crash budget so a long-
      // running server that crashes once tomorrow doesn't run out of
      // retries because of yesterday's bad start.
      this.crashCount = 0
      console.log(`[${LOG_PREFIX}] API server healthy on port ${this.apiPort}`)
    } else if (this.apiServerProcess === proc && !proc.killed) {
      // Process is up but /health never responded — treat as best-effort
      // running. The caller can still proxy to it (if templates omit
      // /health entirely, prior behaviour was the same fixed-delay return).
      this.apiPhase = 'healthy'
      this.crashCount = 0
      console.warn(`[${LOG_PREFIX}] API server started but /health never returned 2xx — proceeding anyway`)
    }

    this.startSchemaWatcher()
    this.startCustomRoutesWatcher()
  }

  /**
   * Fast path for `custom-routes.ts` edits: kill the running server,
   * wait for the port to free, then respawn `server.tsx`. Skips the
   * full regenerate + `db push` cycle because non-CRUD route edits
   * don't change the schema.
   *
   * Safe to call concurrently with itself — the second caller will
   * find `intentionalStop=true` already set and just join the kill
   * promise. Returns once the new process is healthy (or its health
   * check times out).
   *
   * Public so the gateway tools layer can invoke it directly from
   * `edit_file`/`write_file` of `custom-routes.ts` (the watcher path is
   * the safety net; the synchronous tool-level call lets us answer the
   * agent with a single round-trip "server restarted with your new
   * routes").
   */
  async restartApiServerOnly(): Promise<void> {
    if (this.crashRestartTimer) {
      clearTimeout(this.crashRestartTimer)
      this.crashRestartTimer = null
    }
    this.intentionalStop = true
    this.apiPhase = 'restarting'
    await this.killApiServer()
    await this.forceKillPort()
    await this.waitForPortRelease()
    // killApiServer / forceKillPort have set `intentionalStop=true`;
    // `startApiServer` will reset it before spawning the new process.
    await this.startApiServer()
  }

  /**
   * Watch `custom-routes.ts` (and `.tsx`) at the project root for
   * changes and trigger a fast restart via {@link restartApiServerOnly}.
   * Uses `fs.watch` on the parent directory since the file may not
   * exist on first start (older workspaces, projects upgraded mid-
   * flight from the merged-server era).
   */
  private startCustomRoutesWatcher(): void {
    const cwd = this.bundlerCwd
    if (!existsSync(cwd)) return
    if (this.customRoutesWatcher) return

    try {
      this.customRoutesWatcher = watch(cwd, (_event, filename) => {
        if (!filename) return
        if (filename !== 'custom-routes.ts' && filename !== 'custom-routes.tsx') return

        // Skip while a regenerate is in flight — the surrounding cycle
        // already bounces the server, no need to pile on a second
        // restart on top.
        if (this.regenerating) return
        if (this.apiPhase === 'restarting') return

        if (this.customRoutesTimer) clearTimeout(this.customRoutesTimer)
        this.customRoutesTimer = setTimeout(() => {
          this.customRoutesTimer = null
          if (this.regenerating) return
          console.log(`[${LOG_PREFIX}] custom-routes change detected, fast-restarting API server...`)
          void this.restartApiServerOnly().catch((err: any) => {
            console.error(`[${LOG_PREFIX}] custom-routes restart failed: ${err?.message ?? err}`)
          })
        }, CUSTOM_ROUTES_DEBOUNCE_MS)
      })
    } catch (err: any) {
      console.error(`[${LOG_PREFIX}] Failed to watch ${cwd} for custom-routes changes: ${err.message}`)
    }
  }

  private stopCustomRoutesWatcher(): void {
    if (this.customRoutesWatcher) {
      this.customRoutesWatcher.close()
      this.customRoutesWatcher = null
    }
    if (this.customRoutesTimer) {
      clearTimeout(this.customRoutesTimer)
      this.customRoutesTimer = null
    }
  }

  /**
   * Schedule a respawn after an unexpected exit using exponential
   * backoff. Bounded by `MAX_CRASH_RESTARTS` to avoid burning CPU on a
   * permanently-broken `server.tsx` (e.g. a syntax error the agent
   * hasn't fixed). The agent surfaces the failure via
   * `apiLastGenerateError` and the `apiServerPhase=crashed` state.
   *
   * Mirrors the legacy `SkillServerManager.handleCrash` algorithm so
   * pods rolled forward across the merge see the same recovery
   * behaviour they had before.
   */
  private handleCrash(): void {
    if (this.intentionalStop || this.regenerating) return

    this.crashCount++
    if (this.crashCount > MAX_CRASH_RESTARTS) {
      console.error(`[${LOG_PREFIX}] Exceeded max crash restarts (${MAX_CRASH_RESTARTS}), giving up`)
      this.apiPhase = 'crashed'
      return
    }

    const backoff = Math.min(
      CRASH_BACKOFF_BASE_MS * Math.pow(2, this.crashCount - 1),
      CRASH_BACKOFF_MAX_MS,
    )
    console.log(`[${LOG_PREFIX}] API server crash #${this.crashCount}, restarting in ${backoff}ms...`)
    this.apiPhase = 'restarting'

    if (this.crashRestartTimer) clearTimeout(this.crashRestartTimer)
    this.crashRestartTimer = setTimeout(async () => {
      this.crashRestartTimer = null
      if (this.intentionalStop || this.regenerating) return
      try {
        await this.killApiServer()
        await this.forceKillPort()
        await this.waitForPortRelease()
        await this.startApiServer()
      } catch (err: any) {
        console.error(`[${LOG_PREFIX}] Crash-restart attempt failed: ${err?.message ?? err}`)
      }
    }, backoff)
  }

  /**
   * Force-kill any process listening on the API port. Used before
   * spawning a fresh server so a leaked previous process (or an
   * unrelated user-spawned binary) can't squat the port and EADDRINUSE
   * the new spawn. Falls back to `lsof` and `fuser`; both are
   * universally available on Linux pods and macOS dev machines.
   *
   * Best-effort: any failure (missing binary, permission denied) is
   * swallowed. The caller already polls the port via
   * {@link waitForPortRelease} and a leaked process will then surface
   * as a crash loop the operator can investigate.
   */
  private async forceKillPort(): Promise<void> {
    try {
      const result = execSync(
        `lsof -ti :${this.apiPort} 2>/dev/null || fuser ${this.apiPort}/tcp 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim()
      if (!result) return

      const pids = result.split(/\s+/).filter(Boolean)
      for (const pid of pids) {
        try {
          process.kill(Number(pid), 'SIGKILL')
          console.log(`[${LOG_PREFIX}] Force-killed leaked process ${pid} on port ${this.apiPort}`)
        } catch {
          // Process already exited / permission denied — fine.
        }
      }
    } catch {
      // lsof / fuser missing on this platform; waitForPortRelease will
      // still give the kernel time to clean up the socket.
    }
  }

  /**
   * Block until the API port is free, polling at 250ms intervals.
   * Returns silently after `timeoutMs` even if the port is still bound
   * — the subsequent spawn will then EADDRINUSE and the crash handler
   * will retry. Logs a warning so operators can see "spawn raced port
   * cleanup" in the build log.
   */
  private async waitForPortRelease(timeoutMs = 5000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const free = await this.isPortFree()
      if (free) return
      await new Promise((r) => setTimeout(r, 250))
    }
    console.warn(`[${LOG_PREFIX}] Port ${this.apiPort} still occupied after ${timeoutMs}ms`)
  }

  private isPortFree(): Promise<boolean> {
    return new Promise((resolveFree) => {
      const tester = createServer()
        .once('error', () => resolveFree(false))
        .once('listening', () => {
          tester.close(() => resolveFree(true))
        })
        .listen(this.apiPort, '127.0.0.1')
    })
  }

  /**
   * Resolve the `expo` CLI shim inside `<cwd>/node_modules/.bin`, picking
   * the per-platform variant `child_process.spawn` can actually execute.
   *
   * On Windows the no-extension `expo` file is a POSIX shell script that
   * `spawn` can't run — `existsSync` returns true but `spawn` then async-
   * emits ENOENT, which (without an `'error'` listener) kills the runtime.
   * The real shim is `expo.CMD`/`expo.cmd`. Mirrors the same logic in
   * `startBuildWatch` for Vite.
   */
  private resolveExpoBin(cwd: string): string | null {
    const binDir = join(cwd, 'node_modules', '.bin')
    const isWindows = process.platform === 'win32'
    const candidates = isWindows
      ? [join(binDir, 'expo.CMD'), join(binDir, 'expo.cmd'), join(binDir, 'expo.exe')]
      : [join(binDir, 'expo')]
    return candidates.find((p) => existsSync(p)) ?? null
  }

  /**
   * Run `expo export --platform web --output-dir dist` once. The resulting
   * `dist/` is served by the runtime at the root, just like a Vite build.
   * This gives Studio's iframe preview a working web rendering of the RN
   * app via `react-native-web`. Re-run on demand via `restart()`.
   */
  private async runExpoExportWeb(timings: Record<string, number>, cwd: string): Promise<void> {
    const expoBin = this.resolveExpoBin(cwd)
    if (!expoBin) {
      console.log(`[${LOG_PREFIX}] expo CLI not found in node_modules — skipping web export`)
      return
    }
    const isWindows = process.platform === 'win32'

    // Build log lives next to the bundler cwd. For Vite stacks that's the
    // legacy `<workspace>/project/` subdir; for Expo stacks it's the
    // workspace root. `resolveBundlerCwd()` is the single source of truth.
    const buildLogPath = join(cwd, BUILD_LOG_FILE)
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true })
    const t0 = Date.now()
    console.log(`[${LOG_PREFIX}] Running expo export --platform web...`)
    await new Promise<void>((resolveExport) => {
      let proc: ChildProcess
      try {
        proc = spawn(expoBin, ['export', '--platform', 'web', '--output-dir', 'dist'], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          // `.CMD` shims must go through cmd.exe on Windows.
          shell: isWindows,
          env: {
            ...process.env,
            NODE_ENV: 'development',
            // CI=1 keeps Expo non-interactive (no prompts to install missing deps).
            CI: '1',
          },
        })
      } catch (err: any) {
        console.error(`[${LOG_PREFIX}] Failed to spawn expo export: ${err?.message ?? err}`)
        resolveExport()
        return
      }
      // Async spawn errors (e.g. ENOENT surfaced after the call returns) must
      // not bubble up — without this listener Node treats them as uncaught and
      // tears down the entire agent runtime process.
      proc.on('error', (err: Error) => {
        console.error(`[${LOG_PREFIX}] expo export error: ${err.message}`)
        resolveExport()
      })
      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString()
        for (const raw of text.split('\n')) {
          const line = raw.trim()
          if (!line) continue
          appendFileSync(buildLogPath, `[expo-export-stdout] ${line}\n`)
          this.forwardLogLine(`[expo-export] ${line}`, 'stdout')
        }
      })
      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        for (const raw of text.split('\n')) {
          const line = raw.trim()
          if (!line) continue
          appendFileSync(buildLogPath, `[expo-export-stderr] ${line}\n`)
          this.forwardLogLine(`[expo-export] ${line}`, 'stderr')
        }
      })
      proc.on('exit', (code) => {
        if (code !== 0) {
          console.error(`[${LOG_PREFIX}] expo export failed (code=${code})`)
        }
        resolveExport()
      })
    })
    timings.expoExport = Date.now() - t0
  }

  /**
   * Local-mode-only: spawn `expo start --tunnel` and capture the
   * `exp://...exp.direct/...` URL Expo's tunnel server prints. The
   * tunnel survives NAT and lets a phone on a different network connect
   * to Metro running on the developer's machine, which is the whole
   * point of having on-device preview locally.
   *
   * The tunnel takes ~5–10s to establish, so we poll for the URL up to
   * 30s before resolving. If it never appears we leave `metroUrl=null`
   * and `/preview/metro` will report `tunnel-failed`.
   */
  /**
   * Whether `@expo/ngrok` (the dependency `expo start --tunnel` requires)
   * is installed in the bundler cwd's `node_modules`. Expo declares it as
   * an optional peer dep, so it's frequently missing in fresh installs.
   *
   * Detection uses `existsSync` rather than `require.resolve` because the
   * latter would actually load the module and we only want to know if the
   * tarball is present.
   */
  private hasNgrok(cwd: string): boolean {
    return existsSync(join(cwd, 'node_modules', '@expo', 'ngrok'))
  }

  private async startMetroTunnel(cwd: string): Promise<void> {
    if (!this.localMode) return

    const expoBin = this.resolveExpoBin(cwd)
    if (!expoBin) {
      console.log(`[${LOG_PREFIX}] expo CLI not found in node_modules — skipping device tunnel`)
      return
    }
    const isWindows = process.platform === 'win32'
    if (!this.hasNgrok(cwd)) {
      // Don't even try to spawn — `expo start --tunnel` would either prompt
      // to install ngrok (CI=1 suppresses the prompt → silent hang) or
      // fail after 30s. Surface the missing-dep state via getDevicePreview
      // and bail. Studio renders the install hint instead of a stale
      // "tunnel is starting…" message.
      console.warn(
        `[${LOG_PREFIX}] @expo/ngrok not found in node_modules — device tunnel disabled. ` +
        `Run \`bun add @expo/ngrok\` in the workspace to enable on-device preview.`,
      )
      this.metroNgrokAvailable = false
      return
    }
    this.metroNgrokAvailable = true

    // See note in runExpoExportWeb — for Metro stacks the build log lives
    // alongside the bundler cwd, not the legacy `project/` subdir.
    const buildLogPath = join(cwd, BUILD_LOG_FILE)
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true })

    // Probe upward from 8081 because the Studio dev server squats on the
    // historic Metro default during `bun dev:all`. If we can't find a free
    // port, fall back to letting Expo pick (it'll log "Port X in use ...
    // using Y instead" on stderr and we'll capture the URL anyway).
    const probedPort = await pickFreePort()
    this.metroPort = probedPort
    const portArgs = probedPort != null ? ['--port', String(probedPort)] : []
    console.log(
      `[${LOG_PREFIX}] Starting Expo tunnel${probedPort != null ? ` on port ${probedPort}` : ''}...`,
    )

    // CI=1 keeps Expo non-interactive — no prompts to install ngrok, no
    // browser auto-open. The legacy `--non-interactive` CLI flag was
    // deprecated in Expo SDK 50 and now logs a warning + exits, so we
    // rely solely on the env var.
    let proc: ChildProcess
    try {
      proc = spawn(
        expoBin,
        ['start', '--tunnel', ...portArgs],
        {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          // `.CMD` shims must go through cmd.exe on Windows.
          shell: isWindows,
          env: {
            ...process.env,
            CI: '1',
            EXPO_NO_TELEMETRY: '1',
          },
        },
      )
    } catch (err: any) {
      console.error(`[${LOG_PREFIX}] Failed to spawn expo start --tunnel: ${err?.message ?? err}`)
      return
    }

    this.metroProcess = proc

    // Async spawn errors (e.g. ENOENT surfaced after the call returns) must
    // not bubble up — without this listener Node treats them as uncaught and
    // tears down the entire agent runtime process.
    proc.on('error', (err: Error) => {
      console.error(`[${LOG_PREFIX}] Expo tunnel error: ${err.message}`)
      if (this.metroProcess === proc) {
        this.metroProcess = null
        this.metroUrl = null
        this.metroPort = null
      }
    })
    // Match either the legacy `exp://` URL or the modern `exp+...://` scheme.
    const expRe = /(exp(?:s|\+[a-z0-9-]+)?:\/\/[^\s]+)/
    // If Expo decides to use a different port than we asked for ("Port 8081
    // is being used ... using port 8082"), capture the new value so the
    // status payload reflects reality.
    const portRebindRe = /[Pp]ort\s+(\d+)\s+(?:is being used|is in use)[\s\S]*?(?:using port\s+|on port\s+)(\d+)/

    const captureUrlFrom = (text: string) => {
      if (this.metroUrl) return
      const m = text.match(expRe)
      if (m) {
        this.metroUrl = m[1]
        console.log(`[${LOG_PREFIX}] Expo tunnel URL: ${this.metroUrl}`)
      }
    }
    const capturePortRebindFrom = (text: string) => {
      const m = text.match(portRebindRe)
      if (m) {
        const newPort = Number(m[2])
        if (Number.isFinite(newPort) && newPort !== this.metroPort) {
          console.log(`[${LOG_PREFIX}] Expo rebound Metro port: ${this.metroPort} -> ${newPort}`)
          this.metroPort = newPort
        }
      }
    }

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      captureUrlFrom(text)
      capturePortRebindFrom(text)
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        appendFileSync(buildLogPath, `[metro-stdout] ${line}\n`)
        this.forwardLogLine(`[metro] ${line}`, 'stdout')
      }
    })
    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      // Expo logs the tunnel URL on stderr in some versions.
      captureUrlFrom(text)
      capturePortRebindFrom(text)
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        appendFileSync(buildLogPath, `[metro-stderr] ${line}\n`)
        this.forwardLogLine(`[metro] ${line}`, 'stderr')
      }
    })
    proc.on('exit', (code, signal) => {
      console.log(`[${LOG_PREFIX}] Expo tunnel exited (code=${code}, signal=${signal})`)
      if (this.metroProcess === proc) {
        this.metroProcess = null
        this.metroUrl = null
        this.metroPort = null
      }
    })

    // Poll up to 30s for the tunnel URL. The tunnel server handshake is
    // network-bound; we don't want to block the runtime indefinitely if
    // ngrok auth or DNS is unhappy.
    const deadline = Date.now() + 30_000
    while (!this.metroUrl && Date.now() < deadline && !proc.killed) {
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!this.metroUrl) {
      console.warn(`[${LOG_PREFIX}] Expo tunnel did not advertise a URL within 30s — leaving metroUrl=null`)
    }
  }

  /**
   * Device-preview metadata. Mirrors what `/preview/metro` returns, but
   * keeps the logic unit-testable without an HTTP layer.
   */
  getDevicePreview(): {
    devServer: DevServerKind
    deviceMode: DeviceMode
    metroUrl: string | null
    metroPort: number | null
    publicUrl: string | null
    message: string | null
    docs: string | null
  } {
    const devServer = this.resolveDevServer()
    if (devServer !== 'metro') {
      return {
        devServer,
        deviceMode: 'not-applicable',
        metroUrl: null,
        metroPort: null,
        publicUrl: null,
        message: null,
        docs: null,
      }
    }
    if (!this.localMode) {
      return {
        devServer: 'metro',
        deviceMode: 'cloud-todo',
        metroUrl: null,
        metroPort: null,
        publicUrl: null,
        message:
          'On-device preview is not yet available in cloud projects. Web preview ' +
          'is rendered via react-native-web in the iframe. To test on a real ' +
          'phone, run this project in Shogo Local Mode (Desktop or self-hosted) ' +
          'and the runtime will start `expo start --tunnel` automatically.',
        docs: 'https://docs.shogo.ai/local-mode/device-preview',
      }
    }
    // Local mode: distinguish "tunnel can't run" (missing @expo/ngrok) from
    // "tunnel is establishing" (running but URL not yet captured). The
    // first state is fixable by the user; the second is just waiting.
    // Recompute ngrok availability on each call so an `expo install
    // @expo/ngrok` while the runtime is up flips the state next refresh.
    const ngrokAvailable = this.hasNgrok(this.bundlerCwd)
    if (!ngrokAvailable) {
      return {
        devServer: 'metro',
        deviceMode: 'local-tunnel-unavailable',
        metroUrl: null,
        metroPort: null,
        publicUrl: null,
        message:
          'On-device preview requires `@expo/ngrok`. Run `bun add @expo/ngrok` ' +
          "in the project root, then click Restart Preview. (Expo declares it " +
          "as an optional peer dep, so it's not always installed automatically.)",
        docs: 'https://docs.expo.dev/more/expo-cli/#tunneling',
      }
    }
    if (!this.metroUrl) {
      return {
        devServer: 'metro',
        deviceMode: 'local-tunnel',
        metroUrl: null,
        metroPort: this.metroPort,
        publicUrl: null,
        message:
          'Expo tunnel is starting (this can take 10–30 seconds on first run). ' +
          'Refresh in a moment to see the QR code.',
        docs: null,
      }
    }
    return {
      devServer: 'metro',
      deviceMode: 'local-tunnel',
      metroUrl: this.metroUrl,
      metroPort: this.metroPort,
      publicUrl: this.metroUrl,
      message: null,
      docs: null,
    }
  }
}
