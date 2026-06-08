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
import { createHash } from 'crypto'
import { join } from 'path'
import { existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync, unlinkSync, watch, type FSWatcher } from 'fs'
import { recordBuildEntry } from './runtime-log-dispatcher'
import { scheduleLogWrite } from './runtime-log-writer'
import { checkServerTsxDrift, healServerTsxDrift, captureServerCustomRegions, reapplyServerCustomRegions } from './server-tsx-drift'
import { enforceSchemaHeader, headerIsDowngraded, enforcePrismaConfig, configIsDowngraded } from '@shogo-ai/sdk/generators'
import {
  commitBuildOutputAsync,
  cleanupStagingOutput,
  DEFAULT_STAGING_DIR,
} from './build-output-commit'

/**
 * Append a line to the on-disk runtime build log *and* dispatch it
 * through the runtime-log dispatcher so the Output tab and Monitor pull
 * from the same source. `stream === 'stderr'` upgrades the level to
 * `'error'` so the unseen-error red dot turns on for build failures.
 *
 * The build log lives at `<workspace>/.shogo/logs/build.log` (see
 * `runtime-log-paths.ts`); callers must `ensureRuntimeLogDir()` before
 * the first append so the directory exists.
 *
 * Exported for unit testing — see `__tests__/preview-manager.test.ts`.
 */
export function emitBuildLine(
  buildLogPath: string,
  prefix: string,
  line: string,
  stream: 'stdout' | 'stderr' = 'stdout',
): void {
  if (!line) return
  // Async batched write — see `runtime-log-writer.ts` for rationale.
  // On Windows the previous `appendFileSync` here did a mkdir + open + write +
  // close PER LINE; with Defender that's 5–30ms per write, which during a
  // vite-watch initial build (thousands of lines) saturated the event loop
  // and made the agent-runtime's /health endpoint unreachable.
  scheduleLogWrite(buildLogPath, `${prefix} ${line}\n`)
  recordBuildEntry(`${prefix} ${line}`, stream === 'stderr' ? 'error' : 'info')
}
import { createServer } from 'net'
import { pkg, resolveBinInvocation } from '@shogo/shared-runtime'
import {
  previewBuildLogPath,
  previewConsoleLogPath,
  ensureRuntimeLogDir,
} from './runtime-log-paths'
import {
  loadTechStackMeta,
  computePackageJsonHash,
  readInstallMarker,
  writeInstallMarker,
  readInstallPlatformMarker,
  writeInstallPlatformMarker,
  INSTALL_PLATFORM_TAG,
  findMissingTopLevelDeps,
  migrateLegacyShogoSdkPin,
  runWorkspaceInstall,
} from './workspace-defaults'

const LOG_PREFIX = 'preview-manager'

/**
 * Describes one `vite build --watch` process discovered by the stale-watcher
 * reaper. `pgid` is what we actually kill — the spawn in {@link PreviewManager.startBuildWatch}
 * uses `detached: true` so every vite-watch is its own process-group leader
 * (pgid == pid), and a single `process.kill(-pgid, SIGTERM)` cascades to
 * rollup workers and any other grandchildren in one shot.
 */
export interface StaleViteWatcherInfo {
  pid: number
  pgid: number
  command: string
}

/**
 * Reap orphaned `vite build --watch` processes from prior agent-runtime
 * incarnations that targeted this workspace.
 *
 * Why this exists: {@link PreviewManager.startBuildWatch} spawns vite as
 * its own process-group leader (`detached: true`) so the manager's
 * {@link PreviewManager['killBuildWatchProcessGroup']} can take down vite
 * + its rollup workers with one signal. The cost is that vite no longer
 * lives in the agent-runtime's PGID — and any teardown path that
 * forcibly kills the agent-runtime without going through
 * `PreviewManager.stop()` leaves vite stranded with `PPID=1`. The known
 * triggers in practice:
 *
 *   - macOS jetsam SIGKILL of the bun parent under memory pressure
 *     (the WorkerRuntimeManager's `killProcessGroup` only signals the
 *     agent-runtime's PGID, which doesn't contain vite).
 *   - `WorkerRuntimeManager.stop()`'s 5s `waitForExit` budget elapsing
 *     before agent-runtime's 30s `gracefulShutdown` drain completes,
 *     leading to a SIGKILL race that skips
 *     `previewManager.stop() -> killBuildWatchProcessGroup`.
 *   - Hot reload of the bundled agent-runtime during desktop dev.
 *
 * Without a reaper these orphans accumulate without bound — every
 * incarnation adds one — and each one holds ~1-2GB RSS open for
 * filesystem watchers and rollup native bindings. A single desktop
 * session observed 15+ orphans totalling 27GB before being noticed.
 *
 * The reaper runs at the only point where a new vite-watch is about to
 * enter this workspace, so any pre-existing match by definition belongs
 * to a previous incarnation. We match on:
 *
 *   - argv contains `<workspaceDir>/node_modules/vite/bin/vite.js` —
 *     ties the orphan to THIS workspace's vite install, not some
 *     unrelated project the user is also running.
 *   - argv contains `build --watch` — the canonical watch-mode argv
 *     emitted by {@link PreviewManager.startBuildWatch}.
 *
 * Best-effort: failure to detect (missing `ps`/`Get-CimInstance`, EPERM
 * scanning the process table, malformed output) logs a warning and
 * returns 0 instead of throwing. The worst-case fallout of a missed
 * reap is exactly one extra leaked watcher — strictly no worse than
 * not having the reaper at all.
 *
 * Exported for unit testing — see
 * `__tests__/preview-manager.lifecycle.test.ts`.
 */
export function reapStaleViteWatchers(
  workspaceDir: string,
  opts: {
    /**
     * Returns the raw process-table output to parse. Default uses
     * `ps -A -o pid=,pgid=,command=` on POSIX and PowerShell's
     * `Get-CimInstance Win32_Process` (JSON) on Windows. Test override
     * lets the caller feed deterministic fixtures without touching the
     * real process table.
     */
    listProcesses?: () => string
    /**
     * Sends `signal` to the given process group leader. Default is
     * `process.kill(-pgid, signal)` on POSIX and `taskkill /F /T /PID
     * <pgid>` on Windows. Test override records calls for assertions.
     */
    killGroup?: (pgid: number, signal: NodeJS.Signals) => void
    /** Override `process.pid` for tests. */
    selfPid?: number
    /** Override `process.platform` for tests. */
    platform?: NodeJS.Platform
    logger?: Pick<Console, 'log' | 'warn'>
  } = {},
): StaleViteWatcherInfo[] {
  const logger = opts.logger ?? console
  const platform = opts.platform ?? process.platform
  const selfPid = opts.selfPid ?? process.pid
  const isWindows = platform === 'win32'

  // The argv substring we use to claim a process as "ours". Tying it to
  // the workspace's vite binary (rather than just "any bun running
  // vite.js build --watch") is what keeps the reaper from mis-attributing
  // an unrelated vite-watch in some other workspace.
  const viteBinFragment = join(workspaceDir, 'node_modules', 'vite', 'bin', 'vite.js')

  let raw = ''
  try {
    raw = opts.listProcesses
      ? opts.listProcesses()
      : isWindows
        ? execSync(
            'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ' +
              'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"',
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          )
        : execSync('ps -A -o pid=,pgid=,command=', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          })
  } catch (err: any) {
    logger.warn(
      `[${LOG_PREFIX}] reapStaleViteWatchers: process table scan failed (${err?.message ?? err}) — ` +
        `skipping orphan reap (worst case: one extra leaked vite-watch this restart)`,
    )
    return []
  }

  const matches = isWindows
    ? parseWindowsCimJson(raw, viteBinFragment, selfPid)
    : parsePosixPs(raw, viteBinFragment, selfPid)

  if (matches.length === 0) return []

  logger.log(
    `[${LOG_PREFIX}] reapStaleViteWatchers: found ${matches.length} orphan vite-watch ` +
      `process(es) from prior incarnation(s); reaping pgid(s)=${matches.map((m) => m.pgid).join(',')}`,
  )

  const killGroup =
    opts.killGroup ??
    (isWindows
      ? (pgid: number) => {
          try {
            execSync(`taskkill /F /T /PID ${pgid}`, { stdio: ['pipe', 'pipe', 'pipe'] })
          } catch {
            // Already dead / permission denied — best-effort, no log
            // (we already announced the reap above).
          }
        }
      : (pgid: number, signal: NodeJS.Signals) => {
          try {
            process.kill(-pgid, signal)
          } catch {
            // ESRCH = group already empty (process exited between our
            // ps scan and the kill). Happy path.
          }
        })

  // SIGTERM each match. We wrap every call in try/catch even though
  // the default `killGroup` already swallows its own errors — an
  // injected override (tests; or any future callsite) must not be
  // able to short-circuit the loop by throwing on one PGID. One
  // stale group's kill failing should never block reaping the rest.
  // ESRCH (group exited between our scan and kill) is the common
  // happy-path throw on POSIX; we don't log it because we already
  // announced the reap above.
  for (const m of matches) {
    try {
      killGroup(m.pgid, 'SIGTERM')
    } catch {
      /* swallow — see comment above */
    }
  }

  return matches
}

/**
 * Parse `ps -A -o pid=,pgid=,command=` output and select rows that
 * represent an orphaned vite-watch for {@link workspaceDir}. The leading
 * `=` in each `-o` selector suppresses the header row so every line is
 * a tuple — but `ps` still right-pads the numeric columns, so we split
 * on whitespace and recover the command as the slice from index 2
 * onward (preserving any spaces inside the path, e.g. macOS's
 * `Application Support`).
 */
function parsePosixPs(
  output: string,
  viteBinFragment: string,
  selfPid: number,
): StaleViteWatcherInfo[] {
  const out: StaleViteWatcherInfo[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    const pgid = Number(parts[1])
    if (!Number.isFinite(pid) || !Number.isFinite(pgid)) continue
    if (pid === selfPid) continue
    const command = parts.slice(2).join(' ')
    if (!command.includes(viteBinFragment)) continue
    if (!command.includes('build --watch')) continue
    out.push({ pid, pgid, command })
  }
  return out
}

/**
 * Parse PowerShell's `Get-CimInstance Win32_Process | ConvertTo-Json`
 * output. Windows has no PGID concept; we treat each matching ProcessId
 * as its own "group" because the kill path on Windows is `taskkill /T`,
 * which walks the process tree from a single PID regardless of how the
 * tree was originally formed.
 *
 * `ConvertTo-Json` collapses a single-element result to an object
 * instead of a one-element array, so we coerce both shapes.
 */
