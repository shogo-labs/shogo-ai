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

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync } from 'fs'
import { createServer } from 'net'
import { createHash } from 'crypto'
import { pkg } from '@shogo/shared-runtime'
import { BUILD_LOG_FILE, CONSOLE_LOG_FILE } from './runtime-log-paths'
import { loadTechStackMeta } from './workspace-defaults'

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

// Template API sidecar port (Hono server.tsx) — NOT the app URL. The app is
// served by the runtime itself on `runtimePort`, and this sidecar is proxied
// at `/api/*`. Fixed for now; see the templateApiPort field in
// `tech-stacks/<stack>/stack.json`.
const API_SERVER_PORT = 3001

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

  constructor(config: PreviewManagerConfig) {
    this.workspaceDir = config.workspaceDir
    this.runtimePort = config.runtimePort
    this.publicUrl = config.publicUrl
    this.onConsoleLogReset = config.onConsoleLogReset
    this.onLogLine = config.onLogLine
    this.localMode = config.localMode ?? detectLocalMode()
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
    // The marker is best-effort: any read/parse failure falls through to a
    // full install, so a corrupted marker can never cause a stale-deps
    // crash — only at most one redundant install.
    const pkgJsonPath = join(installCwd, 'package.json')
    const markerPath = join(installCwd, '.shogo', 'install-marker')

    const computeMarker = (): string | null => {
      try {
        if (!existsSync(pkgJsonPath)) return null
        const raw = readFileSync(pkgJsonPath, 'utf-8')
        return createHash('sha256').update(raw).digest('hex')
      } catch {
        return null
      }
    }

    const expectedHash = computeMarker()
    const recordedHash = (() => {
      try {
        if (!existsSync(markerPath)) return null
        return readFileSync(markerPath, 'utf-8').trim() || null
      } catch {
        return null
      }
    })()

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
      try {
        mkdirSync(join(installCwd, '.shogo'), { recursive: true })
        writeFileSync(markerPath, expectedHash, 'utf-8')
      } catch (err: any) {
        console.warn(`[${LOG_PREFIX}] Could not write install-marker:`, err.message)
      }
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
      // No `frozen: true` here: we're recovering from a stale template
      // node_modules and there's no lockfile from the user yet.
      pkg.installSync(installCwd, { frozen: false })
      timings.install = Date.now() - t0
      console.log(`[${LOG_PREFIX}] Dependencies installed (${timings.install}ms)`)

      // Best-effort marker write — a failure here just means we'll run
      // install one more time on the next start, never anything worse.
      if (expectedHash != null) {
        try {
          mkdirSync(join(installCwd, '.shogo'), { recursive: true })
          writeFileSync(markerPath, expectedHash, 'utf-8')
        } catch (err: any) {
          console.warn(`[${LOG_PREFIX}] Could not write install-marker:`, err.message)
        }
      }
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
    if (this.metroProcess) {
      console.log(`[${LOG_PREFIX}] Stopping Metro bundler...`)
      this.metroProcess.kill('SIGTERM')
      this.metroProcess = null
      this.metroUrl = null
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

    if (!existsSync(join(cwd, 'node_modules', '.bin', 'vite'))) {
      console.log(`[${LOG_PREFIX}] Vite not found in node_modules — skipping watch`)
      return
    }

    console.log(`[${LOG_PREFIX}] Starting vite build --watch...`)

    const viteProcess = spawn('node_modules/.bin/vite', ['build', '--watch'], {
      cwd,
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
    const cwd = this.bundlerCwd
    const serverFile = join(cwd, 'server.tsx')
    if (!existsSync(serverFile)) return

    const buildLogPath = join(cwd, BUILD_LOG_FILE)
    console.log(`[${LOG_PREFIX}] Starting template API server on port ${API_SERVER_PORT}...`)

    const proc = spawn(pkg.bunBinary, ['run', 'server.tsx'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(API_SERVER_PORT),
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
      console.log(`[${LOG_PREFIX}] Template API server exited (code=${code}, signal=${signal})`)
      if (this.apiServerProcess === proc) this.apiServerProcess = null
    })

    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  /**
   * Run `expo export --platform web --output-dir dist` once. The resulting
   * `dist/` is served by the runtime at the root, just like a Vite build.
   * This gives Studio's iframe preview a working web rendering of the RN
   * app via `react-native-web`. Re-run on demand via `restart()`.
   */
  private async runExpoExportWeb(timings: Record<string, number>, cwd: string): Promise<void> {
    const expoBin = join(cwd, 'node_modules', '.bin', 'expo')
    if (!existsSync(expoBin)) {
      console.log(`[${LOG_PREFIX}] expo CLI not found in node_modules — skipping web export`)
      return
    }

    // Build log lives next to the bundler cwd. For Vite stacks that's the
    // legacy `<workspace>/project/` subdir; for Expo stacks it's the
    // workspace root. `resolveBundlerCwd()` is the single source of truth.
    const buildLogPath = join(cwd, BUILD_LOG_FILE)
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true })
    const t0 = Date.now()
    console.log(`[${LOG_PREFIX}] Running expo export --platform web...`)
    await new Promise<void>((resolveExport) => {
      const proc = spawn(expoBin, ['export', '--platform', 'web', '--output-dir', 'dist'], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'development',
          // CI=1 keeps Expo non-interactive (no prompts to install missing deps).
          CI: '1',
        },
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

    const expoBin = join(cwd, 'node_modules', '.bin', 'expo')
    if (!existsSync(expoBin)) {
      console.log(`[${LOG_PREFIX}] expo CLI not found in node_modules — skipping device tunnel`)
      return
    }
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
    const proc = spawn(
      expoBin,
      ['start', '--tunnel', ...portArgs],
      {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CI: '1',
          EXPO_NO_TELEMETRY: '1',
        },
      },
    )

    this.metroProcess = proc
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