function parseWindowsCimJson(
  output: string,
  viteBinFragment: string,
  selfPid: number,
): StaleViteWatcherInfo[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output.trim() || '[]')
  } catch {
    return []
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  const out: StaleViteWatcherInfo[] = []
  // Windows-style separators inside `viteBinFragment` won't match the
  // CIM CommandLine string on a path that was passed with forward
  // slashes (or vice versa). Normalize both sides to forward-slash so
  // a workspace under `C:\Users\...` matches a CommandLine spelled
  // `C:/Users/...` and the reverse.
  const needle = viteBinFragment.replace(/\\/g, '/')
  for (const row of arr as Array<Record<string, unknown>>) {
    if (!row || typeof row !== 'object') continue
    const pidRaw = row.ProcessId
    const cmdRaw = row.CommandLine
    if (typeof pidRaw !== 'number' || typeof cmdRaw !== 'string') continue
    if (pidRaw === selfPid) continue
    const command = cmdRaw.replace(/\\/g, '/')
    if (!command.includes(needle)) continue
    if (!command.includes('build --watch')) continue
    out.push({ pid: pidRaw, pgid: pidRaw, command: cmdRaw })
  }
  return out
}

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
  /** Clear agent `consoleLogs` buffer when `.shogo/logs/console.log` is reset (preview start). */
  onConsoleLogReset?: () => void
  /**
   * Forward a single line of Metro/Expo bundler output to the runtime's
   * console log buffer. Same downstream destination as the
   * `/console-log/append` endpoint that apps/api hits for Vite output —
   * this just routes Metro lines to the same place without going over
   * HTTP, so the studio's "Server" tab shows them live.
   *
   * If unset, Metro output only lands in `.shogo/logs/build.log` on disk.
   */
  onLogLine?: (line: string, stream: 'stdout' | 'stderr') => void
  /**
   * Fires once per successful `vite build --watch` rebuild — invoked
   * when we see vite's `built in N ms` line on stdout. Wired by
   * `AgentGateway` to `CanvasFileWatcher.broadcastReload()` so the
   * canvas iframe gets the "Update available" toast that used to be
   * driven by `CanvasBuildManager.onBuildComplete`.
   *
   * Why this lives on PreviewManager: vite-watch *is* the canvas
   * builder for vite stacks now — see `canvas-build-manager.ts`'s
   * file-level docstring on the Windows EPERM race. Without this
   * callback, vite-watch rebuilds land silently and users have to
   * notice on their own that the iframe content changed.
   *
   * Only invoked by the watch-mode build (`startBuildWatch`); the
   * one-shot seed (`runViteOneShotBuild`) doesn't fire it because no
   * SSE subscribers are connected during that early-boot window. For
   * Metro/Expo stacks vite-watch never runs and the callback stays
   * silent — those stacks are still driven by CanvasBuildManager.
   */
  onBuildComplete?: () => void
  /**
   * Local mode (developer machine, Shogo Desktop) versus cloud (Knative pod).
   * In local mode we can spawn `expo start --tunnel` to expose Metro to a real
   * phone via Expo's tunnel infrastructure; in cloud mode we ship only the web
   * preview (`expo export -p web`) and surface a "device preview not yet
   * available in cloud" indicator. Defaults to auto-detecting via
   * `KUBERNETES_SERVICE_HOST` / `SHOGO_RUNTIME_MODE`.
   */
  localMode?: boolean
  /**
   * Explicit API sidecar (`server.tsx`) port for this manager. When unset
   * the port is resolved from `API_SERVER_PORT` / `SKILL_SERVER_PORT` env
   * (the process-global single-project contract).
   *
   * Workspace runtimes run **multiple** PreviewManagers in one process —
   * one per attached project — so they cannot share the single env-derived
   * port. Each per-project manager is constructed with a distinct `apiPort`
   * so their `server.tsx` sidecars don't collide and the path-prefixed
   * `/p/<projectId>/api/*` proxy can route to the right one.
   */
  apiPort?: number
  /**
   * Public base path the built app is served under. Single-project
   * runtimes serve `dist/` at `/` (base unset → vite default `/`).
   * Workspace runtimes serve each project under `/p/<projectId>/`, so
   * the bundle must be built with that base or every absolute asset URL
   * (`/assets/app.js`) would 404 against the runtime root instead of the
   * project's prefix. When set, it is passed to `vite build` as
   * `--base <basePath>`. Must start and end with `/` (e.g. `/p/abc/`).
   */
  basePath?: string
  /**
   * The attached project id this manager serves, in a workspace runtime.
   * Used to select that project's isolated `DATABASE_URL` from the
   * `WORKSPACE_DATABASE_URLS` env map (cloud per-project DB sidecars). Unset
   * for single-project runtimes, which fall back to the per-cwd sqlite file.
   */
  projectId?: string
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

// Matches vite's per-rebuild summary line in `--watch` mode:
//   "built in 1234ms."
//   "built in 2.96s"
// Both forms appear in the wild; the unit varies depending on whether
// vite formatted using its ms or seconds branch. Anchored on the
// distinctive `built in <number>` prefix so we don't false-positive on
// user app output. ANSI-color sequences are stripped by .trim() but
// the escape codes themselves can still appear in the chunk, so we
// don't anchor at the start of the line.
const BUILT_IN_MS_PATTERN = /built in \d/

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

/**
 * Build the env passed to the spawned `bun run server.tsx` API sidecar.
 *
 * Three things go in beyond `parentEnv`:
 *
 *   1. `PORT` / `API_SERVER_PORT` / `SKILL_SERVER_PORT` — the canonical
 *      Bun.serve input plus two legacy aliases the SDK template scripts
 *      and rolled-back binaries still consult. Always overridden so the
 *      sidecar binds to the port `PreviewManager` chose, not whatever
 *      the parent had.
 *   2. `DATABASE_URL` — pinned to the workspace's local sqlite file so
 *      Prisma in the sidecar talks to the same db the runtime's other
 *      tools (db studio, generate, etc.) do.
 *   3. `SHOGO_API_URL` (local-mode default only) — when the parent
 *      process declared `SHOGO_LOCAL_MODE=true` but didn't itself
 *      export `SHOGO_API_URL`, inject `http://localhost:8002` so the
 *      `@shogo-ai/sdk` voice/chat client in the sidecar reaches the
 *      local Shogo API instead of falling back to `api.shogo.ai`.
 *      In cloud, `SHOGO_LOCAL_MODE` is unset and the warm-pool
 *      launcher already pins `SHOGO_API_URL` on the parent, so this
 *      branch is a no-op. An explicit override on the parent always
 *      wins.
 *
 * Exported for direct unit testing (mocking `spawn` to capture env is
 * fiddly and slow; this is the small pure surface that actually matters).
 */
export function resolveApiServerEnv(input: {
  parentEnv: NodeJS.ProcessEnv
  portStr: string
  cwd: string
  /**
   * Workspace runtimes pass the project id this sidecar serves so we can
   * select its isolated DB from `WORKSPACE_DATABASE_URLS` (a JSON map
   * projectId→DATABASE_URL set by the API when each attached project gets a
   * provisioned cloud DB). Falls back to the per-cwd sqlite file when the
   * map is absent or has no entry — which is the local/desktop default and
   * the single-project behaviour (projectId unset).
   */
  projectId?: string
}): Record<string, string> {
  const { parentEnv, portStr, cwd, projectId } = input
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parentEnv)) {
    if (typeof v === 'string') out[k] = v
  }
  // Capture the agent runtime's own listening port BEFORE we overwrite
  // PORT below — the sidecar's @shogo-ai/sdk/tools/server proxy needs
  // RUNTIME_PORT to forward `/api/tools/*` calls back to the runtime
  // over `127.0.0.1`. parentEnv.PORT is the runtime's port; portStr is
  // the sidecar's own bind port.
  out.RUNTIME_PORT = parentEnv.PORT ?? '8080'
  out.PORT = portStr
  out.API_SERVER_PORT = portStr
  out.SKILL_SERVER_PORT = portStr
  out.DATABASE_URL = resolveSidecarDatabaseUrl(parentEnv, cwd, projectId)
  // The merged map is a workspace transport detail — the sidecar must not
  // see a sibling project's connection string.
  delete out.WORKSPACE_DATABASE_URLS
  if (parentEnv.SHOGO_LOCAL_MODE === 'true' && !parentEnv.SHOGO_API_URL) {
    out.SHOGO_API_URL = 'http://localhost:8002'
  }
  return out
}

/**
 * Resolve the `DATABASE_URL` for a project's API sidecar. Prefers a
 * per-project entry in the `WORKSPACE_DATABASE_URLS` env map (cloud
 * provisioned DBs in workspace mode); otherwise pins the local sqlite file
 * inside the project's own working directory (per-subfolder isolation).
 */
function resolveSidecarDatabaseUrl(
  parentEnv: NodeJS.ProcessEnv,
  cwd: string,
  projectId?: string,
): string {
  const sqliteDefault = `file:${join(cwd, 'prisma', 'dev.db')}`
  if (!projectId) return sqliteDefault
  const raw = parentEnv.WORKSPACE_DATABASE_URLS
  if (!raw) return sqliteDefault
  try {
    const map = JSON.parse(raw)
    const url = map?.[projectId]
    return typeof url === 'string' && url.length > 0 ? url : sqliteDefault
  } catch {
    // Malformed map — fall back to sqlite rather than break the sidecar.
    return sqliteDefault
  }
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

/**
 * Detect the npm-published `@shogo-ai/sdk@0.4.0` build, which ships
 * `bin/cli.mjs` with an unquoted `execSync(\`bun ${absScriptPath}\`)`
 * that truncates the path at the first space. macOS desktop installs
 * live under `~/Library/Application Support/` — every path contains a
 * space — so the truncation is universal, not edge-case. The fix is
 * in HEAD but was never published (npm jumps 0.4.0 → 1.0.0), so
 * runtime version-sniffing is the only way to recognise the bad
 * install. Best-effort: any read/parse failure returns false (we'd
 * rather risk a redundant install than refuse to use a healthy CLI).
 */
function isKnownBrokenSdkInstall(sdkPkgDir: string): boolean {
  try {
    const pkgJsonPath = join(sdkPkgDir, 'package.json')
    if (!existsSync(pkgJsonPath)) return false
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
    return pkg?.version === '0.4.0'
  } catch {
    return false
  }
}

export class PreviewManager {
  private workspaceDir: string
  private runtimePort: number
  private publicUrl?: string
  private basePath?: string
  private workspaceProjectId?: string
  private onConsoleLogReset?: () => void
  private onBuildComplete?: () => void
  private buildWatchProcess: ChildProcess | null = null
  private apiServerProcess: ChildProcess | null = null
  /**
   * True once the spawned `server.tsx` process has been observed to bind
   * its port (either the in-process `/health` poll returned 2xx OR the
   * best-effort "process up, /health silent" fallback fired in
   * `startApiServer`). Distinct from `apiPhase === 'healthy'` because
   * phase advances synchronously while `apiListening` only flips once
   * we have positive evidence that fetch() will reach the server.
   *
   * Gates the public `apiServerPort` getter so the `/api/*` proxy in
   * `server.ts` doesn't race the spawn → bind gap: previously
   * `apiServerProcess` was assigned the moment `spawn()` returned,
   * which meant `apiServerPort` reported a port before Bun.serve had
   * actually listened. The SPA's first fetch then landed in that gap
   * and the proxy returned a hard 502.
   *
   * Reset to `false` on every exit / kill / restart so a crashed
   * server doesn't keep advertising a listening port.
   */
  private apiListening = false
  private metroProcess: ChildProcess | null = null
  private metroUrl: string | null = null
  private metroPort: number | null = null
  private schemaWatcher: FSWatcher | null = null
  private schemaTimer: ReturnType<typeof setTimeout> | null = null
  // SHA-1 of the last `prisma/schema.prisma` content we acted on. Used by
  // the watcher to drop spurious wakes (Windows fs.watch fires
  // FILE_NOTIFY_CHANGE_ATTRIBUTES on read-only opens by `prisma generate`,
  // `prisma db push`, the gateway's per-turn `getSchemaModels()`, etc. —
  // none of which actually mutate the file). Without this guard each
  // wake kicked off a 4 s regen + restart loop that re-armed itself
  // because the spawned generators reopen the file.
  private lastSchemaHash: string | null = null
  private customRoutesWatcher: FSWatcher | null = null
  private customRoutesTimer: ReturnType<typeof setTimeout> | null = null
  private apiPhase: ApiServerPhase = 'idle'
  // Disambiguates "this project has no API sidecar" from "the sidecar
  // hasn't come up yet" for `getStatus().apiReady`. `null` until
  // `startApiServer()` decides; `true` once it commits to spawning
  // `server.tsx`; `false` when it returns without a sidecar to run.
  // Without this, `apiPhase === 'idle'` is ambiguous (no-server vs.
  // not-started-yet), which would let the client load the UI during the
  // window before the sidecar is spawned.
  private hasApiServer: boolean | null = null
  private regenerating = false
  private pendingSchemaChange = false
  // When true, the schema watcher defers regen instead of acting on a
  // change. Used by `shogo push` (SDK) to run prisma generate + db push
  // itself without racing a concurrent watcher-driven restart (the classic
  // EADDRINUSE source). Resumed via resumeWatchers(), which flushes any
  // change that landed while paused.
  private watchersPaused = false
  private lastGenerateError: string | null = null
  // Surfaced via getStatus() so external observers (the API's import
  // bootstrap bridge, debug UIs, etc.) can tell "install/prisma succeeded"
  // apart from "install/prisma threw but phase marched forward anyway".
  // The previous behaviour swallowed errors silently — the bridge would
  // report every step as `ok` once the pod reached `ready` even when the
  // project was fundamentally broken. See SHOG-592 review notes.
  private lastInstallError: string | null = null
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
   * Reentrancy guard for `runExpoExportWeb`. Without it, the staging-pod
   * boot path can spawn `expo export --platform web` twice in parallel:
   *   - Once via `start() -> backgroundSetupMetro()` (fire-and-forget).
   *   - Once via a second `start()`/`restart()` call slipping through
   *     before `this.started` is observed by the caller.
   *
   * Each invocation forks ~6 jest-worker children and competes for the
   * same `dist.staging/` output dir, doubling Metro's already-heavy
   * memory footprint and producing the OOM kills we saw in staging on
   * 2026-05-13 (project 9e7ecdc7-...). The guard keeps the export
   * strictly serial — concurrent callers receive the in-flight promise.
   */
  private expoExportInFlight: Promise<void> | null = null
  /**
   * Port the spawned project API server (`server.tsx`) binds to. Resolved
   * once in the constructor — subsequent `process.env` mutations don't
   * hot-swap the bound port mid-flight.
   */
  private readonly apiPort: number

  /**
   * Promise that resolves after the first `installDepsIfNeeded()` call
   * settles (success OR caught failure). Created up-front so callers can
   * await it before `start()` is invoked.
   *
   * The canvas build manager awaits this before spawning `vite build`,
   * which closes a race that broke every VM-isolated session:
   *
   *   1. Pool-assign fires `pm.start()` in the background (fire-and-forget
   *      at server.ts:3660), then immediately calls `startGateway()`.
   *   2. The gateway constructs `CanvasBuildManager` and runs
   *      `runBuild()` while bun-install is still extracting packages.
   *   3. On a macOS host, the workspace's `node_modules` was populated by
   *      the host's `ensureWorkspaceDeps` and is 9p-mounted into the linux
   *      guest. The host install (Darwin arm64) installed
   *      `@rollup/rollup-darwin-arm64` and SKIPPED
   *      `@rollup/rollup-linux-arm64-gnu` (rollup ships its natives as
   *      optionalDependencies filtered by `os`/`cpu`). Vite-config-loader
   *      → rollup → `requireWithFriendlyError` → `Cannot find module
   *      @rollup/rollup-linux-arm64-gnu`. The error propagates out of
   *      vite as `undefined`, which is what shows up in main.log:
   *
   *        [CanvasBuildManager] Build error: failed to load config from
   *          /host-workspaces/<projectId>/vite.config.ts
   *        error during build: undefined
   *
   *   4. The in-guest `bun install` triggered by step 1 WOULD have
   *      installed the linux-arm64 rollup native (bun honors `os`/`cpu`
   *      relative to the running platform, not the lockfile's), but the
   *      build had already failed and torn down dist.staging/ by the
   *      time it finished — visible in main.log as a missing
   *      "Dependencies installed" line preceding the canvas error.
   *
   * Awaiting depsReady before the build closes the race. The promise is
   * best-effort: any throw inside `installDepsIfNeeded` is caught and
   * the promise still resolves (we'd rather attempt a build and report
   * the real error than hang the build forever).
   */
  private depsReadyResolve: (() => void) | null = null
  private depsReadyPromise: Promise<void>
  /**
   * `true` once `installDepsIfNeeded` has settled at least once. Used by
   * `depsReady` getter callers to distinguish "still pending" from
   * "already done" without re-awaiting a resolved promise.
   */
  private _depsSettled = false

  constructor(config: PreviewManagerConfig) {
    this.workspaceDir = config.workspaceDir
    this.runtimePort = config.runtimePort
    this.publicUrl = config.publicUrl
    this.onConsoleLogReset = config.onConsoleLogReset
    this.onBuildComplete = config.onBuildComplete
    this.onLogLine = config.onLogLine
    this.localMode = config.localMode ?? detectLocalMode()
    this.apiPort = config.apiPort ?? resolveApiServerPort()
    this.basePath = config.basePath
    this.workspaceProjectId = config.projectId
    this.depsReadyPromise = new Promise<void>((resolve) => {
      this.depsReadyResolve = resolve
    })
  }

  /**
   * Wire (or rewire) the rebuild-complete callback at runtime. Used by
   * AgentGateway, which has access to the CanvasFileWatcher singleton
   * but is constructed *after* PreviewManager (server.ts creates pm at
   * boot, gateway later via attachPreviewManager). Idempotent — calling
   * again replaces the previous subscriber.
   */
  setOnBuildComplete(cb: (() => void) | undefined): void {
    this.onBuildComplete = cb
  }

  /**
   * Resolves once `installDepsIfNeeded()` has run to completion (or has
   * given up and logged the failure). Idempotent and safe to await from
   * multiple callers; safe to await before `start()` has been invoked.
   *
   * Note: this does NOT signal that the API server is up or that
   * `dist/` exists. It is strictly an "install has stopped touching
   * node_modules" gate. The build manager uses it to ensure platform-
   * specific native bindings are present before invoking vite/rollup.
   */
  get depsReady(): Promise<void> {
    return this.depsReadyPromise
  }

  /**
   * True once depsReady has resolved at least once. Read-only mirror of
   * the resolved-state of `depsReadyPromise` for sync callers.
   */
  get depsSettled(): boolean {
    return this._depsSettled
  }

  /**
   * Best-effort log forwarding — never throws, never blocks. Called from
   * the Metro/Expo stdout+stderr pumps so `.shogo/logs/build.log` and the
   * runtime's live console buffer stay in sync.
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

  /**
   * Port the project's API sidecar (`server.tsx`) is currently
   * listening on, or `null` if it isn't accepting connections.
   *
   * Returns the port only when (a) a process has been spawned and (b)
   * we have positive evidence (`apiListening`) that the process has
   * actually bound the port. Returning the port the moment `spawn()`
   * resolved — the pre-2026-05-25 behaviour — created a window where
   * `/api/*` proxy callers would attempt to fetch a port Bun.serve
   * hadn't bound yet and got ECONNREFUSED → hard 502.
   *
   * The `/api/*` proxy in `server.ts` pairs this with a short polling
   * grace window when `apiServerPhase ∈ {starting,restarting,
   * generating}` so transient `null` here doesn't immediately error
   * out the SPA's first fetch on a fresh project.
   */
  get apiServerPort(): number | null {
    if (!this.apiServerProcess || this.apiServerProcess.killed) return null
    return this.apiListening ? this.apiPort : null
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

  /** Last error from `bun run generate` (or its fallback), or null on success. */
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

  /**
   * SHA-1 hex digest of `prisma/schema.prisma`'s raw bytes. Returns
   * `null` when the file is missing or unreadable. Used by the schema
   * watcher to distinguish real edits from spurious `change` events
   * (NTFS attribute-change notifications fired when other processes
   * open the file read-only — see `lastSchemaHash` field comment).
   */
  private computeSchemaHash(): string | null {
    const schemaPath = join(this.bundlerCwd, 'prisma', 'schema.prisma')
    if (!existsSync(schemaPath)) return null
    try {
      return createHash('sha1').update(readFileSync(schemaPath)).digest('hex')
    } catch {
      return null
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
   *      that points directly at the SDK CLI's source file and is the
   *      canonical surface for project-specific tweaks (e.g. running
   *      `db:push` afterwards, pausing the watcher around the writes,
   *      etc.).
   *   2. Otherwise, if the SDK is installed in `node_modules/`, run
   *      `bun ./node_modules/@shogo-ai/sdk/bin/cli.mjs generate`
   *      directly. This bypasses `node_modules/.bin/shogo` so we don't
   *      need a working bin shim — pre-warmed templates and partial
   *      installs can leave node_modules in place without bin shims, in
   *      which case `bun x shogo` would fall through to npm and 404
   *      (since `@shogo-ai/sdk` publishes a `shogo` bin but no `shogo`
   *      package exists on npm).
   *   3. As a last-ditch fallback, run `bun x shogo generate` so an
   *      ancient workspace whose lockfile somehow predates the SDK
   *      install can still re-fetch the bin from a (future) registry
   *      entry. Today this just produces a clear 404 for
   *      `@shogo-ai/sdk`-less workspaces, which is better than a silent
   *      hang.
   *
   * All paths read the workspace's `shogo.config.json` (when it
   * exists), so generated `server.tsx` ends up with the right
   * `customRoutesPath`, `dynamicCrudImport`, and `bunServe` settings
   * regardless of which entry point was used.
   *
   * Returns false on any failure; the error message is exposed via
   * `apiLastGenerateError` for the caller to surface to the agent.
   */
  /**
   * Guard the protected `prisma/schema.prisma` header against a stray
   * `write_file` that downgrades it — most damagingly an agent rewriting the
   * whole schema from a Prisma-5/6 memory and re-introducing
   * `url = env("DATABASE_URL")` in the datasource (a hard `P1012` error on
   * Prisma 7) or the legacy `prisma-client-js` generator. Runs immediately
   * before the schema is consumed by `shogo generate` / `prisma db push`, so a
   * downgrade never reaches Prisma. The agent's models are preserved; only the
   * generator/datasource header is restored (and re-wrapped in SHOGO:CUSTOM
   * markers). No-op when the header is already Prisma-7-correct.
   */
  private healSchemaHeader(): boolean {
    const schemaPath = join(this.bundlerCwd, 'prisma', 'schema.prisma')
    if (!existsSync(schemaPath)) return false
    let schema: string
    try {
      schema = readFileSync(schemaPath, 'utf-8')
    } catch {
      return false
    }
    if (!headerIsDowngraded(schema)) return false

    let repaired: string
    try {
      repaired = enforceSchemaHeader(schema)
    } catch (err: any) {
      console.error(`[${LOG_PREFIX}] schema-header guard failed: ${err?.message ?? err}`)
      return false
    }
    if (repaired === schema) return false

    try {
      writeFileSync(schemaPath, repaired, 'utf-8')
    } catch (err: any) {
      console.error(`[${LOG_PREFIX}] schema-header guard write failed: ${err?.message ?? err}`)
      return false
    }
    // Keep the watcher from treating our own corrective write as a new edit.
    this.lastSchemaHash = createHash('sha1').update(repaired, 'utf-8').digest('hex')
    console.warn(
      `[${LOG_PREFIX}] Restored protected prisma/schema.prisma header ` +
        `(stripped datasource url / legacy generator provider that would break Prisma 7).`,
    )
    return true
  }

  /**
   * Sibling of {@link healSchemaHeader} for `prisma.config.ts`. When a stray
   * write dropped the Prisma-7-required `datasource.url` (e.g. moved it under a
   * `migrate`/`async url()` resolver — the shape weaker models produce), restore
   * the canonical config so `prisma db push` / `generate` can resolve the
   * datasource URL. `prisma.config.ts` isn't watched, so no hash bookkeeping is
   * needed; the heal is idempotent and only writes when the config is broken.
   */
  private healPrismaConfig(): boolean {
    const configPath = join(this.bundlerCwd, 'prisma.config.ts')
    if (!existsSync(configPath)) return false
    let config: string
    try {
      config = readFileSync(configPath, 'utf-8')
    } catch {
      return false
    }
    if (!configIsDowngraded(config)) return false

    let repaired: string
    try {
      repaired = enforcePrismaConfig(config)
    } catch (err: any) {
      console.error(`[${LOG_PREFIX}] prisma-config guard failed: ${err?.message ?? err}`)
      return false
    }
    if (repaired === config) return false

    try {
      writeFileSync(configPath, repaired, 'utf-8')
    } catch (err: any) {
      console.error(`[${LOG_PREFIX}] prisma-config guard write failed: ${err?.message ?? err}`)
      return false
    }
    console.warn(
      `[${LOG_PREFIX}] Restored prisma.config.ts datasource.url ` +
        `(agent wrote a config without datasource.url; prisma db push would fail).`,
    )
    return true
  }

  private async runShogoGenerate(): Promise<boolean> {
    const cwd = this.bundlerCwd
    // Protect the generator+datasource header before the codegen pipeline
    // (which runs `prisma generate`) reads the schema.
    this.healSchemaHeader()
    this.healPrismaConfig()
    const pkgJsonPath = join(cwd, 'package.json')
    if (!existsSync(pkgJsonPath)) return false

    this.apiPhase = 'generating'
    this.lastGenerateError = null
    const start = Date.now()

    // Prefer the project's own `generate` script when one exists. The
    // runtime template ships `"generate": "bun ./node_modules/@shogo-ai/sdk/bin/cli.mjs generate"`,
    // so both paths converge on the SDK CLI's published entry file; the
    // indirection lets user-customised projects splice extra steps into
    // the pipeline without us having to teach PreviewManager about every
    // variation.
    //
    // EXCEPTION: legacy workspaces (pre-May 2026) carry the older
    // `"generate": "bunx shogo generate"` script in their package.json.
    // `bunx shogo` resolves to the only published `@shogo-ai/sdk` version
    // that satisfies the pinned `^0.4.0` constraint — namely 0.4.0,
    // which has the unquoted-`execSync` path-truncation bug. The fix
    // (commit 68ab3e7d, May 8) was tagged as 0.4.1 internally but never
    // published; npm's @shogo-ai/sdk goes 0.4.0 → 1.0.0 with no 0.4.x
    // patch in between. Until the user upgrades their pin (or 0.4.1
    // gets published), we must NOT honour that script — it will crash
    // every workspace whose path contains a space (which is every
    // standard macOS install under "~/Library/Application Support").
    let useBunRun = false
    let legacyShogoGenerate = false
    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as {
        scripts?: Record<string, string>
      }
      const gen = pkgJson.scripts?.generate?.trim()
      if (gen) {
        // Match `bunx shogo …` and `bun x shogo …`, with or without
        // `--bun`. We deliberately do NOT match the runtime-template
        // form `bun ./node_modules/@shogo-ai/sdk/bin/cli.mjs generate`
        // — that path-based form is path-safe.
        if (/^\s*(bunx|bun\s+x)(\s+--bun)?\s+shogo(\s|$)/.test(gen)) {
          legacyShogoGenerate = true
        } else {
          useBunRun = true
        }
      }
    } catch {
      // Malformed package.json — fall through to the path-based CLI.
    }

    // Fallback resolution. We prefer the file-path form because
    // `bun x shogo` resolves through `node_modules/.bin/` first and
    // then through the npm registry — and there is no `shogo` package
    // on npm (the bin name is owned by `@shogo-ai/sdk`). Workspaces
    // bootstrapped without a working `.bin/` shim (pre-warmed templates,
    // crashed installs, etc.) would 404 there.
    const sdkCliPath = join(cwd, 'node_modules', '@shogo-ai', 'sdk', 'bin', 'cli.mjs')
    const hasSdkCli = existsSync(sdkCliPath)
    // The installed CLI in node_modules is whatever version `bun install`
    // resolved — frequently the broken `@shogo-ai/sdk@0.4.0` that ships
    // an `execSync(\`bun ${absScriptPath}\`)` for the Step 2 script
    // (templating the path into the shell command line truncates it on
    // the first space, blowing up with `Module not found
    // "/Users/foo/Library/Application"` on every macOS install). 0.4.1
    // never made it to the npm registry, so the installed copy stays
    // broken indefinitely. Detect that exact version and refuse to use it.
    const installedSdkBroken = hasSdkCli && isKnownBrokenSdkInstall(join(cwd, 'node_modules', '@shogo-ai', 'sdk'))
    const useInstalledCli = hasSdkCli && !installedSdkBroken
    // Bundled with the desktop app at packaging time. Set by
    // apps/desktop/src/local-server.ts. In dev mode it points at the
    // monorepo source; in packaged mode at `Resources/sdk-cli.mjs`.
    const bundledSdkCli = process.env.SHOGO_BUNDLED_SDK_CLI
    const hasBundledSdkCli = !!(bundledSdkCli && existsSync(bundledSdkCli))

    if (installedSdkBroken) {
      console.warn(
        `[${LOG_PREFIX}] installed @shogo-ai/sdk has a known path-truncation bug — ignoring it in favour of bundled CLI`,
      )
    }

    // Resolution order, in priority:
    //   1. project-local node_modules CLI — only when NOT the known-broken
    //      0.4.0 build (path-safe in 0.4.1+ / 1.x)
    //   2. desktop-bundled CLI (always path-safe in HEAD)
    //   3. project's `generate` script (only if it isn't the broken
    //      `bunx shogo` pattern)
    //   4. `bun x shogo` last-ditch (broken on space-paths, but better
    //      than nothing for non-macOS installs)
    let args: string[]
    let cmdLabel: string
    if (legacyShogoGenerate && useInstalledCli) {
      args = [sdkCliPath, 'generate']
      cmdLabel = 'bun ./node_modules/@shogo-ai/sdk/bin/cli.mjs generate (legacy script bypass)'
    } else if (legacyShogoGenerate && hasBundledSdkCli) {
      args = [bundledSdkCli!, 'generate']
      cmdLabel = `bun ${bundledSdkCli} generate (legacy script bypass — bundled fallback)`
    } else if (installedSdkBroken && hasBundledSdkCli) {
      args = [bundledSdkCli!, 'generate']
      cmdLabel = `bun ${bundledSdkCli} generate (broken installed SDK — bundled fallback)`
    } else if (useBunRun && !installedSdkBroken) {
      args = ['run', 'generate']
      cmdLabel = 'bun run generate'
    } else if (useInstalledCli) {
      args = [sdkCliPath, 'generate']
      cmdLabel = 'bun ./node_modules/@shogo-ai/sdk/bin/cli.mjs generate'
    } else if (hasBundledSdkCli) {
      args = [bundledSdkCli!, 'generate']
      cmdLabel = `bun ${bundledSdkCli} generate (bundled fallback)`
    } else {
      args = ['x', 'shogo', 'generate']
      cmdLabel = 'bun x shogo generate'
    }
    console.log(`[${LOG_PREFIX}] Running ${cmdLabel} at ${cwd}...`)

    // Preserve any SHOGO:CUSTOM regions in server.tsx (e.g. custom tenant
    // middleware) across this regeneration. Captured before the overwrite,
    // re-applied after a successful generate. No-op when there are none.
    const preservedRegions = captureServerCustomRegions(cwd)

    const generateOk = await new Promise<boolean>((resolveResult) => {
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

    if (generateOk) reapplyServerCustomRegions(preservedRegions)
    return generateOk
  }

  /**
   * Watch `prisma/schema.prisma` for changes. When the agent edits the
   * schema, debounce briefly, then run `shogo generate` and restart the
   * API server.
   *
   * Uses `fs.watch` on the parent directory because `prisma/` may not
   * exist when the watcher first starts (older workspaces, fresh
   * clones). The handler ignores events for unrelated files.
   *
   * Guards against spurious events with a content-hash check (see
   * `lastSchemaHash`): on Windows, NTFS fires FILE_NOTIFY_CHANGE_*
   * notifications when other processes (the gateway's per-turn
   * `getSchemaModels()`, `prisma generate` / `prisma db push`
   * subprocesses kicked off by an earlier regen) merely open the file
   * for read. Without the hash check each spurious wake re-armed the
   * full kill-server → generate → restart cycle.
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

    // Seed the baseline so the first post-boot wake compares against
    // the on-disk state instead of `null` (which would always count as
    // "changed" and trigger a regen).
    this.lastSchemaHash = this.computeSchemaHash()

    try {
      this.schemaWatcher = watch(prismaDir, (_event, filename) => {
        if (filename !== 'schema.prisma') return
        if (this.regenerating || this.watchersPaused) {
          // Defer: resumeWatchers() (or the end of regen) will flush it.
          this.pendingSchemaChange = true
          return
        }

        if (this.schemaTimer) clearTimeout(this.schemaTimer)
        this.schemaTimer = setTimeout(() => {
          this.schemaTimer = null
          const hash = this.computeSchemaHash()
          if (hash !== null && hash === this.lastSchemaHash) {
            // Spurious wake — file metadata moved but contents didn't.
            // Don't log on the happy path; this fires every turn on
            // Windows and would drown out real signal.
            return
          }
          this.lastSchemaHash = hash
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

  /**
   * Pause watcher-driven regeneration/restart. Used by `shogo push` so an
   * external prisma generate + db push doesn't race a concurrent
   * watcher-triggered restart (which leaks the API port → EADDRINUSE).
   */
  pauseWatchers(): void {
    this.watchersPaused = true
    if (this.schemaTimer) {
      clearTimeout(this.schemaTimer)
      this.schemaTimer = null
    }
  }

  /**
   * Resume watcher-driven regeneration. If a schema change landed while
   * paused, flush it now (re-baselining first so an unchanged file is a
   * no-op).
   */
  resumeWatchers(): void {
    if (!this.watchersPaused) return
    this.watchersPaused = false
    if (this.pendingSchemaChange && !this.regenerating) {
      this.pendingSchemaChange = false
      this.lastSchemaHash = this.computeSchemaHash()
      void this.handleSchemaChange()
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

    // Pin the baseline to the bytes we're about to act on. Any further
    // events that report the same content (Prisma subprocess re-opens,
    // gateway prompt-context reads) will be filtered by the watcher's
    // hash compare instead of re-arming the regen loop.
    this.lastSchemaHash = createHash('sha1').update(content, 'utf-8').digest('hex')

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
    // Stop publishing a listening port immediately — `restartApiServerOnly()`
    // and `sync()` await us before respawning, and we don't want any
    // /api/* request that lands in that gap to be told "still healthy
    // on port X" when X is about to be torn down.
    this.apiListening = false
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
   * Start the preview server. ALWAYS returns immediately and runs the
   * expensive work (install deps, prisma generate, vite build watch, api
   * server) in `backgroundSetup`.
   *
   * Why always background? The previous behavior was:
   *   - prebuilt-dist branch: backgroundSetup (fast)
   *   - cold path: awaited `runSetupTasks` (~3-5s)
   *   - Metro path: awaited `runSetupTasksMetro` (slower still)
   *
   * pm.start() is invoked from inside `initializeEssentials` (server.ts)
   * which is in turn awaited by /pool/assign. The "cold path" branch
   * blocked /pool/assign for the entire setup window — measured 4.7s in
   * staging on 2026-05-11, dominated by execSync'd prisma generate/db
   * push. Returning fast and reporting progress via _phase keeps the
   * warm-pool assignment path tight regardless of whether the workspace
   * shipped a prebuilt dist/.
   *
   * Callers that need to wait for readiness should poll `getStatus()`
   * for `_phase === 'ready'`.
   *
   * Optimizations preserved from the old fast path:
   * - Skips `bun install` when node_modules/ already exists.
   * - Skips `prisma generate` when the generated client already exists.
   * - Marks _phase = 'ready' immediately when dist/ is prebuilt so the
   *   preview iframe can render while background work continues.
   */
  async start(): Promise<{ mode: string; port: number | null; timings: Record<string, number> }> {
    if (this.started) {
      return { mode: 'already-running', port: this.runtimePort, timings: {} }
    }

    // One-shot migration: delete the legacy `<workspace>/.build.log` and
    // `.console.log` (and their per-bundler-cwd siblings) if they're
    // hanging around from a pre-2026-05 runtime. The new canonical
    // location is `<workspace>/.shogo/logs/{build,console}.log`. Leaving
    // the old files in place is actively harmful on Windows: they sit
    // next to `index.html` and `vite.config.ts`, so every leftover write
    // (if anything else still appends) would re-arm the chokidar
    // rebuild-loop the move was meant to defeat. Cheap, idempotent, no
    // log noise on the happy path.
    this.cleanupLegacyRuntimeLogs()

    // Fresh preview session — align console buffer with an empty on-disk log (matches build refresh UX).
    this.clearRuntimeConsoleLog()

    const timings: Record<string, number> = {}
    const bundlerCwd = this.resolveBundlerCwd()

    if (!existsSync(join(bundlerCwd, 'package.json'))) {
      console.log(`[${LOG_PREFIX}] No package.json in ${bundlerCwd} — skipping preview start`)
      return { mode: 'no-project', port: null, timings }
    }

    const devServer = this.resolveDevServer()

    if (devServer === 'none') {
      console.log(`[${LOG_PREFIX}] Stack declares devServer=none — skipping bundler`)
      this._phase = 'ready'
      this.started = true
      return { mode: 'no-bundler', port: this.runtimePort, timings }
    }

    if (devServer === 'metro') {
      // Web preview always builds; the device-preview Metro tunnel only
      // runs in local mode. Cloud pods skip the tunnel and surface a
      // "device preview not yet available in cloud" indicator via
      // /preview/metro. Setup runs in background — see start() docstring.
      this._phase = 'building'
      this.started = true
      this.backgroundSetupMetro(timings, bundlerCwd).catch((err: any) => {
        console.error(`[${LOG_PREFIX}] Background Metro setup failed:`, err.message)
      })
      // Mode label here is "in-progress" — final label (with tunnel
      // status etc.) is logged when backgroundSetupMetro finishes.
      return { mode: 'metro-web (background)', port: this.runtimePort, timings }
    }

    const hasPrebuiltDist = existsSync(join(bundlerCwd, 'dist', 'index.html'))

    if (hasPrebuiltDist) {
      console.log(`[${LOG_PREFIX}] Pre-built dist/ found — serving immediately, setup continues in background`)
      this._phase = 'ready'
    } else {
      this._phase = 'building'
    }
    this.started = true

    this.backgroundSetup(timings).catch((err) => {
      console.error(`[${LOG_PREFIX}] Background setup failed:`, err.message)
    })

    return {
      mode: hasPrebuiltDist ? 'prebuilt-dist' : 'background-build',
      port: this.runtimePort,
      timings,
    }
  }

  private async backgroundSetup(timings: Record<string, number>): Promise<void> {
    const startedWithPrebuiltDist = this._phase === 'ready'

    await this.installDepsIfNeeded(timings)
    await this.runPrismaIfNeeded(timings)

    if (!startedWithPrebuiltDist) {
      this._phase = 'building'
    }
    await this.startBuildWatch()
    timings.buildWatch = 0

    if (!startedWithPrebuiltDist) {
      this._phase = 'starting-api'
    }
    await this.startApiServer()
    timings.apiServer = 0

    this._phase = 'ready'

    console.log(`[${LOG_PREFIX}] Background setup complete:`, JSON.stringify(timings))
  }

  private async backgroundSetupMetro(
    timings: Record<string, number>,
    bundlerCwd: string,
  ): Promise<void> {
    await this.runSetupTasksMetro(timings, bundlerCwd)
    // `runSetupTasksMetro` is responsible for flipping _phase / started
    // and logging the final mode label (web preview, tunnel status, etc.)
    // — keep this wrapper minimal so we don't double-emit phase changes.
    const apiSuffix = this.apiServerProcess ? '+api' : ''
    const mode = this.metroProcess
      ? `metro-web${apiSuffix}+tunnel`
      : this.localMode
        ? `metro-web${apiSuffix} (tunnel-failed)`
        : `metro-web${apiSuffix} (cloud-todo)`
    console.log(`[${LOG_PREFIX}] Background Metro setup complete: ${mode}`)
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
    // Mobile (Metro/Expo) workspaces ship the same Hono + Prisma backend
    // at their root as Vite stacks. Generate the Prisma client up-front
    // so `startApiServer()` can spawn `server.tsx` cleanly below; this
    // is a no-op when there's no `prisma/schema.prisma` on disk.
    await this.runPrismaIfNeeded(timings)

    this._phase = 'building'
    await this.runExpoExportWeb(timings, bundlerCwd)

    if (this.localMode) {
      await this.startMetroTunnel(bundlerCwd)
      timings.metro = 0
    } else {
      console.log(`[${LOG_PREFIX}] Cloud mode — skipping Metro tunnel (DEVICE_PREVIEW_CLOUD_TODO)`)
    }

    // Bring up the colocated Hono API server. `startApiServer()`
    // self-heals: when `prisma/schema.prisma` and `package.json` are
    // both present it generates `server.tsx` (if missing) and spawns
    // `bun run server.tsx`; otherwise it stays in `idle` and the
    // mobile client just runs without a backend, like before.
    this._phase = 'starting-api'
    await this.startApiServer()

    this._phase = 'ready'
    this.started = true
  }

  private async installDepsIfNeeded(timings: Record<string, number>, cwd?: string): Promise<void> {
    const installCwd = cwd ?? this.bundlerCwd

    // Run the legacy-SDK migration before any hash/install gating. Two
    // reasons this must live here in addition to `ensureWorkspaceDeps`:
    //   1. Not every project boot goes through `ensureWorkspaceDeps` —
    //      restored workspaces, pre-seeded templates, and certain
    //      RuntimeManager paths land in PreviewManager directly, and
    //      we observed (main.log, project 1a010000) the migration
    //      never firing for those.
    //   2. The migration's `clearInstallMarker` + stale-SDK wipe must
    //      run BEFORE we sample the install marker, otherwise we'd
    //      stamp a hash on a tree we just declared stale.
    try { migrateLegacyShogoSdkPin(installCwd) } catch (err: any) {
      console.warn(`[${LOG_PREFIX}] migrateLegacyShogoSdkPin threw: ${err?.message ?? err}`)
    }

    const hasNodeModules = existsSync(join(installCwd, 'node_modules'))

    // Cross-platform install-reuse guard.
    //
    // The host (`apps/api/.../ensureWorkspaceDeps`) populates the
    // workspace `node_modules` on macOS/Windows BEFORE the linux
    // guest VM 9p-mounts it. Rollup/esbuild/lightningcss/swc all
    // ship native bindings as `optionalDependencies` filtered by
    // `os`/`cpu`, so a Darwin-arm64 host install leaves
    // `@rollup/rollup-linux-arm64-gnu` (and friends) absent.
    //
    // Once the guest mounts the workspace, the install-marker hash
    // still matches (package.json didn't change) — without this
    // platform gate, `installDepsIfNeeded` would short-circuit and
    // the next `vite build` would die with
    //   Cannot find module @rollup/rollup-linux-arm64-gnu
    //   at requireWithFriendlyError (.../node_modules/rollup/dist/native.js)
    // exactly the regression visible across every macOS+VM session
    // in `~/Library/Logs/Shogo/main.log`.
    //
    // The host writes `node_modules/.shogo-platform` after every
    // install (via workspace-defaults.writePlatformMarker). When the
    // tag on disk doesn't match the running platform's tag, we
    // force a full install — bun on the running platform will pull
    // the matching natives (bun honors `os`/`cpu` relative to the
    // running platform, not the lockfile platform).
    //
    // Three states the guard handles:
    //   - tag matches    → fast paths run normally
    //   - tag mismatches → force install (BOTH fast paths skipped)
    //   - no tag on disk → legacy / first-run; treat as compatible
    //     (the host install will write a tag on its way out, so the
    //     next guest-side check is conclusive). Avoids paying a
    //     redundant install on every legacy workspace that didn't
    //     pre-date this marker.
    const platformOnDisk = hasNodeModules ? readInstallPlatformMarker(installCwd) : null
    const platformMismatched = !!(platformOnDisk && platformOnDisk !== INSTALL_PLATFORM_TAG)
    if (platformMismatched) {
      console.log(
        `[${LOG_PREFIX}] node_modules was installed for ${platformOnDisk} but we're running on ${INSTALL_PLATFORM_TAG} — forcing reinstall (cross-platform native bindings would be absent)`,
      )
      // Drop both markers so neither fast-path can short-circuit.
      // We intentionally don't delete `node_modules` itself — bun
      // overwrites stale package dirs during install, and a partial
      // rewrite is recoverable on the next start.
      try {
        const markerPath = join(installCwd, '.shogo', 'install-marker')
        if (existsSync(markerPath)) {
          const { unlinkSync } = require('fs')
          unlinkSync(markerPath)
        }
      } catch {
        // Best-effort: a leftover marker only causes one wasted
        // install on the next start.
      }
    }

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
      // Trust-but-verify: the marker says "I installed for this exact
      // package.json", but in cloud mode the marker survives in the
      // workspace-archive S3 sync while `node_modules/` does NOT (it's
      // excluded from the project tar and lives in a separate deps-cache
      // pointer that only populates after a full install). If a pod
      // installed deps, wrote the marker, crashed before uploading the
      // deps cache, then got recycled — the next pod inherits the
      // marker but starts with the warm-pool's Vite template
      // `node_modules`. Hash matches, deps don't. Without this probe
      // we'd silently skip install forever and ship a workspace where
      // `expo`, `@react-three/fiber`, etc. are missing — exactly the
      // failure mode seen on 9e7ecdc7-... in staging on 2026-05-13.
      const missing = findMissingTopLevelDeps(installCwd)
      if (missing.length === 0) {
        console.log(`[${LOG_PREFIX}] install-marker matches package.json sha256 — skipping bun install`)
        timings.install = 0
        this._markDepsSettled()
        return
      }
      console.log(
        `[${LOG_PREFIX}] install-marker matches but ${missing.length} declared dep(s) missing from node_modules (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}) — marker is stale, running install`,
      )
      // fall through to install
    }

    // First-ever start with a pre-installed node_modules and no marker:
    // optimistically trust the install IF every top-level dependency
    // declared in package.json actually exists in node_modules/.
    //
    // Background: the original "just stamp the hash" heuristic was meant
    // to skip a redundant `bun install` for the runtime-template's
    // pre-warmed fast path. But it has a nasty failure mode for legacy
    // user workspaces: if a previous install crashed halfway, or the
    // workspace was migrated (e.g. by `migrateLegacyShogoSdkPin` rewriting
    // the SDK pin), node_modules can exist but be missing key deps —
    // vite, @shogo-ai/sdk, the prisma adapter — and we'd permanently
    // record the BROKEN state as "good", preventing every subsequent
    // start from ever installing them. Observed in main.log:
    //   "Vite build --watch exited (code=127, signal=null)"
    // on a workspace whose node_modules had no vite at all.
    //
    // The probe is cheap (one stat per top-level dep, capped at a few
    // dozen names) and catches both the partial-install and stale-tree
    // cases without bringing back the old anchor-deps false positives:
    // we check *every* declared dep, not a fixed list, so dep churn
    // can't desync the probe from the package.json the project is
    // actually pinning.
    if (hasNodeModules && expectedHash != null && recordedHash == null && !platformMismatched) {
      const missing = findMissingTopLevelDeps(installCwd)
      if (missing.length === 0) {
        console.log(
          `[${LOG_PREFIX}] node_modules/ present with all declared deps — recording hash without reinstall`,
        )
        writeInstallMarker(installCwd, expectedHash)
        timings.install = 0
        this._markDepsSettled()
        return
      }
      console.log(
        `[${LOG_PREFIX}] node_modules/ present but ${missing.length} declared dep(s) missing (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}) — running install`,
      )
      // fall through to install
    }

    if (hasNodeModules && expectedHash != null && recordedHash !== expectedHash) {
      console.log(
        `[${LOG_PREFIX}] package.json hash changed since last install (${recordedHash?.slice(0, 8)} → ${expectedHash.slice(0, 8)}) — reinstalling`,
      )
    }

    this._phase = 'installing'
    this.lastInstallError = null
    const t0 = Date.now()
    try {
      console.log(`[${LOG_PREFIX}] Installing dependencies in ${installCwd}...`)
      // `runWorkspaceInstall` (vs. raw `pkg.installAsync`) is the per-cwd
      // mutex that prevents this call from racing `ensureWorkspaceDeps` —
      // both ran concurrently on staging 2026-05-13 and bun crashed with
      // "FileNotFound: copying file dist/WasmPanicRegistry.js" because the
      // two installs stomped on each other's hardlink temp files. See
      // workspace-defaults.ts mutex doc for the full failure trace.
      //
      // No `frozen: true` here: we may be recovering from a stale
      // template node_modules with no user-owned lockfile. If a frozen
      // install is in flight from `ensureWorkspaceDeps` we'll just join
      // its promise — the resulting `node_modules/` is identical because
      // both callers see the same `package.json`.
      await runWorkspaceInstall(installCwd, { frozen: false })
      timings.install = Date.now() - t0
      console.log(`[${LOG_PREFIX}] Dependencies installed (${timings.install}ms)`)

      // Best-effort marker write — a failure here just means we'll run
      // install one more time on the next start, never anything worse.
      writeInstallMarker(installCwd, expectedHash ?? undefined)
      // Tag the install with the platform we ran on. Subsequent
      // boots on a DIFFERENT platform (host install → guest run,
      // or vice versa) will see the mismatch and re-install above.
      writeInstallPlatformMarker(installCwd)
    } catch (err: any) {
      timings.install = Date.now() - t0
      // Capture for getStatus() so observers can tell that install actually
      // failed even though `_phase` is about to march forward into the next
      // stage. Truncated like lastGenerateError to keep wire payload bounded.
      this.lastInstallError = (err?.message || String(err)).slice(0, 500)
      console.error(`[${LOG_PREFIX}] Dependency install failed:`, err.message)
    } finally {
      // Signal install-has-settled exactly once. Subsequent
      // installDepsIfNeeded calls (re-install on package.json change,
      // metro path follow-up at line ~1068) leave depsReady resolved.
      // Awaiters on a stack-switch reinstall can poll _phase instead;
      // we explicitly don't reset the gate or downstream canvas builds
      // would block on every package.json edit.
      this._markDepsSettled()
    }
  }

  /**
   * Resolve `depsReadyPromise` exactly once. Safe to call from multiple
   * exit paths (success / catch / early-skip in `installDepsIfNeeded`).
   */
  private _markDepsSettled(): void {
    if (this._depsSettled) return
    this._depsSettled = true
    this.depsReadyResolve?.()
    this.depsReadyResolve = null
  }

  /**
   * Candidate on-disk locations for the generated Prisma client, used to
   * decide whether `prisma generate` can be skipped on (re)start.
   *
   * Prisma 7's `prisma-client` provider (what the SDK templates pin) writes
   * the client to a project-relative `output` — the runtime template uses
   * `../src/generated/prisma` — NOT the legacy `node_modules/.prisma/client`
   * that `prisma-client-js` used. Checking only the legacy path meant the
   * client was "never found", so `prisma generate` re-ran on every restart
   * even with no schema changes (the user-visible "shogo generate runs before
   * the server starts" on a warm project). We parse the declared `output`
   * from `schema.prisma` and fall back to the SDK default + the legacy path
   * so both new and old projects skip correctly.
   */
  private prismaClientDirCandidates(cwd: string): string[] {
    const candidates: string[] = []
    const schemaDir = join(cwd, 'prisma')
    try {
      const schema = readFileSync(join(schemaDir, 'schema.prisma'), 'utf-8')
      // `output = "..."` inside the `generator <name> { ... }` block.
      const generatorBlock = schema.match(/generator\s+\w+\s*\{[\s\S]*?\}/)?.[0]
      const output = generatorBlock?.match(/\boutput\s*=\s*["']([^"']+)["']/)?.[1]
      if (output) {
        // `output` resolves relative to the schema file's directory.
        candidates.push(output.startsWith('/') ? output : join(schemaDir, output))
      }
    } catch {
      // Unreadable schema — fall through to the defaults below.
    }
    // SDK template default (Prisma 7) + legacy prisma-client-js location.
    candidates.push(join(cwd, 'src', 'generated', 'prisma'))
    candidates.push(join(cwd, 'node_modules', '.prisma', 'client'))
    return [...new Set(candidates)]
  }

  private async runPrismaIfNeeded(timings: Record<string, number>): Promise<void> {
    const cwd = this.bundlerCwd
    const prismaSchema = join(cwd, 'prisma', 'schema.prisma')
    if (!existsSync(prismaSchema)) return

    // Restore the protected header before any Prisma CLI reads the schema, so a
    // stray write_file that re-added a Prisma-6 datasource url can't break
    // `prisma generate` / `db push`. Same for prisma.config.ts (datasource.url).
    this.healSchemaHeader()
    this.healPrismaConfig()

    const prismaClientExists = this.prismaClientDirCandidates(cwd).some((p) => existsSync(p))
    if (prismaClientExists) {
      console.log(`[${LOG_PREFIX}] Prisma client exists — skipping generate`)
      timings.prisma = 0
    } else {
      this._phase = 'generating-prisma'
      const t1 = Date.now()
      try {
        // Async variant: prisma generate spawns a child Node process that
        // can take ~3s on a cold pod. The sync variant blocks the event
        // loop and was the root cause of the ~4.7s /pool/assign freeze
        // observed in staging on 2026-05-11. Always use *Async from here.
        await pkg.prismaGenerateAsync(cwd)
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
      await pkg.prismaDbPushAsync(cwd, {
        env: { ...process.env, DATABASE_URL: `file:${devDb}` } as NodeJS.ProcessEnv,
      })
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
    this.apiListening = false
    if (this.buildWatchProcess) {
      console.log(`[${LOG_PREFIX}] Stopping Vite build watch...`)
      this.killBuildWatchProcessGroup(this.buildWatchProcess)
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
   * Send SIGTERM to vite-watch and (on POSIX) every process in its
   * group. The group is established at spawn via `detached: true` in
   * `startBuildWatch()`; a single signal here covers rollup native-
   * binding workers and any other grandchildren so they don't strand
   * as launchd-orphans.
   *
   * Falls back to a plain `proc.kill('SIGTERM')` when:
   *   - on Windows (no PGID concept),
   *   - the OS already reaped the leader (`proc.pid` is null), or
   *   - `process.kill(-pid, …)` raises (typically ESRCH because the
   *     group is already empty — still attempt the leader in case
   *     the kernel hasn't fully torn it down yet).
   *
   * The fall-back path is also what the lifecycle unit test exercises:
   * it wires a `{ kill, killed: false }` fake with no `pid`, so the
   * `!proc.pid` branch is what records the `'build:SIGTERM'` assertion.
   */
  private killBuildWatchProcessGroup(proc: ChildProcess): void {
    if (process.platform === 'win32' || !proc.pid) {
      try { proc.kill('SIGTERM') } catch { /* already gone */ }
      return
    }
    try {
      process.kill(-proc.pid, 'SIGTERM')
    } catch {
      try { proc.kill('SIGTERM') } catch { /* already gone */ }
    }
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
    // Phase of the project's API sidecar (root `server.tsx`). Surfaced so
    // clients can render an accurate "Starting API server…" label.
    apiServerPhase: ApiServerPhase
    // Single gate for "is it safe to load the app UI?". True when the
    // project has no sidecar (nothing to wait for) or the sidecar passed
    // its `/health` check. Distinct from `running`: a prebuilt `dist/`
    // makes `running` true immediately, well before the sidecar binds its
    // port, so the client must gate on this instead to avoid rendering the
    // SPA while its `/api/*` calls still 503.
    apiReady: boolean
    // Per-stage errors. `null` means that stage either has not run or
    // completed successfully. PreviewManager catches and logs install /
    // prisma failures rather than crashing — without surfacing them here,
    // `phase === 'ready'` looks identical regardless of whether the
    // project actually built. The import bootstrap bridge keys off these
    // to emit `failed` for the right step instead of a misleading `ok`.
    errors: {
      install: string | null
      generate: string | null
    }
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
      apiServerPhase: this.apiPhase,
      apiReady: this.hasApiServer === false || this.apiPhase === 'healthy',
      errors: {
        install: this.lastInstallError,
        generate: this.lastGenerateError,
      },
    }
  }

  /**
   * Best-effort deletion of legacy `.build.log` / `.console.log` left at
   * the workspace root or bundler cwd by pre-2026-05 runtimes. Called
   * once per `start()`. Errors are swallowed — the new canonical
   * location (`<workspace>/.shogo/logs/`) doesn't depend on the old
   * files being gone, this is purely defensive against the chokidar
   * rebuild-loop trigger they used to provide.
   */
  private cleanupLegacyRuntimeLogs(): void {
    const candidates = new Set<string>([
      join(this.workspaceDir, '.build.log'),
      join(this.workspaceDir, '.console.log'),
      // Vite stacks historically wrote both files into
      // `<workspace>/project/`; cover both layouts so the cleanup is
      // single-pass regardless of which path resolveBundlerCwd picks.
      join(this.bundlerCwd, '.build.log'),
      join(this.bundlerCwd, '.console.log'),
    ])
    for (const path of candidates) {
      if (!existsSync(path)) continue
      try {
        unlinkSync(path)
      } catch {
        // File handle still held by a leaked watcher / antivirus scan /
        // permission glitch — not worth surfacing. The new logs go to
        // `.shogo/logs/` regardless.
      }
    }
  }

  /** Truncate runtime `console.log` and clear the server's in-memory buffer (if wired). */
  private clearRuntimeConsoleLog(): void {
    ensureRuntimeLogDir(this.workspaceDir)
    const consolePath = previewConsoleLogPath(this.workspaceDir)
    try {
      writeFileSync(consolePath, '', 'utf-8')
    } catch (err: any) {
      console.warn(`[${LOG_PREFIX}] Could not truncate ${consolePath}:`, err.message)
    }
    this.onConsoleLogReset?.()
  }

  /**
   * One-shot `vite build --outDir dist.staging` used to seed `dist/`
   * before the long-running watcher takes over. Atomically swaps the
   * staging output into place on success and cleans it up on failure.
   * Best-effort: the watcher still spawns even if this fails — the
   * watcher's own first build will eventually populate `dist/` (just
   * with the historical 404 window we're trying to avoid).
   */
  /**
   * Extra `vite build` args that pin the public base path. Empty for
   * single-project runtimes (vite default base `/`); `['--base', '/p/<id>/']`
   * for a workspace project served under its path prefix so the emitted
   * `<script src>` / `<link href>` are prefixed too.
   */
  private viteBaseArgs(): string[] {
    return this.basePath ? ['--base', this.basePath] : []
  }

  private async runViteOneShotBuild(
    viteBin: string,
    cwd: string,
    buildLogPath: string,
    isWindows: boolean,
  ): Promise<void> {
    cleanupStagingOutput(cwd, DEFAULT_STAGING_DIR)
    console.log(`[${LOG_PREFIX}] Seeding dist/ via one-shot vite build (staging)...`)
    // Route through bundled `bun` when system node is missing — otherwise
    // the shim's `#!/usr/bin/env node` shebang fails with code 127. See
    // resolveBinInvocation() doc-block for the full story.
    const invocation = resolveBinInvocation(cwd, 'vite') ?? { cmd: viteBin, argsPrefix: [] }
    const exitCode = await new Promise<number | null>((resolveBuild) => {
      let proc: ChildProcess
      try {
        proc = spawn(
          isWindows ? `"${invocation.cmd}"` : invocation.cmd,
          [...invocation.argsPrefix, 'build', '--outDir', DEFAULT_STAGING_DIR, '--emptyOutDir', ...this.viteBaseArgs()],
          {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: isWindows,
            env: {
              ...process.env,
              NODE_ENV: 'development',
              VITE_RUNTIME_PORT: String(this.runtimePort),
              CI: '1',
            },
          },
        )
      } catch (err: any) {
        console.error(`[${LOG_PREFIX}] Failed to spawn one-shot vite build: ${err?.message ?? err}`)
        resolveBuild(null)
        return
      }
      proc.on('error', (err: Error) => {
        console.error(`[${LOG_PREFIX}] One-shot vite build error: ${err.message}`)
        resolveBuild(null)
      })
      proc.stdout?.on('data', (data: Buffer) => {
        const line = data.toString().trim()
        emitBuildLine(buildLogPath, '[stdout]', line, 'stdout')
      })
      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim()
        emitBuildLine(buildLogPath, '[stderr]', line, 'stderr')
      })
      proc.on('exit', (code) => resolveBuild(code))
    })

    if (exitCode === 0) {
      const committed = await commitBuildOutputAsync(cwd, DEFAULT_STAGING_DIR)
      if (!committed) {
        console.warn(
          `[${LOG_PREFIX}] One-shot vite build succeeded but commit into dist/ failed`,
        )
      }
    } else {
      console.warn(`[${LOG_PREFIX}] One-shot vite build failed (code=${exitCode})`)
      cleanupStagingOutput(cwd, DEFAULT_STAGING_DIR)
    }
  }

  private async startBuildWatch(): Promise<void> {
    const cwd = this.bundlerCwd
    ensureRuntimeLogDir(this.workspaceDir)
    const buildLogPath = previewBuildLogPath(this.workspaceDir)

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

    // Vite's default `--watch` mode empties `dist/` on its initial pass,
    // which would briefly 404 every refresh during that window and leave
    // the live preview broken if the very first build failed. Do a
    // one-shot `vite build --outDir dist.staging` instead and atomically
    // promote the result; the subsequent watch then runs with
    // `--emptyOutDir false` so it only ever rewrites files in place.
    if (!existsSync(join(cwd, 'dist', 'index.html'))) {
      await this.runViteOneShotBuild(viteBin, cwd, buildLogPath, isWindows)
    }

    console.log(`[${LOG_PREFIX}] Starting vite build --watch (no empty)...`)

    // Reap any orphan vite-watch processes from prior agent-runtime
    // incarnations targeting this same workspace BEFORE we spawn a
    // fresh one. This is the canonical leak path: the vite child is
    // spawned `detached: true` (see comment block below) so it lives
    // in its own PGID — outside the agent-runtime's group — and
    // survives a SIGKILL of the parent (macOS jetsam OOM, hot
    // reload, WorkerRuntimeManager's 5s `waitForExit` timeout firing
    // before agent-runtime's 30s graceful drain completes). Without
    // this reap, every agent-runtime restart inside a Shogo session
    // adds one stranded watcher at ~1-2GB RSS; a single session has
    // been observed accumulating 15+ orphans totalling 27GB before
    // anyone noticed. See {@link reapStaleViteWatchers} for the full
    // detection and kill logic.
    reapStaleViteWatchers(cwd)

    // Same node-missing fallback as runViteOneShotBuild — see
    // resolveBinInvocation() for rationale.
    const invocation = resolveBinInvocation(cwd, 'vite') ?? { cmd: viteBin, argsPrefix: [] }
    // POSIX: spawn vite as its own process-group leader so `stop()` can
    // tear down the entire subtree below it — rollup workers, native-
    // binding loaders, any future grandchildren — with a single
    // `process.kill(-pid, SIGTERM)`. Without this, a direct
    // `proc.kill('SIGTERM')` only reaches vite itself and any
    // grandchildren survive as launchd-orphans, which compounded into
    // the 20-watcher accumulation in workspace 291eda2a-… (see
    // AgentGateway.stop()'s previewManager-stop comment for the full
    // chain). Windows has no PGID concept and Node's docs warn that
    // `detached: true` there spawns a separate console window instead
    // of a process group, so we keep the attached default on win32.
    // Mirrors `packages/shogo-worker/src/lib/runtime-manager.ts`'s
    // detach for the outer agent-runtime spawn.
    const useProcessGroup = !isWindows
    let viteProcess: ChildProcess
    try {
      viteProcess = spawn(
        isWindows ? `"${invocation.cmd}"` : invocation.cmd,
        [...invocation.argsPrefix, 'build', '--watch', '--emptyOutDir', 'false', ...this.viteBaseArgs()],
        {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          // `.CMD` shims must go through cmd.exe on Windows.
          shell: isWindows,
          detached: useProcessGroup,
          env: {
            ...process.env,
            NODE_ENV: 'development',
            VITE_RUNTIME_PORT: String(this.runtimePort),
          },
        },
      )
    } catch (err: any) {
      console.error(`[${LOG_PREFIX}] Failed to spawn vite build --watch: ${err?.message ?? err}`)
      return
    }

    this.buildWatchProcess = viteProcess

    // Drop the internal handle from the agent-runtime's event-loop
    // ref-count. The HTTP server keeps the loop alive in steady state
    // anyway, so this is purely defensive: if the runtime ever tries
    // to exit cleanly without going through `stop()`, the detached
    // group shouldn't pin the parent alive. Stdio pipes stay ref'd so
    // the build-log writer keeps draining vite's stdout/stderr.
    // Matches the worker-manager precedent at runtime-manager.ts:969.
    if (useProcessGroup) {
      try { viteProcess.unref() } catch { /* unref is best-effort */ }
    }

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
      emitBuildLine(buildLogPath, '[stdout]', line, 'stdout')
      // Vite's `--watch` mode emits a `built in 1234ms.` line as the
      // last entry of every successful rebuild — after `dist/` has
      // been rewritten in place. Fire the reload signal here instead
      // of from CanvasBuildManager (which used to race vite-watch on
      // dist/ and is now disabled for vite stacks). Cheap regex on
      // every line, but only the rebuild summary line trips it.
      // Multi-chunk emissions can pack several log lines into one
      // 'data' event, so we scan the whole buffer rather than relying
      // on each chunk being a single line.
      if (this.onBuildComplete && BUILT_IN_MS_PATTERN.test(line)) {
        try {
          this.onBuildComplete()
        } catch (err: any) {
          // Swallow callback errors — a broken subscriber must not
          // tear down vite-watch, which is the workspace's only
          // remaining build pipeline.
          console.warn(`[${LOG_PREFIX}] onBuildComplete subscriber threw: ${err?.message ?? err}`)
        }
      }
    })

    viteProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      emitBuildLine(buildLogPath, '[stderr]', line, 'stderr')
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
        // No sidecar for this project — nothing for the UI to wait on.
        this.hasApiServer = false
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
        // Generation produced no `server.tsx` (idle) or failed (crashed);
        // either way there's no sidecar process to come up, so don't make
        // the client wait on one.
        this.hasApiServer = false
        return
      }
    }

    // Drift check: a `server.tsx` that exists on disk but predates the
    // current `shogo.config.json#customRoutesPath` won't import
    // `custom-routes.ts`. The SPA's static catch-all then serves
    // `index.html` (HTTP 200) for `/api/*` requests, silently masking
    // the missing mount. Detect that here and self-heal — regenerate
    // when the file looks SDK-generated (safe to overwrite), patch in
    // place otherwise (preserves hand edits). See `server-tsx-drift.ts`.
    if (existsSync(serverFile)) {
      const drift = checkServerTsxDrift(cwd)
      if (drift.drifted) {
        const heal = healServerTsxDrift(cwd, drift)
        if (heal.mode === 'regenerate') {
          console.warn(
            `[${LOG_PREFIX}] server.tsx (SDK-generated) is missing the custom-routes mount ` +
              `(${drift.reason}). Regenerating before spawn...`,
          )
          await this.runShogoGenerate()
        } else if (heal.mode === 'patched') {
          console.warn(
            `[${LOG_PREFIX}] server.tsx (hand-edited) was missing the custom-routes mount. ` +
              `Inserted import + app.route in place; other edits preserved.`,
          )
        } else if (heal.mode === 'failed') {
          console.error(
            `[${LOG_PREFIX}] Could not heal server.tsx drift: ${heal.reason}. ` +
              `Custom routes will not be mounted at ${drift.apiBasePath}. ` +
              `Edit server.tsx by hand or run \`bun x shogo generate\`.`,
          )
        }
      }
    }

    ensureRuntimeLogDir(this.workspaceDir)
    const buildLogPath = previewBuildLogPath(this.workspaceDir)
    console.log(`[${LOG_PREFIX}] Starting API server on port ${this.apiPort}...`)
    this.apiPhase = 'starting'
    // Committed to spawning a sidecar — the UI must wait for it to pass its
    // health check before loading (`getStatus().apiReady`).
    this.hasApiServer = true
    // We're about to spawn a brand-new process; the previous one (if any)
    // is no longer authoritative for "is the port bound?". Re-flip on
    // successful health check below.
    this.apiListening = false

    // Make sure the port is actually free before we spawn — a previous
    // run may have leaked a process or had its EADDRINUSE handler skip
    // cleanup. The schema-change and sync() restart paths reach us via
    // startApiServer() WITHOUT a preceding forceKillPort() (unlike
    // restartApiServerOnly/handleCrash), so if the old sidecar is slow to
    // release the port we'd otherwise spawn straight into EADDRINUSE and
    // bounce through the crash handler — surfacing as sustained /api/* 503s.
    // Escalate to a force-kill instead of waiting-then-spawning blindly.
    if (!(await this.isPortFree())) {
      await this.waitForPortRelease()
      if (!(await this.isPortFree())) {
        await this.forceKillPort()
        await this.waitForPortRelease()
      }
    }

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
      env: resolveApiServerEnv({
        parentEnv: process.env,
        portStr,
        cwd,
        projectId: this.workspaceProjectId,
      }),
    })

    this.apiServerProcess = proc

    proc.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      emitBuildLine(buildLogPath, '[api-stdout]', line, 'stdout')
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      emitBuildLine(buildLogPath, '[api-stderr]', line, 'stderr')
    })

    proc.on('exit', (code, signal) => {
      console.log(`[${LOG_PREFIX}] API server exited (code=${code}, signal=${signal})`)
      if (this.apiServerProcess === proc) {
        this.apiServerProcess = null
        // Stop advertising a listening port the moment the owning
        // process is gone — without this the `/api/*` proxy would
        // keep fetching against a dead socket between the exit and
        // the next `startApiServer()` flipping the flag back on.
        this.apiListening = false
      }

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
      // First positive evidence the spawned process has bound the
      // port — unlock the public `apiServerPort` getter so the
      // `/api/*` proxy in server.ts will start forwarding traffic
      // (its short startup grace window in `app.all('/api/*')` is
      // waiting on exactly this flag).
      this.apiListening = true
      // A fresh, healthy process clears the crash budget so a long-
      // running server that crashes once tomorrow doesn't run out of
      // retries because of yesterday's bad start.
      this.crashCount = 0
      console.log(`[${LOG_PREFIX}] API server healthy on port ${this.apiPort}`)
    } else if (this.apiServerProcess === proc && !proc.killed) {
      // Process is up but /health never responded — treat as best-effort
      // running. The caller can still proxy to it (if templates omit
      // /health entirely, prior behaviour was the same fixed-delay return).
      // Flip `apiListening` here too so a template that intentionally
      // skips /health doesn't permanently 503 every /api/* request.
      this.apiPhase = 'healthy'
      this.apiListening = true
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
   * the new spawn.
   *
   * Cross-platform:
   *   - POSIX: tries `lsof -ti` first, then falls back to `fuser`;
   *     both are universally available on Linux pods and macOS dev
   *     machines. Failure (missing binary, permission denied) is
   *     swallowed via `|| true` and the empty stdout returns early.
   *   - Windows: uses `netstat -ano | findstr :<port> | findstr LISTENING`
   *     to enumerate PIDs and `taskkill /F /PID` to kill them.
   *     Going through cmd.exe with the POSIX one-liner above used
   *     to spray three lines of "system cannot find the path
   *     specified" / "'true' is not recognized" into the runtime
   *     log on every `restartApiServerOnly()` (custom-routes save,
   *     schema change, crash recovery) — harmless but alarming.
   *
   * Best-effort regardless of platform: the caller already polls the
   * port via {@link waitForPortRelease} and a leaked process will
   * then surface as a crash loop the operator can investigate.
   */
  private async forceKillPort(): Promise<void> {
    if (process.platform === 'win32') {
      this.forceKillPortWindows()
      return
    }
    this.forceKillPortPosix()
  }

  private forceKillPortPosix(): void {
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
   * Windows analog of `forceKillPortPosix`. `findstr` on stdin from
   * `netstat -ano` returns lines shaped like
   *   `  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       12345`
   * — the trailing whitespace-separated token is the PID. We pass
   *   `2>nul` to suppress findstr's "no match" stderr and rely on
   * `taskkill /F /PID`'s own exit code (already swallowed by the
   * outer try/catch) for cleanup. The execSync call is wrapped in
   * try/catch because findstr exits 1 when no lines match — i.e.
   * the port is already free, which is the *expected* fast path.
   */
  private forceKillPortWindows(): void {
    let stdout = ''
    try {
      stdout = execSync(
        `netstat -ano | findstr :${this.apiPort} | findstr LISTENING`,
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
      )
    } catch {
      // findstr exit 1 = no listening process. Nothing to kill.
      return
    }

    // Defensively keep only numeric PIDs. Skip 0 (idle process) and
    // self/parent — we never want to taskkill the runtime itself.
    const selfPid = String(process.pid)
    const parentPid = String(process.ppid)
    const pids = [...new Set(
      stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/).pop() ?? '')
        .filter((pid) => /^\d+$/.test(pid) && pid !== '0' && pid !== selfPid && pid !== parentPid),
    )]

    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        })
        console.log(`[${LOG_PREFIX}] Force-killed leaked process ${pid} on port ${this.apiPort}`)
      } catch {
        // Process already exited / access denied — fine; the next
        // waitForPortRelease tick will tell us if the port is still
        // occupied.
      }
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
   * Run `expo export --platform web --output-dir dist.staging` once,
   * then atomically promote `dist.staging/` into `dist/`. Writing to a
   * staging directory keeps the live `dist/` serveable while the export
   * runs (typically several seconds) and leaves the previous good
   * build intact if the export fails — without this, `expo export`
   * would clear `dist/` first and any refresh during the build window
   * would 404.
   *
   * Re-run on demand via `restart()`.
   */
  private async runExpoExportWeb(timings: Record<string, number>, cwd: string): Promise<void> {
    // Reentrancy guard — see `expoExportInFlight` field doc.
    if (this.expoExportInFlight) {
      console.log(`[${LOG_PREFIX}] expo export already running — awaiting in-flight build`)
      return this.expoExportInFlight
    }
    this.expoExportInFlight = this._runExpoExportWebImpl(timings, cwd).finally(() => {
      this.expoExportInFlight = null
    })
    return this.expoExportInFlight
  }

  private async _runExpoExportWebImpl(timings: Record<string, number>, cwd: string): Promise<void> {
    const expoBin = this.resolveExpoBin(cwd)
    if (!expoBin) {
      console.log(`[${LOG_PREFIX}] expo CLI not found in node_modules — skipping web export`)
      return
    }
    const isWindows = process.platform === 'win32'

    // Build log always lives at `<workspace>/.shogo/logs/build.log` —
    // outside the bundler cwd, so Rollup's chokidar parent-dir watcher
    // never re-triggers on a build-log append. See `runtime-log-paths.ts`
    // file docstring for the rebuild-loop history.
    ensureRuntimeLogDir(this.workspaceDir)
    const buildLogPath = previewBuildLogPath(this.workspaceDir)
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true })
    // A leftover staging dir from a prior crashed build would confuse
    // expo export (it expects a clean output dir or none). Drop it
    // before spawning.
    cleanupStagingOutput(cwd, DEFAULT_STAGING_DIR)

    const t0 = Date.now()
    console.log(`[${LOG_PREFIX}] Running expo export --platform web (staging)...`)
    const exitCode = await new Promise<number | null>((resolveExport) => {
      let proc: ChildProcess
      try {
        proc = spawn(isWindows ? `"${expoBin}"` : expoBin, ['export', '--platform', 'web', '--output-dir', DEFAULT_STAGING_DIR], {
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
        resolveExport(null)
        return
      }
      // Async spawn errors (e.g. ENOENT surfaced after the call returns) must
      // not bubble up — without this listener Node treats them as uncaught and
      // tears down the entire agent runtime process.
      proc.on('error', (err: Error) => {
        console.error(`[${LOG_PREFIX}] expo export error: ${err.message}`)
        resolveExport(null)
      })
      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString()
        for (const raw of text.split('\n')) {
          const line = raw.trim()
          if (!line) continue
          emitBuildLine(buildLogPath, '[expo-export-stdout]', line, 'stdout')
          this.forwardLogLine(`[expo-export] ${line}`, 'stdout')
        }
      })
      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        for (const raw of text.split('\n')) {
          const line = raw.trim()
          if (!line) continue
          emitBuildLine(buildLogPath, '[expo-export-stderr]', line, 'stderr')
          this.forwardLogLine(`[expo-export] ${line}`, 'stderr')
        }
      })
      proc.on('exit', (code) => {
        if (code !== 0) {
          console.error(`[${LOG_PREFIX}] expo export failed (code=${code})`)
        }
        resolveExport(code)
      })
    })

    if (exitCode === 0) {
      // `expo export` can exit 0 even when Metro's bundle silently failed —
      // for example, on 2026-05-13 (project 9e7ecdc7) a stray AppleDouble
      // file (`app/.__layout.tsx`) blew up Babel inside a jest-worker, the
      // worker crash didn't propagate to the parent, and `expo export`
      // happily returned with an empty `dist.staging/`. Without this
      // check we then atomically swap an empty dir into `dist/` and the
      // preview goes from "stale but working" to "404 on /".
      //
      // Refuse to swap unless staging actually contains `index.html`.
      const stagingIndex = join(cwd, DEFAULT_STAGING_DIR, 'index.html')
      if (!existsSync(stagingIndex)) {
        console.error(
          `[${LOG_PREFIX}] expo export exited 0 but ${DEFAULT_STAGING_DIR}/index.html ` +
            `is missing — refusing to swap. Previous build (if any) stays live. ` +
            `Inspect ${buildLogPath} for the real error.`,
        )
        cleanupStagingOutput(cwd, DEFAULT_STAGING_DIR)
      } else {
        const committed = await commitBuildOutputAsync(cwd, DEFAULT_STAGING_DIR)
        if (!committed) {
          console.warn(
            `[${LOG_PREFIX}] expo export succeeded but commit into dist/ failed — ` +
              `previous build (if any) remains live`,
          )
        }
      }
    } else {
      // Failed build: drop the partial staging output so it can't poison
      // the next swap.
      cleanupStagingOutput(cwd, DEFAULT_STAGING_DIR)
    }

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

    // Build log lives at `<workspace>/.shogo/logs/build.log` for every
    // stack (Vite, Expo web export, Metro tunnel). See
    // `runtime-log-paths.ts` file docstring for the rebuild-loop history
    // that motivated moving out of the bundler cwd.
    ensureRuntimeLogDir(this.workspaceDir)
    const buildLogPath = previewBuildLogPath(this.workspaceDir)
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
        isWindows ? `"${expoBin}"` : expoBin,
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
        emitBuildLine(buildLogPath, '[metro-stdout]', line, 'stdout')
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
        emitBuildLine(buildLogPath, '[metro-stderr]', line, 'stderr')
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
