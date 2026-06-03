// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime Manager Implementation
 *
 * Spawns and manages Vite dev server processes per project.
 * Uses child_process.spawn with random port allocation in range 37100-37900.
 */

import { execSync, type ChildProcess } from 'child_process'
import { existsSync, cpSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { pkg, isMobileTechStack, stackSeedsItself } from '@shogo/shared-runtime'
import {
  WorkerRuntimeManager,
  type ProjectSpawnConfig,
} from '@shogo-ai/worker/runtime-manager'
import type {
  IRuntimeManager,
  IProjectRuntime,
  IRuntimeConfig,
  IHealthStatus,
  RuntimeStatus,
} from './types'
import { getShogoCloudUrl, buildAiProxyUrl, buildToolsProxyUrl } from '../cloud-urls'
import { buildWorkspaceEnv } from './build-workspace-env'

/** Get the directory where this module is located */
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Monorepo root. apps/api/src/lib/runtime -> repo root is 5 levels up.
 * Used to compute a sensible default `workspacesDir` when the
 * `WORKSPACES_DIR` env var isn't set. Historically this fell back to
 * `process.cwd()`, which silently broke whenever the API was launched
 * from somewhere other than `<repo>/workspaces`'s parent directory —
 * `bun dev:all` from the repo root created project workspaces at
 * `<repo>/<projectId>` instead of `<repo>/workspaces/<projectId>`,
 * leaving the agent-runtime serving a fresh empty `.shogo` and the
 * user's real `quick-actions.json` (etc.) invisible. server.ts at
 * line 313 uses the equivalent computation; keeping the two
 * defaults aligned is what stops the divergence.
 */
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..', '..')

/**
 * Path to the bundled Vite + React + TypeScript template.
 * Adjusted for api package location: apps/api/src/lib/runtime -> templates/runtime-template
 */
const BUNDLED_TEMPLATE_DIR = join(PROJECT_ROOT, 'templates', 'runtime-template')

/**
 * Path to the unified runtime server.
 * In desktop mode, AGENT_RUNTIME_ENTRY points to the bun-built bundle.
 * Falls back to source path for cloud/local dev.
 */
const RUNTIME_SERVER = process.env.AGENT_RUNTIME_ENTRY
  || join(PROJECT_ROOT, 'packages', 'agent-runtime', 'src', 'server.ts')

/** Port range for random allocation (obscure high range to avoid conflicts) */
const PORT_RANGE_START = 37100
const PORT_RANGE_END = 37900
const AGENT_PORT_OFFSET = 1000

/**
 * Internal runtimes-map key for a workspace runtime. Prefixed so a
 * workspace id can never collide with a project id in the same Map.
 */
export function workspaceRuntimeKey(workspaceId: string): string {
  return `ws:${workspaceId}`
}

/** Default configuration values */
const DEFAULT_CONFIG: IRuntimeConfig = {
  basePort: PORT_RANGE_START,
  maxRuntimes: 10,
  healthCheckInterval: 30000,
  workspacesDir: join(PROJECT_ROOT, 'workspaces'),
  domainSuffix: 'localhost',
  templateDir: '_template',
}

/** Internal runtime state with process handles */
interface InternalRuntime extends IProjectRuntime {
  process: ChildProcess | null
  /**
   * Agent-runtime ChildProcess handle — historical field. Since
   * 2026-05-14 the agent process is owned by the embedded
   * `WorkerRuntimeManager` (from `@shogo-ai/worker`) so this is
   * always `null` for new spawns. Kept on the interface to avoid
   * breaking the (very few) AGPL-internal call sites that introspected
   * it; consult `agentPort` + `agentManager.status(projectId)` for the
   * authoritative agent state.
   */
  agentProcess: ChildProcess | null
  agentPort: number | undefined
}

/**
 * RuntimeManager implementation that spawns Vite dev server processes.
 */
export class RuntimeManager implements IRuntimeManager {
  private config: IRuntimeConfig
  private runtimes: Map<string, InternalRuntime> = new Map()
  private usedPorts: Set<number> = new Set()
  private healthCheckTimers: Map<string, NodeJS.Timeout> = new Map()
  private startingPromises: Map<string, Promise<IProjectRuntime>> = new Map()
  /**
   * Embedded MIT WorkerRuntimeManager that owns the agent-runtime
   * spawn lifecycle (port allocation in its own range, env injection,
   * Bun.spawn, /health wait, restart-with-backoff, idle eviction).
   *
   * The desktop manager handles everything OTHER than the agent
   * process — Vite dev server, workspace seeding, template overlays,
   * dependency installs, security policy and AI proxy token derivation.
   * The split mirrors the process-boundary that the cli-worker uses,
   * so there is exactly one canonical implementation of "spawn an
   * agent-runtime in a child process and proxy /agent/* to it" across
   * desktop and cli-worker.
   */
  private agentManager: WorkerRuntimeManager
  /**
   * Track which projects we have asked the WorkerRuntimeManager to
   * run, so that desktop-side `start()` / `stop()` callers can hand
   * off cleanly even when the embedded manager has restarted the child
   * process under the hood.
   */
  private agentManagedProjects: Set<string> = new Set()

  constructor(config: Partial<IRuntimeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.cleanupStaleProcesses()
    this.agentManager = new WorkerRuntimeManager({
      // Spawn `bun run <RUNTIME_SERVER>` so the desktop dev path can
      // use the source bundle / TS entry directly without depending on
      // a prebuilt agent-runtime binary on disk.
      //
      // The agent-runtime imports several `@shogo-ai/sdk` subpaths
      // (`microcompact`, `pi-adapter`, `prefix-fingerprint`,
      // `model-router`, `hooks`, `voice`, `tool-orchestration`) whose
      // `exports` map in `packages/sdk/package.json` routes Bun's
      // default `import` condition to `dist/*.js`. We therefore
      // require `packages/sdk/dist/` to be built before the API spawns
      // its first agent — `scripts/dev-all.ts` builds it up front and
      // `bun run build:packages` is the manual equivalent. The other
      // workspace packages the agent-runtime pulls in
      // (`@shogo/shared-runtime`, `@shogo/model-catalog`) declare
      // `"main": "src/index.ts"` with no `exports` map and resolve to
      // source unconditionally, so no build is needed for those.
      spawnCommand: (entry: string) => ({
        command: pkg.bunBinary,
        args: ['run', entry],
      }),
      // Bypass the worker's binary-resolution chain (which expects a
      // compiled `agent-runtime` under ~/.shogo/runtime/) and point at
      // the in-tree source. AGENT_RUNTIME_ENTRY env override still
      // wins (matches the legacy desktop behaviour).
      resolveBin: () => {
        const path = process.env.AGENT_RUNTIME_ENTRY || RUNTIME_SERVER
        if (!existsSync(path)) return null
        return { path, source: 'env' as const }
      },
      // Local/desktop mode is single-user with no resource pressure to
      // recycle for; the default 15-min idle eviction was killing
      // in-flight chat streams whenever the agent-proxy didn't see a
      // fresh request inside the window. The activity-touch hooks in
      // server.ts (agent-proxy) and routes/ai-proxy.ts (AI proxy)
      // refresh `lastUsedAt` on every chunk forwarded and every model
      // call from the agent, so cloud's 15-min reaper now only fires
      // on a genuinely-idle slot. Local mode additionally disables
      // the reaper outright as a belt-and-suspenders since there is
      // no resource motivation to ever reap there.
      idleMs: process.env.SHOGO_LOCAL_MODE === 'true' ? 0 : undefined,
    })
  }

  /**
   * Kill any leftover processes from previous API server sessions on our port range.
   * Runs synchronously at construction so ports are free before any start() call.
   *
   * Guarded by `cleanupRanAtModuleScope` so it only ever runs ONCE per
   * Node process — irrespective of how many RuntimeManager instances
   * get constructed. Without this guard a second instance (whether
   * accidentally created via the legacy dual-singleton path, or
   * deliberately created in a unit test) would lsof the port range a
   * second time, find the first manager's freshly-spawned child PIDs,
   * and SIGKILL them. The visible symptom of the legacy bug was a
   * 30-second waitForReady timeout against a Vite child that had
   * already been killed by our own cleanup.
   */
  private cleanupStaleProcesses(): void {
    if (cleanupRanAtModuleScope) return
    cleanupRanAtModuleScope = true

    const rangesToClean = [
      { start: PORT_RANGE_START, end: PORT_RANGE_END },
      { start: PORT_RANGE_START + AGENT_PORT_OFFSET, end: PORT_RANGE_END + AGENT_PORT_OFFSET + 1 },
    ]

    const isWindows = process.platform === 'win32'
    const selfPid = String(process.pid)
    const parentPid = String(process.ppid)

    for (const range of rangesToClean) {
      const pids = isWindows
        ? this.findStalePidsWindows(range.start, range.end, selfPid, parentPid)
        : this.findStalePidsPosix(range.start, range.end, selfPid, parentPid)

      if (pids.length === 0) continue

      console.log(`[RuntimeManager] Cleaning up ${pids.length} stale process(es) on ports ${range.start}-${range.end}: ${pids.join(', ')}`)
      for (const pid of pids) {
        try {
          if (isWindows) {
            // taskkill is the Windows equivalent of `kill -9`. We
            // intentionally swallow stderr and stdio to keep the
            // module-level cleanup quiet on a normal boot where
            // every PID we found has already exited by the time
            // we get here.
            execSync(`taskkill /F /PID ${pid}`, { stdio: ['pipe', 'pipe', 'pipe'] })
          } else {
            execSync(`kill -9 ${pid} 2>/dev/null || true`)
          }
        } catch {
          // Process already exited / permission denied — fine.
        }
      }
    }
  }

  /**
   * POSIX path of `cleanupStaleProcesses`. Some lsof builds (notably
   * inside the minimal runtime container images) silently ignore
   * `-t` when another flag isn't honored and fall back to verbose
   * tabular output. If any non-numeric tokens reach `kill -9`, sh
   * will choke on unescaped characters like `(` and spray
   * `/bin/sh: syntax error: unexpected "("` into the logs.
   * Defensively keep only pure integer PIDs.
   */
  private findStalePidsPosix(
    start: number,
    end: number,
    selfPid: string,
    parentPid: string,
  ): string[] {
    try {
      const result = execSync(
        `lsof -iTCP:${start}-${end} -sTCP:LISTEN -t 2>/dev/null || true`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim()
      return [...new Set(
        result
          .split(/\s+/)
          .map((p) => p.trim())
          .filter((p) => /^\d+$/.test(p) && p !== selfPid && p !== parentPid && p !== '1'),
      )]
    } catch {
      return []
    }
  }

  /**
   * Windows path of `cleanupStaleProcesses`. The previous unconditional
   * use of `lsof -iTCP:... -t 2>/dev/null || true` via execSync (which
   * defaults to cmd.exe on Windows) sprayed `'true' is not recognized
   * as an internal or external command` and `The system cannot find the
   * path specified.` (×2 for the redirections) into the runtime log on
   * every API-server boot — harmless but alarming and easy to mistake
   * for an actual runtime crash.
   *
   * `netstat -ano` is universally available on Windows and emits lines
   * shaped like
   *   `  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       12345`
   * — the trailing whitespace-separated token is the PID. We piped
   * through `findstr LISTENING` to drop CLOSE_WAIT/TIME_WAIT entries
   * and then filter the port number ourselves so we can match a
   * range rather than a single port.
   */
  private findStalePidsWindows(
    start: number,
    end: number,
    selfPid: string,
    parentPid: string,
  ): string[] {
    let stdout = ''
    try {
      stdout = execSync(
        'netstat -ano | findstr LISTENING',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      )
    } catch {
      // findstr exits 1 when nothing matches — i.e. nothing is
      // listening anywhere. Treat as empty rather than fatal.
      return []
    }

    const out: string[] = []
    for (const line of stdout.split(/\r?\n/)) {
      const tokens = line.trim().split(/\s+/)
      if (tokens.length < 4) continue
      // Tokens: [proto, local, remote, state, pid]
      // local is `IP:port` or `[::]:port`; pull the trailing `:port`.
      const local = tokens[1]
      const portMatch = /:(\d+)$/.exec(local)
      if (!portMatch) continue
      const port = Number(portMatch[1])
      if (port < start || port > end) continue
      const pid = tokens[tokens.length - 1]
      if (!/^\d+$/.test(pid)) continue
      if (pid === '0' || pid === selfPid || pid === parentPid) continue
      out.push(pid)
    }
    return [...new Set(out)]
  }

  /**
   * Check if a port is actually in use by attempting to connect to it.
   * This helps detect stale processes from previous API server instances.
   */
  private async isPortInUse(port: number): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 500)
    try {
      const response = await fetch(`http://localhost:${port}/`, {
        method: 'HEAD',
        signal: controller.signal,
      })
      clearTimeout(timer)
      return true // Port responded
    } catch {
      clearTimeout(timer)
      return false // Port not responding
    }
  }

  /**
   * Kill any process running on the specified port, then verify the port is free.
   * Cross-platform: uses lsof on macOS/Linux, netstat on Windows.
   *
   * Excludes the current process (and its parent) to avoid
   * the API server killing itself when it has connections to the port.
   */
  private async killProcessOnPort(port: number): Promise<boolean> {
    const isWindows = process.platform === 'win32'

    const findPids = (): string[] => {
      try {
        if (isWindows) {
          const result = execSync(
            `netstat -ano | findstr :${port} | findstr LISTENING`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
          ).trim()
          const pids = result.split('\n')
            .map(line => line.trim().split(/\s+/).pop() || '')
            .filter(pid => pid.length > 0 && pid !== '0')
          return [...new Set(pids)]
        } else {
          const result = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf-8' })
          // Defensively accept only numeric PIDs — some lsof builds emit
          // verbose output even with `-t`, which would cause sh to choke
          // on unescaped `(` when fed to `kill`.
          return result
            .split(/\s+/)
            .map((p) => p.trim())
            .filter((pid) => /^\d+$/.test(pid))
        }
      } catch {
        return []
      }
    }

    const selfPid = String(process.pid)
    const parentPid = String(process.ppid)

    const killPids = (pids: string[], force: boolean) => {
      const safePids = pids.filter(pid => pid !== selfPid && pid !== parentPid)
      if (pids.length > 0 && safePids.length === 0) {
        console.log(`[RuntimeManager] Port ${port} is held by the current process — skipping kill`)
        return 0
      }
      const signal = force ? 'SIGKILL' : 'SIGTERM'
      for (const pid of safePids) {
        try {
          console.log(`[RuntimeManager] Sending ${signal} to process ${pid} on port ${port}`)
          if (isWindows) {
            execSync(`taskkill /F /PID ${pid} 2>nul`, { stdio: 'pipe' })
          } else {
            execSync(`kill ${force ? '-9' : '-15'} ${pid} 2>/dev/null || true`)
          }
        } catch {
          // Process might have already exited
        }
      }
      return safePids.length
    }

    // Kill-and-verify loop: SIGTERM first (allows graceful DB close), then SIGKILL
    const MAX_ATTEMPTS = 5
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const pids = findPids()
      if (pids.filter(p => p !== selfPid && p !== parentPid).length === 0) {
        return true // Port is free
      }

      // First two attempts use SIGTERM for graceful shutdown (DB close, WAL checkpoint)
      // Subsequent attempts use SIGKILL as a last resort
      const force = attempt > 2
      const killed = killPids(pids, force)
      if (killed === 0) return false // Only self holds the port

      // Wait with increasing backoff: 500ms, 1s, 1.5s, 2s, 2.5s
      const waitMs = 500 * attempt
      await new Promise(resolve => setTimeout(resolve, waitMs))

      // Verify port is actually free (TCP-level check, not HTTP)
      const stillInUse = await this.isPortListening(port)
      if (!stillInUse) {
        console.log(`[RuntimeManager] Port ${port} freed after ${attempt} attempt(s)`)
        return true
      }

      console.warn(`[RuntimeManager] Port ${port} still in use after kill attempt ${attempt}/${MAX_ATTEMPTS}`)
    }

    console.error(`[RuntimeManager] Failed to free port ${port} after ${MAX_ATTEMPTS} attempts`)
    return false
  }

  /**
   * TCP-level check whether a port is listening (faster and more reliable than HTTP fetch).
   */
  private async isPortListening(port: number): Promise<boolean> {
    try {
      const result = execSync(
        process.platform === 'win32'
          ? `netstat -ano | findstr :${port} | findstr LISTENING`
          : `lsof -ti :${port} 2>/dev/null || true`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim()
      const pids = result.split('\n').filter(l => l.trim().length > 0)
      const selfPid = String(process.pid)
      const parentPid = String(process.ppid)
      return pids.some(pid => pid !== selfPid && pid !== parentPid)
    } catch {
      return false
    }
  }

  /**
   * Allocate a random port in the obscure high range.
   * Picks randomly to avoid collisions with stale processes or other services.
   * The Vite port, agent port (offset by AGENT_PORT_OFFSET), and per-project
   * API server port (agentPort + 1) must all be free. The API server port is
   * what PreviewManager reads via `API_SERVER_PORT` / `SKILL_SERVER_PORT`;
   * without a per-project allocation it falls back to a static 3001 and the
   * second project to spawn fails with EADDRINUSE.
   */
  private async allocatePortAsync(): Promise<number> {
    const range = PORT_RANGE_END - PORT_RANGE_START
    const maxAttempts = Math.min(range, 50)

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const port = PORT_RANGE_START + Math.floor(Math.random() * range)
      const agentPort = port + AGENT_PORT_OFFSET
      const apiServerPort = agentPort + 1

      if (this.usedPorts.has(port)) continue

      const viteInUse = await this.isPortListening(port)
      const agentInUse = await this.isPortListening(agentPort)
      const apiInUse = await this.isPortListening(apiServerPort)

      if (!viteInUse && !agentInUse && !apiInUse) {
        this.usedPorts.add(port)
        console.log(`[RuntimeManager] Allocated ports ${port}/${agentPort}/${apiServerPort}`)
        return port
      }
    }

    throw new Error(`Cannot allocate port after ${maxAttempts} attempts in range ${PORT_RANGE_START}-${PORT_RANGE_END}`)
  }

  /**
   * Release a port back to the pool.
   */
  private releasePort(port: number): void {
    this.usedPorts.delete(port)
  }

  /**
   * Build the URL for a project runtime.
   *
   * For local dev (`domainSuffix === 'localhost'`) we hardcode the loopback
   * IPv4 literal `127.0.0.1` rather than the hostname `localhost`. Windows
   * resolves `localhost` to `::1` (IPv6) first in most default DNS
   * configurations, but `Bun.serve` in agent-runtime defaults to
   * `hostname: "0.0.0.0"` (IPv4-only) — so a hostname-based fetch hangs
   * for the full ~75 s OS TCP-connect timeout against the dead IPv6
   * address before Bun's fetch finally reports "The operation timed out."
   * This bit `apps/api`'s chat proxy: WorkerRuntimeManager already uses
   * `127.0.0.1` internally for its /health probe and `proxyUrl()`
   * (see `packages/shogo-worker/src/lib/runtime-manager.ts`), so this
   * keeps the two layers consistent. Hosted/k8s paths are unaffected —
   * they go through the `${projectId}.${domainSuffix}` branch below.
   */
  private buildUrl(projectId: string, port: number): string {
    const { domainSuffix } = this.config
    if (domainSuffix === 'localhost') {
      return `http://127.0.0.1:${port}`
    }
    return `http://${projectId}.${domainSuffix}`
  }

  /**
   * Create a minimal Vite + React project structure.
   */
  private createMinimalProject(projectDir: string): void {
    console.log(`[RuntimeManager] Creating minimal Vite project at ${projectDir}`)

    mkdirSync(projectDir, { recursive: true })
    mkdirSync(join(projectDir, 'src'), { recursive: true })

    // package.json
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
      name: "project",
      private: true,
      type: "module",
      scripts: {
        dev: "vite",
        build: "vite build",
        preview: "vite preview"
      },
      dependencies: {
        react: "^18.3.1",
        "react-dom": "^18.3.1"
      },
      devDependencies: {
        "@types/react": "^18.3.3",
        "@types/react-dom": "^18.3.0",
        "@vitejs/plugin-react": "^4.3.1",
        vite: "^5.4.2",
        typescript: "^5.5.0"
      }
    }, null, 2))

    // vite.config.ts
    writeFileSync(join(projectDir, 'vite.config.ts'), `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
})
`)

    // tsconfig.json
    writeFileSync(join(projectDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        useDefineForClassFields: true,
        lib: ["ES2020", "DOM", "DOM.Iterable"],
        module: "ESNext",
        skipLibCheck: true,
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: "react-jsx",
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true
      },
      include: ["src"]
    }, null, 2))

    // index.html
    writeFileSync(join(projectDir, 'index.html'), `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Project</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`)

    // src/main.tsx
    writeFileSync(join(projectDir, 'src/main.tsx'), `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ShogoErrorBoundary } from './ShogoErrorBoundary'

if (typeof window !== 'undefined' && window.parent !== window) {
  const reportErrorToParent = (error: string, phase = 'runtime') => {
    try {
      window.parent.postMessage({ type: 'canvas-error', phase, error }, '*')
    } catch {}
  }
  window.addEventListener('error', (e) => {
    reportErrorToParent(\`\${e.message}\\n\${e.error?.stack ?? ''}\`.trim())
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | string | undefined
    const text = typeof r === 'string'
      ? r
      : \`\${r?.message ?? String(r)}\\n\${r?.stack ?? ''}\`.trim()
    reportErrorToParent(text)
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ShogoErrorBoundary>
      <App />
    </ShogoErrorBoundary>
  </React.StrictMode>,
)
`)

    // src/ShogoErrorBoundary.tsx
    writeFileSync(join(projectDir, 'src/ShogoErrorBoundary.tsx'), `import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { hasError: boolean; error: Error | null; showDetails: boolean }

function reportToParent(error: string, phase = 'runtime') {
  if (typeof window === 'undefined' || window.parent === window) return
  try {
    window.parent.postMessage({ type: 'canvas-error', phase, error }, '*')
  } catch {}
}

export class ShogoErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, showDetails: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const stack = error.stack ?? ''
    const componentStack = info.componentStack ?? ''
    reportToParent(\`\${error.message}\\n\${stack}\\n\${componentStack}\`.trim())
    console.error('[ShogoErrorBoundary]', error, info)
  }

  handleRetry = () => this.setState({ hasError: false, error: null, showDetails: false })
  handleReload = () => window.location.reload()
  toggleDetails = () => this.setState((s) => ({ showDetails: !s.showDetails }))

  render() {
    if (!this.state.hasError) return this.props.children

    const err = this.state.error
    const message = err?.message ?? 'Unknown error'
    const stack = err?.stack ?? ''

    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", background: 'var(--background, #fafafa)', color: 'var(--foreground, #111)', boxSizing: 'border-box' }}>
        <div style={{ maxWidth: 520, width: '100%', border: '1px solid var(--border, #e5e5e5)', borderRadius: 16, padding: 24, background: 'var(--card, #fff)', boxShadow: '0 4px 24px rgba(0, 0, 0, 0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div aria-hidden style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(245, 158, 11, 0.12)', color: '#d97706', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 700 }}>!</div>
            <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Something went wrong</h1>
          </div>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--muted-foreground, #666)', margin: '0 0 16px 0' }}>
            The app crashed while rendering. You can try again, or reload the page. Shogo has been notified.
          </p>
          <div style={{ fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', padding: '10px 12px', borderRadius: 8, background: 'var(--muted, #f4f4f5)', color: 'var(--foreground, #111)', marginBottom: 12, wordBreak: 'break-word' }}>
            {message}
          </div>
          {stack && (
            <>
              <button type="button" onClick={this.toggleDetails} style={{ background: 'transparent', border: 'none', padding: 0, fontSize: 12, color: 'var(--muted-foreground, #666)', cursor: 'pointer', marginBottom: 12, textDecoration: 'underline' }}>
                {this.state.showDetails ? 'Hide details' : 'Show details'}
              </button>
              {this.state.showDetails && (
                <pre style={{ fontSize: 11.5, lineHeight: 1.4, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', padding: 12, borderRadius: 8, background: 'var(--muted, #f4f4f5)', color: 'var(--foreground, #111)', margin: '0 0 16px 0', overflow: 'auto', maxHeight: 240, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{stack}</pre>
              )}
            </>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={this.handleRetry} style={{ flex: 1, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, fontWeight: 600, padding: '10px 16px', borderRadius: 10, border: 'none', background: 'var(--primary, #111)', color: 'var(--primary-foreground, #fff)' }}>Try again</button>
            <button type="button" onClick={this.handleReload} style={{ flex: 1, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, fontWeight: 600, padding: '10px 16px', borderRadius: 10, border: '1px solid var(--border, #e5e5e5)', background: 'transparent', color: 'var(--foreground, #111)' }}>Reload</button>
          </div>
        </div>
      </div>
    )
  }
}
`)

    // src/App.tsx
    writeFileSync(join(projectDir, 'src/App.tsx'), `export default function App() {
  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>Project Ready</h1>
      <p>Start building your app!</p>
    </div>
  )
}
`)

    console.log(`[RuntimeManager] Minimal Vite project created`)
  }

  /**
   * Ensure project directory exists with Vite setup.
   *
   * `techStackId` (when provided) lets non-Vite stacks (Expo, Python, Unity)
   * opt out of the bundled React+Vite template copy. For those stacks the
   * directory is created empty here; the agent-runtime child process then
   * runs `seedTechStack(techStackId)` and lays down the correct starter.
   */
  private async ensureProjectDirectory(
    projectId: string,
    techStackId?: string,
    externalProject?: {
      primaryPath: string
    },
  ): Promise<string> {
    const ensureStart = Date.now()
    const log = (name: string, extra?: Record<string, unknown>) => {
      console.log(
        `[RuntimeManager:ensureProjectDirectory:${projectId.slice(0, 8)}] ${name} ` +
          `(+${Date.now() - ensureStart}ms${extra ? ' ' + JSON.stringify(extra) : ''})`,
      )
    }
    // External (VS Code-style) projects: the user picked a folder on
    // their machine and that folder IS the project directory. We never
    // create `workspaces/<projectId>`, never seed a bundled template,
    // never install dependencies on their behalf — anything else would
    // be hostile to the user's existing tree. We only ensure the per-
    // project `.shogo/` skeleton + the gitignore entry, both of which
    // the /api/local/projects/from-folders route already wrote on bind.
    // We re-run them here so an old project bound by a previous Shogo
    // version still ends up with the modern layout.
    if (externalProject?.primaryPath) {
      const primary = externalProject.primaryPath
      const shogoDir = join(primary, '.shogo')
      if (!existsSync(shogoDir)) mkdirSync(shogoDir, { recursive: true })
      for (const sub of ['skills', 'plans', 'local']) {
        const subPath = join(shogoDir, sub)
        if (!existsSync(subPath)) mkdirSync(subPath, { recursive: true })
      }
      // `.shogo/local/dist/` is where PreviewManager + build-output-commit
      // stage build output for external projects (see plan §5). Create
      // it eagerly so PreviewManager doesn't race on first start.
      const distDir = join(shogoDir, 'local', 'dist')
      if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true })
      log('done:external', { primary })
      return primary
    }

    const workspacesDir = resolve(this.config.workspacesDir || join(PROJECT_ROOT, 'workspaces'))
    const projectDir = join(workspacesDir, projectId)
    const workspaceTemplateDir = join(workspacesDir, this.config.templateDir || '_template')

    // Ensure workspaces directory exists
    if (!existsSync(workspacesDir)) {
      mkdirSync(workspacesDir, { recursive: true })
    }

    // Template copy filter:
    //   - exclude `bun.lock` so `bun install` does a fresh platform-appropriate
    //     resolution (a Mac-generated lockfile causes incomplete installs on Windows)
    //
    // We DO copy the bundled runtime-template's `dist/`. For non-template
    // projects it's the right canvas content (the generic Vite starter). For
    // template projects, the agent-template overlay below `force:true`-copies
    // the template's own pre-built dist on top, so the user never sees the
    // generic page even momentarily. See packages/agent-runtime/templates/<id>/dist.
    const copyFilter = (src: string) =>
      !src.includes('node_modules') &&
      !src.includes('.git') &&
      !src.endsWith('bun.lock') &&
      !src.endsWith('bun.lockb')

    const needsSeed = !existsSync(projectDir) || !existsSync(join(projectDir, 'package.json'))

    // Stacks owned by agent-runtime's `seedTechStack` rather than the
    // bundled Vite template. Driven by `seedsOwnTemplate` in the shared
    // tech-stack registry so this list stays in sync with stack.json
    // (validated at agent-runtime boot via `validateTechStackRegistry()`).
    const stackHandlesOwnSeed = stackSeedsItself(techStackId)

    if (needsSeed && stackHandlesOwnSeed) {
      // Make the empty directory and bail. The agent-runtime will populate
      // it via `seedTechStack(techStackId)` on first start. Critically we
      // do NOT install dependencies here: there's no package.json yet, and
      // running install would fail. Instead, install happens later inside
      // PreviewManager / the agent-runtime once the stack has been seeded.
      if (!existsSync(projectDir)) {
        console.log(
          `[RuntimeManager] Creating empty project directory for ${projectId} (stack=${techStackId} — agent-runtime will seed)`,
        )
        mkdirSync(projectDir, { recursive: true })
      } else {
        console.log(
          `[RuntimeManager] Skipping bundled-template seed for ${projectId} (stack=${techStackId})`,
        )
      }
      return projectDir
    }

    if (needsSeed) {
      const isBare = existsSync(projectDir) && !existsSync(join(projectDir, 'package.json'))
      if (isBare) {
        console.log(`[RuntimeManager] Bare workspace detected for ${projectId} (no package.json), seeding template...`)
      } else {
        console.log(`[RuntimeManager] Creating project directory for ${projectId}`)
        mkdirSync(projectDir, { recursive: true })
      }

      // Template resolution order: bundled > workspace > inline
      if (existsSync(BUNDLED_TEMPLATE_DIR) && existsSync(join(BUNDLED_TEMPLATE_DIR, 'package.json'))) {
        console.log(`[RuntimeManager] Copying bundled template from ${BUNDLED_TEMPLATE_DIR}`)
        const tCopy = Date.now()
        cpSync(BUNDLED_TEMPLATE_DIR, projectDir, {
          recursive: true,
          filter: copyFilter,
        })
        log('template-copy:bundled', { ms: Date.now() - tCopy })
      } else if (existsSync(workspaceTemplateDir)) {
        console.log(`[RuntimeManager] Copying workspace template from ${workspaceTemplateDir}`)
        cpSync(workspaceTemplateDir, projectDir, {
          recursive: true,
          filter: copyFilter,
        })
        console.log(`[RuntimeManager] Copied workspace template to ${projectDir}`)
      } else {
        console.log(`[RuntimeManager] No template found, creating minimal project inline`)
        this.createMinimalProject(projectDir)
      }
    }

    // Agent-template overlay used to live here (it pasted
    // `templates/<id>/{src,prisma,dist}` over the bundled Vite starter
    // before Vite spawned). The marketplace install flow now hands us a
    // pre-merged workspace via `copyWorkspaceFiles`, so the overlay is
    // unconditionally a no-op for new projects. Existing template
    // workspaces stay correct because the snapshot baked into
    // `MarketplaceListingVersion.workspaceSnapshot` was produced from
    // the same overlay output.

    // Install dependencies if needed.
    //
    // For tech-stack-seeded workspaces (Expo / React Native / Python / Unity)
    // we deliberately bail BEFORE the install-sentinel check. The agent-runtime
    // owns dep installs for these stacks via `ensureWorkspaceDeps` and
    // `PreviewManager.installDepsIfNeeded`, both of which use the
    // `.shogo/install-marker` hash gate (see `workspace-defaults.ts`) and
    // never wipe `node_modules`.
    //
    // Why this matters: the `.install-ok` sentinel below lives at
    // `node_modules/.install-ok` and is *only* written by this function.
    // Tech-stack workspaces hit the early-return branch above on first start,
    // so the sentinel is never created. On every subsequent restart the
    // sentinel-missing branch then deletes `bun.lock` and *wipes
    // node_modules entirely*, then runs `npm install`. On Windows, with a
    // stale `package-lock.json` and any peer-dep conflict (e.g. `@react-three/drei@^10`
    // wanting React 19 vs Expo 51 pinning React 18), the reinstall either
    // fails outright (ERESOLVE) or silently drops packages — and the
    // user sees "missing packages every time I restart".
    //
    // For non-tech-stack workspaces (the bundled Vite template path) the
    // sentinel logic is still required: those workspaces have apps/api as
    // the sole install owner, so the sentinel correctly tracks install
    // completeness there.
    if (stackHandlesOwnSeed) {
      log('done:stack-handles-own-seed', { techStackId, projectDir })
      return projectDir
    }

    // Uses a sentinel file (.install-ok) to detect incomplete installs
    // (e.g. when bun --watch crashes mid-install on Windows, leaving partial node_modules).
    const installSentinel = join(projectDir, 'node_modules', '.install-ok')
    if (!existsSync(installSentinel)) {
      // Remove stale lockfiles that may have been copied from another platform
      for (const lockfile of ['bun.lock', 'bun.lockb']) {
        const lockPath = join(projectDir, lockfile)
        if (existsSync(lockPath)) {
          unlinkSync(lockPath)
        }
      }

      // Clean partial node_modules from a previous interrupted install
      const nodeModulesDir = join(projectDir, 'node_modules')
      if (existsSync(nodeModulesDir)) {
        console.log(`[RuntimeManager] Removing incomplete node_modules for ${projectId}`)
        const tRm = Date.now()
        rmSync(nodeModulesDir, { recursive: true, force: true })
        log('rm-node_modules', { ms: Date.now() - tRm })
      }

      const cmdName = pkg.isWindows ? 'npm.cmd' : pkg.bunBinary
      console.log(`[RuntimeManager] Installing dependencies for ${projectId} (${cmdName})...`)
      const tInstall = Date.now()
      try {
        await pkg.installAsync(projectDir)
        log('pkg.installAsync', { ms: Date.now() - tInstall, cmd: cmdName })

        // Write sentinel so we know install completed successfully
        writeFileSync(installSentinel, new Date().toISOString())
        console.log(`[RuntimeManager] Dependencies installed for ${projectId}`)
      } catch (err: any) {
        const hasPkg = existsSync(join(projectDir, 'package.json'))
        const detail = hasPkg
          ? err.message
          : 'Workspace is missing package.json — the template may not have been seeded correctly'
        console.error(`[RuntimeManager] Failed to install dependencies:`, detail)
        throw new Error(`Failed to install dependencies for project ${projectId}: ${detail}`)
      }
    }

    log('done', { projectDir })
    return projectDir
  }

  private async getProjectInfo(projectId: string): Promise<{
    name?: string
    techStackId?: string
    workingMode?: 'managed' | 'external'
    runtimeEnabled?: boolean
    trustLevel?: 'trusted' | 'restricted'
    folders?: { path: string; isPrimary: boolean }[]
  }> {
    try {
      const { prisma } = await import('../prisma')
      // `workingMode` / `runtimeEnabled` / `trustLevel` may not exist on
      // every deployment yet (schema migration is in
      // 20260513000000_external_folder_projects). Cast through `any` so
      // the prisma generated client doesn't lock us into the new shape
      // before the migration has been applied on cloud.
      const project = (await prisma.project.findUnique({
        where: { id: projectId },
        select: {
          name: true,
          settings: true,
          workingMode: true,
          runtimeEnabled: true,
          trustLevel: true,
          projectFolders: {
            select: { path: true, isPrimary: true },
          },
        } as any,
      })) as any
      const settings = project?.settings as Record<string, unknown> | null
      // Tech stack is sourced exclusively from settings.techStackId now.
      // The legacy templateId fallback was removed during the templates →
      // marketplace consolidation; marketplace installs persist
      // techStackId at install time so every new project carries it.
      const techStackId = settings?.techStackId as string | undefined
      const workingMode = (project?.workingMode as 'managed' | 'external' | undefined) ?? 'managed'
      const runtimeEnabled =
        typeof project?.runtimeEnabled === 'boolean' ? project.runtimeEnabled : workingMode !== 'external'
      const trustLevel = (project?.trustLevel as 'trusted' | 'restricted' | undefined) ?? 'trusted'
      const folders: { path: string; isPrimary: boolean }[] = Array.isArray(project?.projectFolders)
        ? project.projectFolders.map((f: any) => ({ path: String(f.path), isPrimary: !!f.isPrimary }))
        : []
      return {
        name: project?.name ?? undefined,
        techStackId,
        workingMode,
        runtimeEnabled,
        trustLevel,
        folders,
      }
    } catch {
      return {}
    }
  }

  private async getProjectWorkspaceId(projectId: string): Promise<string | null> {
    try {
      const { prisma } = await import('../prisma')
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { workspaceId: true },
      })
      return project?.workspaceId ?? null
    } catch {
      return null
    }
  }

  /**
   * Read the workspace's `composioScope` setting for a project.
   * Returns `'workspace'` (the new default) when the project, workspace,
   * or column is missing — matches the API route's defaulting logic.
   */
  private async getProjectComposioScope(projectId: string): Promise<'workspace' | 'project'> {
    try {
      const { prisma } = await import('../prisma')
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { workspace: { select: { composioScope: true } } } as any,
      }) as { workspace?: { composioScope?: string | null } | null } | null
      const value = project?.workspace?.composioScope
      if (value === 'project' || value === 'workspace') return value
      return 'workspace'
    } catch {
      return 'workspace'
    }
  }

  /**
   * Build a merged security policy for a project runtime (local mode only).
   * Reads user-level preference from LocalConfig and project-level overrides
   * from Project.settings, merges with escalation protection, and returns
   * a base64-encoded JSON string for the SECURITY_POLICY env var.
   */
  private async buildSecurityPolicy(projectId: string): Promise<string | null> {
    try {
      const { prisma } = await import('../prisma')
      const localDb = prisma as any

      const TIER_RANK: Record<string, number> = { strict: 0, balanced: 1, full_autonomy: 2 }
      const DEFAULT_PREF = { mode: 'full_autonomy', approvalTimeoutSeconds: 60 }

      // Read user-level preference
      let userPref = DEFAULT_PREF
      try {
        const row = await localDb.localConfig.findUnique({ where: { key: 'SECURITY_PREFS' } })
        if (row?.value) {
          userPref = { ...DEFAULT_PREF, ...JSON.parse(row.value) }
        }
      } catch { /* use default */ }

      // Read project-level override
      let projectOverride: any = null
      try {
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { settings: true },
        })
        const settings = typeof project?.settings === 'string'
          ? JSON.parse(project.settings)
          : project?.settings
        if (settings?.security) {
          projectOverride = settings.security
        }
      } catch { /* no override */ }

      // Merge with escalation protection
      let effective = userPref
      if (projectOverride?.mode) {
        const projRank = TIER_RANK[projectOverride.mode] ?? 1
        const userRank = TIER_RANK[userPref.mode] ?? 1
        const effectiveMode = projRank <= userRank ? projectOverride.mode : userPref.mode
        effective = { ...userPref, mode: effectiveMode }

        if (projectOverride.overrides) {
          const userDeny = (userPref as any).overrides?.shellCommands?.deny ?? []
          const projDeny = projectOverride.overrides?.shellCommands?.deny ?? []
          effective = {
            ...effective,
            overrides: {
              ...(userPref as any).overrides,
              shellCommands: {
                ...(userPref as any).overrides?.shellCommands,
                deny: [...new Set([...userDeny, ...projDeny])],
              },
            },
          } as any
        }
      }

      return Buffer.from(JSON.stringify(effective)).toString('base64')
    } catch (err) {
      console.warn('[RuntimeManager] buildSecurityPolicy error:', err)
      return null
    }
  }

  async start(projectId: string): Promise<IProjectRuntime> {
    // Check if already running
    const existing = this.runtimes.get(projectId)
    if (existing && existing.status === 'running') {
      return this.toPublicRuntime(existing)
    }

    // Deduplicate concurrent start calls for the same project
    const inflight = this.startingPromises.get(projectId)
    if (inflight) {
      console.log(`[RuntimeManager] Waiting on in-flight start for ${projectId}`)
      return inflight
    }

    // If a prior start crashed into 'error' (or got stuck in 'starting'
    // with no inflight promise, e.g. when waitForHealth timed out and
    // the worker's spawn left a wedged tree behind), tear down whatever
    // is still on disk for this project before we allocate a fresh
    // port and spawn another copy. Otherwise we accumulate parallel
    // agent-runtime trees per failed retry — each one binding ports
    // 37xxx + spawning vite + tsserver + server.tsx — and the chat
    // proxy fans out across them indefinitely. Discovered on Windows
    // where the worker's previous SIGTERM was a no-op on grandchildren
    // (see killProcessGroup in packages/shogo-worker/src/lib/runtime-manager.ts).
    if (existing && (existing.status === 'error' || existing.status === 'starting')) {
      console.log(
        `[RuntimeManager] start(${projectId}): prior runtime in status='${existing.status}' — ` +
          `stopping leaked tree before respawn`,
      )
      try {
        await this.stop(projectId)
      } catch (err: any) {
        console.warn(
          `[RuntimeManager] start(${projectId}): pre-respawn stop failed: ${err?.message ?? err} — continuing`,
        )
      }
    }

    const promise = this.doStart(projectId)
    this.startingPromises.set(projectId, promise)
    try {
      return await promise
    } finally {
      this.startingPromises.delete(projectId)
    }
  }

  /**
   * Start (or join an in-flight start of) a WORKSPACE runtime — one
   * agent-runtime rooted at the `workspaces/` parent that mounts several
   * attached projects as subfolders (the merged-root mode toggled by
   * `WORKSPACE_RUNTIME=true`, see agent-runtime/workspace-runtime-mode.ts).
   *
   * Keyed by `ws:<workspaceId>` so it can never collide with a single
   * project runtime of the same id. Idempotent + dedupes concurrent
   * starts, exactly like `start()`.
   */
  async startWorkspace(
    workspaceId: string,
    opts: { attachedProjectIds: string[] },
  ): Promise<IProjectRuntime> {
    if (!workspaceId) throw new Error('[RuntimeManager] startWorkspace: workspaceId is required')
    const key = workspaceRuntimeKey(workspaceId)

    const existing = this.runtimes.get(key)
    if (existing && existing.status === 'running' && existing.agentPort) {
      return this.toPublicRuntime(existing)
    }

    const inflight = this.startingPromises.get(key)
    if (inflight) {
      console.log(`[RuntimeManager] Waiting on in-flight workspace start for ${key}`)
      return inflight
    }

    if (existing && (existing.status === 'error' || existing.status === 'starting')) {
      try {
        await this.stop(key)
      } catch (err: any) {
        console.warn(`[RuntimeManager] startWorkspace(${key}): pre-respawn stop failed: ${err?.message ?? err}`)
      }
    }

    const promise = this.doStartWorkspace(workspaceId, opts.attachedProjectIds ?? [])
    this.startingPromises.set(key, promise)
    try {
      return await promise
    } finally {
      this.startingPromises.delete(key)
    }
  }

  private async doStartWorkspace(
    workspaceId: string,
    attachedProjectIds: string[],
  ): Promise<IProjectRuntime> {
    const key = workspaceRuntimeKey(workspaceId)
    const startedAtMs = Date.now()
    const phase = (name: string, extra?: Record<string, unknown>) => {
      console.log(
        `[RuntimeManager:doStartWorkspace:${workspaceId.slice(0, 8)}] ${name} ` +
          `(+${Date.now() - startedAtMs}ms${extra ? ' ' + JSON.stringify(extra) : ''})`,
      )
    }
    phase('begin', { attachedProjectIds: attachedProjectIds.length })

    // The workspace runtime is rooted at the workspaces PARENT; each
    // attached project is an existing subfolder. We never seed/template
    // here — the merged-root boot skips that (workspace-runtime-mode.ts).
    const workspacesDir = resolve(this.config.workspacesDir || join(PROJECT_ROOT, 'workspaces'))
    if (!existsSync(workspacesDir)) mkdirSync(workspacesDir, { recursive: true })

    const port = await this.allocatePortAsync()
    const agentPort = port + AGENT_PORT_OFFSET
    const url = this.buildUrl(key, port)
    const startedAt = Date.now()

    const runtime: InternalRuntime = {
      id: key,
      port,
      status: 'starting',
      url,
      startedAt,
      process: null,
      agentProcess: null,
      agentPort,
    }
    this.runtimes.set(key, runtime)

    try {
      const runtimeServerPath = process.env.AGENT_RUNTIME_ENTRY || RUNTIME_SERVER
      if (!existsSync(runtimeServerPath)) {
        throw new Error(`[RuntimeManager] Runtime server not found at ${runtimeServerPath}`)
      }

      // Base workspace env (WORKSPACE_ID, attached ids, per-project AI
      // proxy tokens, workspace runtime token, proxy URLs, S3, Composio
      // scope). Layer the host-dev-only keys on top.
      const runtimeEnv = await buildWorkspaceEnv(workspaceId, attachedProjectIds, {
        logPrefix: 'doStartWorkspace',
      })
      runtimeEnv.WORKSPACE_RUNTIME = 'true'
      runtimeEnv.WORKING_MODE = 'managed'
      runtimeEnv.NODE_ENV = 'development'
      runtimeEnv.SCHEMAS_PATH = join(workspacesDir, '..', '.schemas')

      const apiPort = process.env.API_PORT || '8002'
      const apiBase = `http://localhost:${apiPort}`
      // buildWorkspaceEnv already set AI_PROXY_URL; add the tools proxy
      // (index-engine embeddings etc.) the same way doStart does.
      runtimeEnv.TOOLS_PROXY_URL = buildToolsProxyUrl(apiBase)

      if (process.env.PROJECTS_DATABASE_URL) {
        runtimeEnv.DATABASE_URL = process.env.PROJECTS_DATABASE_URL
      }

      const spawnConfig: ProjectSpawnConfig = {
        cloudUrl: getShogoCloudUrl(),
        apiKey: process.env.SHOGO_API_KEY || '',
        // projectDir becomes WORKSPACE_DIR in the child — the parent dir.
        projectDir: workspacesDir,
        name: runtimeEnv.AGENT_NAME,
        workspaceId,
        extraEnv: runtimeEnv,
      }

      phase('agentManager.ensureRunning:begin')
      const agentStatus = await this.agentManager.ensureRunning(key, spawnConfig)
      phase('agentManager.ensureRunning:end', { status: agentStatus?.status, agentPort: agentStatus?.agentPort })
      this.agentManagedProjects.add(key)

      runtime.agentPort = agentStatus.agentPort
      if (!agentStatus.agentPort) {
        throw new Error(
          `workspace agent-runtime for ${key} returned no port (status=${agentStatus.status}` +
            (agentStatus.lastError ? `, error=${agentStatus.lastError}` : '') + ')',
        )
      }
      runtime.url = this.buildUrl(key, agentStatus.agentPort)
      runtime.status = 'running'
      this.startHealthCheck(key)
      phase('done', { totalMs: Date.now() - startedAtMs })
      return this.toPublicRuntime(runtime)
    } catch (err) {
      runtime.status = 'error'
      this.releasePort(port)
      if (this.agentManagedProjects.has(key)) {
        this.agentManagedProjects.delete(key)
        await this.agentManager.stop(key).catch(() => {})
      }
      throw err
    }
  }

  private async doStart(projectId: string): Promise<IProjectRuntime> {
    const startedAtMs = Date.now()
    const phase = (name: string, extra?: Record<string, unknown>) => {
      console.log(
        `[RuntimeManager:doStart:${projectId.slice(0, 8)}] ${name} ` +
          `(+${Date.now() - startedAtMs}ms${extra ? ' ' + JSON.stringify(extra) : ''})`,
      )
    }
    phase('begin')
    const t0 = Date.now()
    const projectInfo = await this.getProjectInfo(projectId)
    phase('getProjectInfo', { ms: Date.now() - t0, techStackId: projectInfo.techStackId, workingMode: projectInfo.workingMode })

    // External (VS Code-style) projects: the project directory is the
    // primary linked folder, not workspaces/<projectId>. ensureProjectDirectory
    // short-circuits on this. We compute the primary outside so a missing
    // primary (folder deleted / unmounted) surfaces as a typed error
    // before we allocate ports / spawn anything.
    const isExternal = projectInfo.workingMode === 'external'
    let externalPrimary: string | undefined
    if (isExternal) {
      externalPrimary = projectInfo.folders?.find((f) => f.isPrimary)?.path
      if (!externalPrimary) {
        throw new Error(
          `External project ${projectId} has no primary linked folder. Re-bind a folder via POST /api/local/projects/${projectId}/primary { folderId } before starting.`,
        )
      }
      if (!existsSync(externalPrimary)) {
        throw new Error(
          `Primary folder for project ${projectId} no longer exists on disk: ${externalPrimary}. Relocate the folder before starting.`,
        )
      }
    }

    // Ensure project directory exists with dependencies. We pass techStackId
    // through so non-Vite stacks (Expo / Python / Unity) skip the bundled
    // React+Vite template copy and let the agent-runtime's seedTechStack do
    // the right thing. Without this, an expo-three project ends up with a
    // Frankenstein workspace (Vite package.json + Expo `app/`/`metro.config.js`).
    const t1 = Date.now()
    const projectDir = await this.ensureProjectDirectory(
      projectId,
      projectInfo.techStackId,
      isExternal ? { primaryPath: externalPrimary! } : undefined,
    )
    phase('ensureProjectDirectory', { ms: Date.now() - t1, projectDir })

    // Allocate ports (async to check for stale processes)
    const t2 = Date.now()
    const port = await this.allocatePortAsync()
    phase('allocatePort', { ms: Date.now() - t2, port })
    const agentPort = port + AGENT_PORT_OFFSET
    const url = this.buildUrl(projectId, port)
    const startedAt = Date.now()

    // Create runtime record
    const runtime: InternalRuntime = {
      id: projectId,
      port,
      status: 'starting',
      url,
      startedAt,
      process: null,
      agentProcess: null,
      agentPort,
    }
    this.runtimes.set(projectId, runtime)

    try {
      // Detect Expo / RN projects. For these we skip the Vite spawn
      // entirely — the agent-runtime PreviewManager (started below) owns
      // Metro and `expo export -p web`. Running Vite alongside Metro
      // would fight over ports and the project has no `vite.config.ts`
      // anyway. The runtime serves the static `dist/` produced by
      // `expo export` at the agent port.
      //
      // Detection is registry-driven (not package.json sniffing): on a
      // freshly created mobile project the workspace is empty until
      // agent-runtime's seedTechStack runs, so package.json doesn't
      // exist yet at this point. Falling back to a sniff would
      // incorrectly spawn Vite for the very projects we don't want it
      // for.
      const isExpoProject =
        isMobileTechStack(projectInfo.techStackId) ||
        (() => {
          try {
            const pkgJsonPath = join(projectDir, 'package.json')
            if (existsSync(pkgJsonPath)) {
              const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
              return !!(pkgJson.dependencies?.expo || pkgJson.devDependencies?.expo)
            }
          } catch { /* fall through */ }
          return false
        })()

      // Independent check: even if it's not Expo, we should only spawn Vite
      // when the workspace actually has a Vite entry. Otherwise the dev
      // server respawns forever pre-transforming a non-existent
      // `/src/main.tsx`. This guards legacy workspaces that were created
      // before techStackId was persisted (where projectInfo.techStackId is
      // null and the workspace has no Vite scaffold yet) and stacks like
      // python-data / skill-server which use bun directly with no Vite.
      const looksLikeViteProject = (() => {
        try {
          const pkgJsonPath = join(projectDir, 'package.json')
          if (existsSync(pkgJsonPath)) {
            const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
            const deps = { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) }
            if (deps.vite || deps['@vitejs/plugin-react']) return true
          }
        } catch { /* fall through */ }
        for (const cfg of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs']) {
          if (existsSync(join(projectDir, cfg))) return true
        }
        for (const entry of ['src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js']) {
          if (existsSync(join(projectDir, entry))) return true
        }
        return false
      })()

      if (isExternal && projectInfo.runtimeEnabled === false) {
        // VS Code-style external project with the live preview toggle
        // off. We deliberately don't spawn Vite or Metro — running a
        // bundler in the user's repo without an explicit opt-in is the
        // "polluted my node_modules" failure mode every IDE-like tool
        // tries to avoid. PreviewManager will also no-op (see plan §5).
        // The agent-runtime still starts so chat / file tools work.
        console.log(
          `[RuntimeManager] External project ${projectId} has runtimeEnabled=false — skipping Vite/Metro. ` +
            `Toggle "Enable live preview" in project settings to opt in.`,
        )
      } else if (isExpoProject) {
        console.log(
          `[RuntimeManager] Detected Expo project ${projectId} — skipping Vite. ` +
          `agent-runtime PreviewManager will run Metro + expo export -p web.`,
        )
      } else if (!looksLikeViteProject) {
        console.log(
          `[RuntimeManager] Project ${projectId} has no Vite entry ` +
          `(no vite dep, no vite.config, no src/main.*) — skipping Vite spawn. ` +
          `agent-runtime PreviewManager will own preview if the workspace ` +
          `later writes one.`,
        )
      } else {
        // Host-side Vite dev server is intentionally NOT spawned.
        //
        // The agent-runtime's PreviewManager owns the build pipeline
        // (`vite build --watch`) and the agent-runtime's HTTP server
        // (`packages/agent-runtime/src/server.ts`'s catch-all at the
        // bottom of the route table) statically serves the resulting
        // `<workspaceDir>/dist/` on the agent port. `/api/*` is proxied
        // from there to the colocated `server.tsx` sidecar.
        //
        // Why no host Vite anymore: running both a host dev server AND
        // PreviewManager's `vite build --watch` against the same
        // workspace doubled the file-watcher / Defender / Rollup load
        // and, on Windows specifically, raced on `dist/` rewrites (see
        // canvas-build-manager.ts's file docstring for the EPERM
        // history). The cloud path has always been "agent-runtime
        // serves dist/" — collapsing the local path onto that same
        // model removes the divergence entirely.
        //
        // Trade-off: no HMR on local. Saves are full Rollup rebuilds
        // (~1-3s on Windows) followed by an iframe reload toast wired
        // through `PreviewManager.onBuildComplete` →
        // `CanvasFileWatcher.broadcastReload`.
        console.log(
          `[RuntimeManager] Vite project ${projectId} — host-side dev server ` +
          `disabled; agent-runtime PreviewManager owns vite build --watch and ` +
          `serves dist/ on the agent port.`,
        )
      }

      // Spawn unified runtime server for local development.
      //
      // Since 2026-05-14 the spawn is delegated to the embedded
      // WorkerRuntimeManager (from `@shogo-ai/worker`) so the desktop
      // and the cli-worker share one canonical agent-spawn implementation
      // (port allocation, /health wait, restart-with-backoff, idle
      // eviction). The desktop still owns env composition — Prisma
      // reads, AI proxy token derivation, security policy etc. — and
      // forwards the result via `extraEnv`.
      const runtimeServerPath = process.env.AGENT_RUNTIME_ENTRY || RUNTIME_SERVER
      if (existsSync(runtimeServerPath)) {
        console.log(`[RuntimeManager] Composing agent-runtime env for ${projectId}`)

        // Desktop-specific extra env. The WorkerRuntimeManager itself
        // injects PROJECT_ID / PORT / API_SERVER_PORT / SKILL_SERVER_PORT
        // / RUNTIME_AUTH_SECRET / WEBHOOK_TOKEN / SHOGO_API_URL /
        // SHOGO_API_KEY / NODE_ENV (=production) and passes
        // PROJECT_DIR + WORKSPACE_DIR from the spawn config. We
        // overwrite NODE_ENV below (desktop dev) and append the
        // desktop-only keys (Vite preview URL, working-mode metadata,
        // AI proxy token, security policy, v1 runtime-token, etc.).
        const runtimeEnv: Record<string, string> = {
          // External (VS Code-style) projects: tell the agent-runtime
          // which folders the user has explicitly opened so file tools,
          // the indexer, and watchers can scope to that union (see
          // gateway-tools.ts `assertAllowedPath`). For managed projects
          // these are unset so the runtime falls back to the historical
          // `[WORKSPACE_DIR]` single-root behaviour.
          WORKING_MODE: projectInfo.workingMode ?? 'managed',
          ...(projectInfo.workingMode === 'external'
            ? {
                LINKED_FOLDERS: JSON.stringify((projectInfo.folders ?? []).map((f) => f.path)),
                // NB: TRUST_LEVEL is deliberately NOT in the spawn env.
                // Env vars are immutable for a running process — baking
                // trust in at spawn was the root cause of the
                // "Trust folder still restricted" bug. The runtime now
                // resolves trust live from
                // `GET /api/internal/projects/:id/trust` via
                // `trust-resolver.ts` (boot + every chat turn + on-demand
                // IPC from POST /:id/trust → /internal/refresh-trust).
                RUNTIME_ENABLED: projectInfo.runtimeEnabled ? 'true' : 'false',
              }
            : {}),
          ...(projectInfo.name ? { AGENT_NAME: projectInfo.name } : {}),
          ...(projectInfo.techStackId ? { TECH_STACK_ID: projectInfo.techStackId } : {}),
          // PORT / API_SERVER_PORT / SKILL_SERVER_PORT are injected by
          // WorkerRuntimeManager.buildEnv() based on its own per-project
          // port allocation. Setting them here would override and
          // double-bind. PreviewManager still reads API_SERVER_PORT
          // (preferred) and the SKILL_SERVER_PORT alias the worker
          // sets the same value to.
          //
          // PUBLIC_PREVIEW_URL is intentionally unset on local. The
          // agent-runtime now serves dist/ on its own PORT (because the
          // host-side Vite dev server was retired in favour of
          // PreviewManager's `vite build --watch`), so
          // `gateway.ts#buildPreviewUrlContext` falls back to
          // `localhost:${PORT}` — which is the correct preview URL.
          // Setting PUBLIC_PREVIEW_URL here would point at the
          // formerly-bound Vite port (now unbound), feeding
          // browser_qa subagents a dead URL. Cloud sets this var via
          // its own pathway (Knative subdomain), so cloud behaviour is
          // unchanged.
          SCHEMAS_PATH: join(this.config.workspacesDir || join(PROJECT_ROOT, 'workspaces'), '..', '.schemas'),
          NODE_ENV: 'development',
        }
        
        // Only override DATABASE_URL if PROJECTS_DATABASE_URL is explicitly set.
        // This prevents AI agents from accidentally modifying platform data in local dev,
        // while not affecting cloud deployments where database isolation is handled differently.
        if (process.env.PROJECTS_DATABASE_URL) {
          runtimeEnv.DATABASE_URL = process.env.PROJECTS_DATABASE_URL
          console.log(`[RuntimeManager] Using isolated projects database: ${process.env.PROJECTS_DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`)
        }

        // AI Proxy configuration — always route Claude Code through the local API proxy.
        // We generate a fresh, project-scoped token here rather than propagating
        // process.env.AI_PROXY_TOKEN (which may be a platform-level or stale token).
        // The raw ANTHROPIC_API_KEY is explicitly deleted from the child env so the
        // runtime process cannot fall back to the platform API key.
        const apiPort = process.env.API_PORT || '8002'
        const apiBase = `http://localhost:${apiPort}`
        const proxyUrl = buildAiProxyUrl(apiBase)
        runtimeEnv.AI_PROXY_URL = proxyUrl

        // Pin SHOGO_API_URL to the LOCAL desktop API. Without this, the
        // embedded WorkerRuntimeManager would default SHOGO_API_URL to
        // `cfg.cloudUrl` (= https://studio.shogo.ai) — that's the right
        // value for cloud-forwarded LLM / Composio calls (still on
        // SHOGO_CLOUD_URL), but it's the WRONG host for the runtime's
        // internal control-plane callbacks (trust resolution, heartbeat
        // completion, subagent overrides) which live on the desktop's
        // own API and authenticate via the local `x-runtime-token`.
        //
        // This was the root cause of the "Trust folder still restricted"
        // regression after #670: the IPC ping POST /internal/refresh-trust
        // landed correctly on the local runtime, but the refresh handler
        // then fetched GET /api/internal/projects/:id/trust against
        // studio.shogo.ai (which rejects the local runtime-token), the
        // trust-resolver kept its fail-closed `restricted` default, and
        // assertAllowedPath() kept blocking write/exec tools.
        //
        // Mirrors the cloud spawn path in `build-project-env.ts:131`,
        // which has always pinned this correctly. Goes into `runtimeEnv`
        // (a.k.a. `extraEnv`), which the worker's buildEnv applies LAST
        // so it overrides the worker's `cfg.cloudUrl` default.
        runtimeEnv.SHOGO_API_URL = apiBase

        let proxyConfigured = false
        const workspaceId = await this.getProjectWorkspaceId(projectId) || 'local-dev'
        try {
          const { generateProxyToken } = await import('../ai-proxy-token')
          const { getProjectOwnerUserId } = await import('../project-user-context')
          const ownerUserId = await getProjectOwnerUserId(projectId)
          runtimeEnv.AI_PROXY_TOKEN = await generateProxyToken(projectId, workspaceId, ownerUserId, 7 * 24 * 60 * 60 * 1000)
          console.log(`[RuntimeManager] Generated AI proxy token for ${projectId} (workspace: ${workspaceId}, owner: ${ownerUserId})`)
          proxyConfigured = true
        } catch (err: any) {
          console.error(`[RuntimeManager] Failed to generate proxy token for ${projectId}: ${err.message}`)
          console.error(`[RuntimeManager] Falling back to direct ANTHROPIC_API_KEY`)
          delete runtimeEnv.AI_PROXY_URL
        }

        // Tools proxy URL — enables index engine embeddings and other tool
        // requests to route through the API server (same as Kubernetes managers do).
        // The agent-runtime appends `/serper/...`, `/composio`, `/openai` to this
        // value, so the suffix MUST be `/api/tools` to land on the proxy router
        // mounted in `server.ts`. Historically this was `/api`, which silently
        // 401'd on cloud-authed desktop installs (no local SERPER_API_KEY ⇒ proxy
        // fallback ⇒ wrong URL ⇒ caught by the `requireAuth` middleware that
        // gates everything outside the `/api/tools/*` allowlist). See
        // `runtime-manager-proxy-urls.test.ts` for the regression guard.
        runtimeEnv.TOOLS_PROXY_URL = buildToolsProxyUrl(apiBase)

        runtimeEnv.WORKSPACE_ID = workspaceId

        // Tell the runtime which Composio scope to use for OAuth user IDs.
        // Defaults to 'workspace' (the new default) for any project where
        // the workspace row is missing the column.
        runtimeEnv.COMPOSIO_USER_SCOPE = await this.getProjectComposioScope(projectId)

        // Per-project runtime auth tokens (deterministic — derived from signing secret + projectId).
        // Gotchas around rotation / leak response / synthetic userId live in
        // apps/api/src/lib/runtime-token.md.
        const { deriveRuntimeToken, deriveWebhookToken } = await import('../runtime-token')
        runtimeEnv.RUNTIME_AUTH_SECRET = deriveRuntimeToken(projectId)
        runtimeEnv.WEBHOOK_TOKEN = deriveWebhookToken(projectId)

        // Strip the raw platform API key only when proxy is active,
        // so the child process cannot bypass billing/usage tracking.
        if (proxyConfigured) {
          delete runtimeEnv.ANTHROPIC_API_KEY
          delete runtimeEnv.ANTHROPIC_BASE_URL
        }

        // When Shogo Cloud API key is active and AI_MODE is not overridden,
        // route all providers through the local proxy for cloud forwarding.
        const aiMode = process.env.AI_MODE
        if (process.env.SHOGO_API_KEY && aiMode !== 'api-keys' && aiMode !== 'local-llm') {
          const proxyToken = runtimeEnv.AI_PROXY_TOKEN
          if (proxyToken) {
            runtimeEnv.OPENAI_BASE_URL = proxyUrl
            runtimeEnv.OPENAI_API_KEY = proxyToken
            runtimeEnv.GOOGLE_BASE_URL = proxyUrl
            runtimeEnv.GOOGLE_API_KEY = proxyToken
          }
          delete runtimeEnv.XAI_API_KEY
          delete runtimeEnv.GROQ_API_KEY
          delete runtimeEnv.CEREBRAS_API_KEY
          delete runtimeEnv.OPENROUTER_API_KEY
          delete runtimeEnv.MISTRAL_API_KEY
          // Note: this branch only runs in shogo-cloud mode (the condition
          // above already excludes api-keys / local-llm). In api-keys mode
          // OPENROUTER_API_KEY is preserved so BYOK OpenRouter routing
          // works end-to-end.
          console.log(`[RuntimeManager] Shogo Cloud mode: all providers routed through proxy for ${projectId}`)

          // Composio connections live on the cloud's Composio account keyed by
          // the cloud user/workspace the SHOGO_API_KEY is bound to (the
          // integrations UI forwards "Connect" to the cloud). Scope the
          // runtime's Composio identity to those cloud ids so the agent
          // resolves the same connections instead of the *synthetic local*
          // user/workspace (which would always read back needs_auth). See
          // packages/agent-runtime/src/composio.ts (resolveComposioIdentity).
          try {
            const { getUpstreamIdentity } = await import('../federated-upstream')
            const cloudIdentity = await getUpstreamIdentity()
            if (cloudIdentity) {
              runtimeEnv.COMPOSIO_CLOUD_USER_ID = cloudIdentity.userId
              runtimeEnv.COMPOSIO_CLOUD_WORKSPACE_ID = cloudIdentity.workspaceId
              console.log(`[RuntimeManager] Composio scoped to cloud identity for ${projectId}`)
            }
          } catch (err: any) {
            console.warn(`[RuntimeManager] Could not resolve cloud Composio identity: ${err?.message}`)
          }
        }

        // Security policy — read user prefs + project overrides, merge, and pass to runtime
        if (process.env.SHOGO_LOCAL_MODE === 'true') {
          try {
            const securityPolicy = await this.buildSecurityPolicy(projectId)
            if (securityPolicy) {
              runtimeEnv.SECURITY_POLICY = securityPolicy
              console.log(`[RuntimeManager] Security policy attached for ${projectId}`)
            }
          } catch (err: any) {
            console.warn(`[RuntimeManager] Failed to build security policy: ${err.message}`)
          }
        }
        
        // Hand off to the embedded WorkerRuntimeManager. It allocates
        // its own port (in the same 37100-37900 range — collisions
        // surface via its `isPortListening` probe), spawns the runtime
        // via `bun run <runtimeServerPath>` (configured in the desktop
        // RuntimeManager constructor), forwards stdout/stderr to the
        // console with a `[runtime:<short8>]` prefix, waits for
        // /health, and propagates exit/restart-with-backoff state.
        //
        // We forward the desktop-composed env via `extraEnv`, which is
        // applied AFTER the worker's standard injection — so v1
        // `RUNTIME_AUTH_SECRET` (desktop) overrides the worker's
        // bare-hex default, and PUBLIC_PREVIEW_URL / SECURITY_POLICY /
        // AI_PROXY_TOKEN reach the runtime untouched.
        const spawnConfig: ProjectSpawnConfig = {
          cloudUrl: getShogoCloudUrl(),
          apiKey: process.env.SHOGO_API_KEY || '',
          projectDir,
          techStackId: projectInfo.techStackId,
          name: projectInfo.name,
          workspaceId: runtimeEnv.WORKSPACE_ID,
          extraEnv: runtimeEnv,
        }

        const tAgent = Date.now()
        phase('agentManager.ensureRunning:begin')
        const agentStatus = await this.agentManager.ensureRunning(projectId, spawnConfig)
        phase('agentManager.ensureRunning:end', { ms: Date.now() - tAgent, status: agentStatus?.status, agentPort: agentStatus?.agentPort })
        this.agentManagedProjects.add(projectId)

        // Reflect the worker-allocated agent port back onto the
        // desktop's IProjectRuntime — instance-tunnel.ts and the
        // /api/projects/:id/agent-proxy/* route both read this.
        runtime.agentPort = agentStatus.agentPort
        if (!agentStatus.agentPort) {
          throw new Error(
            `agent-runtime for ${projectId} returned no port (status=${agentStatus.status}` +
              (agentStatus.lastError ? `, error=${agentStatus.lastError}` : '') + ')'
          )
        }

        // Repoint the preview URL at the agent-runtime's actual port.
        //
        // `runtime.url` was provisionally built from the (held-but-now-
        // unbound) Vite `port` slot at the top of startRuntime, when we
        // still spawned a host Vite dev server here. Since the
        // agent-runtime now serves dist/ on its own worker-allocated
        // port, the iframe — and the `/api/projects/:id/preview/*`
        // redirect at apps/api/src/server.ts that dispatches off
        // `runtime.url` — both have to point there instead. We update
        // the URL after `ensureRunning` because the worker's port pool
        // is independent of this manager's `port` slot and the real
        // value isn't known until the spawn settles.
        runtime.url = this.buildUrl(projectId, agentStatus.agentPort)
      } else {
        console.warn(`[RuntimeManager] Runtime server not found at ${runtimeServerPath}, skipping startup`)
      }

      // No explicit readiness wait here: WorkerRuntimeManager.ensureRunning()
      // already polled /health to completion before resolving above, and
      // with the host-side Vite spawn retired there's no separate child
      // process to probe. PreviewManager's `vite build --watch` runs
      // inside the agent-runtime and produces dist/ asynchronously —
      // until the first build lands, the catch-all at
      // packages/agent-runtime/src/server.ts serves a self-refreshing
      // "Building..." placeholder so the iframe degrades gracefully.
      // `runtime.process` stays null on the happy path and the kept
      // legacy helpers (`waitForReady`, vite-process cleanup in stop()
      // and getHealth's vite-alive branch) all gate on it, so they're
      // permanently inert in this code path but still exercised by the
      // tests in runtime-manager-wait-for-ready.test.ts and
      // runtime-manager-lifecycle.test.ts via direct private-method
      // construction.

      runtime.status = 'running'
      this.startHealthCheck(projectId)
      phase('done', { totalMs: Date.now() - startedAtMs })

      return this.toPublicRuntime(runtime)
    } catch (err) {
      runtime.status = 'error'
      this.releasePort(port)
      // No host-side child process to kill — agent-runtime cleanup
      // below owns its own ChildProcess.
      if (this.agentManagedProjects.has(projectId)) {
        this.agentManagedProjects.delete(projectId)
        await this.agentManager.stop(projectId).catch((stopErr: any) => {
          console.warn(`[RuntimeManager] agent stop on error path failed: ${stopErr?.message ?? stopErr}`)
        })
      }
      throw err
    }
  }

  /**
   * Wait for Vite server to be ready.
   * Accepts any HTTP response (including 500) as "server is ready" because:
   * - Vite returns 500 when the app has runtime errors (e.g., missing DATABASE_URL)
   * - The server is still functional and can serve the error page
   *
   * If `process` is provided, the wait short-circuits the moment the
   * spawned child exits — the previous behaviour was to spin for the
   * full 30s and throw a generic "Timeout waiting for runtime X on port
   * P" error even when the Vite process had already died mid-startup
   * (port conflict, missing native binding, missing dependency, etc.).
   * The 30s blackout also blocked every concurrent `start()` caller via
   * `startingPromises`, surfacing in the dev log as repeated
   * "Waiting on in-flight start" lines followed by a cascade of
   * `[ProjectChat]` proxy timeouts when chat requests piled up behind
   * the doomed start. Bailing out as soon as the child exits turns this
   * 30s+cascade into an immediate, descriptive failure that the caller
   * can retry against a fresh port allocation.
   */
  private async waitForReady(
    projectId: string,
    port: number,
    timeoutMs: number,
    process?: { exitCode: number | null; signalCode?: NodeJS.Signals | null; killed?: boolean },
  ): Promise<void> {
    const startTime = Date.now()
    const checkInterval = 500
    const heartbeatIntervalMs = 10_000

    // A spawned child can die two distinct ways:
    //   - cleanly: `exitCode` flips to a number, `signalCode` stays null
    //   - by signal (incl. SIGKILL from our own `cleanupStaleProcesses`
    //     scanner if a second RuntimeManager is constructed): `exitCode`
    //     stays `null`, `signalCode` flips to the signal name. Checking
    //     only `exitCode !== null` misses the signal case entirely and
    //     reverts to the 30s generic-timeout error.
    const isDead = (p: typeof process): boolean =>
      !!p && (p.exitCode !== null || p.signalCode != null || p.killed === true)

    // Diagnostic state: we capture the last few distinct failure modes
    // observed during the wait so the eventual timeout error message
    // carries actionable information instead of the generic
    // "Timeout waiting for runtime X on port P". This unblocked a Windows
    // recurrence where Vite stdout printed `Local:` (so the old
    // stdout-sniff log lied that Vite was "ready") but the HEAD probe
    // never got a response — without the last-error capture there was
    // no way to tell apart "port not bound", "TCP bound but HTTP hang",
    // and "Bun fetch ECONN-style failure" from the log alone.
    let attempts = 0
    let httpAttempts = 0
    let lastError: string | null = null
    let lastTcpListening: boolean | null = null
    let firstTcpListeningAt: number | null = null
    let nextHeartbeatAt = startTime + heartbeatIntervalMs

    // Once TCP has been listening for this long without HTTP returning,
    // accept the TCP listener as the readiness signal and let `doStart`
    // proceed. Vite frequently holds the very first HTTP request open
    // while it pre-bundles dependencies (esbuild + first
    // `transformIndexHtml`), which on a cold Windows workspace can take
    // 10-60s. That's a "preview iframe gets a slow first response"
    // problem, not a "runtime is broken" problem — and gating doStart
    // on it queues every concurrent start()/chat caller behind
    // `startingPromises` for the same duration. A short TCP grace
    // period unblocks them while leaving the HTTP HEAD as a faster
    // happy-path return when Vite is responsive.
    const tcpAcceptGraceMs = 5_000

    while (Date.now() - startTime < timeoutMs) {
      attempts++
      if (isDead(process)) {
        throw new Error(
          `Vite process for runtime ${projectId} exited (code=${process!.exitCode}` +
            (process!.signalCode ? `, signal=${process!.signalCode}` : '') +
            `) before becoming ready on port ${port}`,
        )
      }

      // Two-phase probe so the failure mode is observable in the log:
      //   1. TCP-level check (`isPortListening`) — does anything own
      //      the port at all? Distinguishes "Vite hasn't bound yet" from
      //      "Vite is bound but its HTTP server isn't responding".
      //   2. HTTP HEAD against `127.0.0.1`. Targeting `127.0.0.1`
      //      directly (not `localhost`) bypasses the Windows ::1 /
      //      127.0.0.1 preference race — see the historical 30s
      //      blackout that motivated this in `waitForAgentReady`'s
      //      sibling.
      // Both probes run every iteration so HTTP success can short-
      // circuit the wait even when the TCP probe is unavailable (e.g.
      // in unit tests where `netstat`/`lsof` find nothing on the fake
      // port and fetch is mocked).
      let tcpListening = false
      try {
        tcpListening = await this.isPortListening(port)
      } catch (err: any) {
        lastError = `isPortListening threw: ${err?.message ?? err}`
      }
      lastTcpListening = tcpListening
      if (tcpListening && firstTcpListeningAt === null) {
        firstTcpListeningAt = Date.now()
      }

      httpAttempts++
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      try {
        const response = await fetch(`http://127.0.0.1:${port}`, {
          method: 'HEAD',
          signal: controller.signal,
        })
        clearTimeout(timer)
        // Accept any response - server is running even if app has errors.
        // This includes 200, 404, 500, etc.
        const elapsedMs = Date.now() - startTime
        console.log(
          `[RuntimeManager] Vite ready for ${projectId} on port ${port} ` +
            `(HTTP ${response.status} after ${elapsedMs}ms, ${attempts} attempt(s))`,
        )
        return
      } catch (err: any) {
        clearTimeout(timer)
        const name = err?.name ?? 'Error'
        const code = err?.code ?? err?.cause?.code
        lastError = `HTTP probe failed: ${name}${code ? `(${code})` : ''}: ${err?.message ?? err}`
      }

      // TCP-only fallback success: if Vite's listener has been up for
      // long enough but HTTP requests keep aging out, declare ready and
      // let the caller move on. Logs the diagnostic so the slow first
      // response is still attributable when someone reviews the log
      // later.
      if (
        tcpListening &&
        firstTcpListeningAt !== null &&
        Date.now() - firstTcpListeningAt >= tcpAcceptGraceMs
      ) {
        const elapsedMs = Date.now() - startTime
        console.warn(
          `[RuntimeManager] Vite TCP-listening on port ${port} for ` +
            `${Date.now() - firstTcpListeningAt}ms but HTTP HEAD never returned ` +
            `(${httpAttempts} attempts, lastError=${lastError ?? 'n/a'}). ` +
            `Declaring ready for ${projectId} after ${elapsedMs}ms — Vite is likely ` +
            `mid optimizeDeps / first-request transform; the preview iframe will absorb ` +
            `the slow first response itself.`,
        )
        return
      }

      // Periodic heartbeat so a long wait is visible in real time
      // rather than only at the eventual 60s timeout.
      const now = Date.now()
      if (now >= nextHeartbeatAt) {
        console.log(
          `[RuntimeManager] Vite readiness probe in progress for ${projectId} on port ${port} ` +
            `(${Math.round((now - startTime) / 1000)}s elapsed, ` +
            `attempts=${attempts}, httpAttempts=${httpAttempts}, ` +
            `tcpListening=${lastTcpListening}, lastError=${lastError ?? 'n/a'})`,
        )
        nextHeartbeatAt = now + heartbeatIntervalMs
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    // One last exit-code check before declaring a timeout: covers the
    // race where Vite died inside the final 500ms sleep tick.
    if (isDead(process)) {
      throw new Error(
        `Vite process for runtime ${projectId} exited (code=${process!.exitCode}` +
          (process!.signalCode ? `, signal=${process!.signalCode}` : '') +
          `) before becoming ready on port ${port}`,
      )
    }
    throw new Error(
      `Timeout waiting for runtime ${projectId} to start on port ${port} ` +
        `after ${attempts} attempt(s) (httpAttempts=${httpAttempts}, ` +
        `tcpListening=${lastTcpListening}, lastError=${lastError ?? 'n/a'})`,
    )
  }

  /**
   * Wait for the agent server to be ready and verify it's for the correct project.
   * This prevents routing to stale agent processes from other projects (e.g., after hot reload).
   *
   * The optional `process` ref is checked each iteration so a spawned
   * agent that dies mid-wait short-circuits the 25-second poll loop
   * with a descriptive error instead of the generic
   * "Timeout waiting for agent server ... after 50 attempts". Mirrors
   * the fix in `waitForReady()` for the Vite child; see that method's
   * doc for the full rationale (dual-singleton + cleanupStaleProcesses
   * race).
   */
  private async waitForAgentReady(
    projectId: string,
    port: number,
    _timeoutMs: number,
    process?: { exitCode: number | null; signalCode?: NodeJS.Signals | null; killed?: boolean },
  ): Promise<void> {
    const MAX_RETRIES = 50
    const RETRY_DELAY_MS = 500
    const isDead = (p: typeof process): boolean =>
      !!p && (p.exitCode !== null || p.signalCode != null || p.killed === true)

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (isDead(process)) {
        throw new Error(
          `Agent process for runtime ${projectId} exited (code=${process!.exitCode}` +
            (process!.signalCode ? `, signal=${process!.signalCode}` : '') +
            `) before becoming ready on port ${port}`,
        )
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2000)
      try {
        // Probe `127.0.0.1` directly — see the matching comment in
        // `waitForReady()` for the Windows IPv6/IPv4 `localhost`
        // resolution gotcha this avoids.
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timer)
        if (response.ok) {
          // Verify the agent is for the correct project (prevents stale agent routing)
          const data = await response.json() as { projectId?: string }
          if (data.projectId && data.projectId !== projectId) {
            // Stale agent from another project - this can happen after hot reload
            // The old agent process is still running on this port
            console.error(`[RuntimeManager] Port ${port} has stale agent for project ${data.projectId}, expected ${projectId}`)
            throw new Error(`Port ${port} is occupied by agent for different project (${data.projectId}). Kill the old process or use a different port.`)
          }
          return
        }
      } catch (err: any) {
        clearTimeout(timer)
        // If it's a project mismatch error, don't retry - fail immediately
        if (err.message?.includes('occupied by agent for different project')) {
          throw err
        }
        // Server not ready yet - continue retrying
      }

      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
      }
    }

    if (isDead(process)) {
      throw new Error(
        `Agent process for runtime ${projectId} exited (code=${process!.exitCode}` +
          (process!.signalCode ? `, signal=${process!.signalCode}` : '') +
          `) before becoming ready on port ${port}`,
      )
    }
    throw new Error(`Timeout waiting for agent server ${projectId} to start on port ${port} after ${MAX_RETRIES} attempts`)
  }

  async stop(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId)
    if (!runtime) {
      // Idempotent: succeed silently if not running
      return
    }

    this.stopHealthCheck(projectId)
    runtime.status = 'stopping'

    // Stop the agent-runtime via the embedded WorkerRuntimeManager.
    // It owns the ChildProcess + idle/restart timers and waits for
    // the spawned process to exit (with SIGKILL after a grace window
    // — same semantics as the legacy agentProcess.kill loop here).
    if (this.agentManagedProjects.has(projectId)) {
      this.agentManagedProjects.delete(projectId)
      try {
        await this.agentManager.stop(projectId)
      } catch (err: any) {
        console.warn(`[RuntimeManager] agentManager.stop(${projectId}) failed: ${err?.message ?? err}`)
      }
    } else if (runtime.agentProcess) {
      // Backwards-compat: if some legacy code path attached an
      // agentProcess directly to this runtime record without going
      // through the worker manager, fall back to killing it inline.
      runtime.agentProcess.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (runtime.agentProcess && !runtime.agentProcess.killed) {
            runtime.agentProcess.kill('SIGKILL')
          }
          resolve()
        }, 3000)

        runtime.agentProcess?.on('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }

    if (runtime.process) {
      runtime.process.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (runtime.process && !runtime.process.killed) {
            runtime.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)

        runtime.process?.on('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }

    runtime.status = 'stopped'
    this.releasePort(runtime.port)
    this.runtimes.delete(projectId)
  }

  /**
   * Stop a workspace (merged-root) runtime. Idempotent. Delegates to
   * stop() with the `ws:<id>` key so the worker child, ports, health
   * checks and runtimes-map entry are all torn down identically to a
   * project runtime.
   */
  async stopWorkspace(workspaceId: string): Promise<void> {
    return this.stop(workspaceRuntimeKey(workspaceId))
  }

  /** Public status of a workspace runtime, or null when not running. */
  workspaceStatus(workspaceId: string): IProjectRuntime | null {
    return this.status(workspaceRuntimeKey(workspaceId))
  }

  async restart(projectId: string): Promise<IProjectRuntime> {
    console.log(`[RuntimeManager] Restarting runtime for ${projectId}`)

    const existing = this.runtimes.get(projectId)
    if (existing && existing.status !== 'stopped') {
      console.log(`[RuntimeManager] Stopping existing runtime for ${projectId}`)
      await this.stop(projectId)
    }

    console.log(`[RuntimeManager] Starting fresh runtime for ${projectId}`)
    return this.start(projectId)
  }

  status(projectId: string): IProjectRuntime | null {
    const runtime = this.runtimes.get(projectId)
    return runtime ? this.toPublicRuntime(runtime) : null
  }

  async getHealth(projectId: string): Promise<IHealthStatus> {
    const runtime = this.runtimes.get(projectId)
    if (!runtime) {
      return {
        healthy: false,
        lastCheck: Date.now(),
        error: `No runtime found for project ${projectId}`,
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const viteAlive = runtime.process && !runtime.process.killed && runtime.process.exitCode === null
      const healthPort = runtime.agentPort && !viteAlive ? runtime.agentPort : runtime.port
      const response = await fetch(`http://localhost:${healthPort}${viteAlive ? '' : '/health'}`, {
        method: viteAlive ? 'HEAD' : 'GET',
        signal: controller.signal,
      })
      clearTimeout(timer)

      const healthStatus: IHealthStatus = {
        healthy: response.ok || response.status === 404,
        lastCheck: Date.now(),
      }

      runtime.lastHealthCheck = healthStatus
      return healthStatus
    } catch (err: any) {
      clearTimeout(timer)
      const healthStatus: IHealthStatus = {
        healthy: false,
        lastCheck: Date.now(),
        error: err.message || 'Health check failed',
      }

      runtime.lastHealthCheck = healthStatus
      return healthStatus
    }
  }

  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.runtimes.keys()).map((projectId) =>
      this.stop(projectId).catch((err) =>
        console.error(`[RuntimeManager] Failed to stop ${projectId}:`, err)
      )
    )
    await Promise.all(stopPromises)
  }

  getActiveProjects(): string[] {
    return Array.from(this.runtimes.keys()).filter((id) => {
      const runtime = this.runtimes.get(id)
      return runtime && (runtime.status === 'running' || runtime.status === 'starting')
    })
  }

  /**
   * Mark a project as recently active so the embedded
   * {@link WorkerRuntimeManager} resets its idle-eviction window.
   *
   * Production bug this exists to fix: a long Opus / Claude turn (or
   * any chat stream that runs >15min without a fresh agent-proxy
   * request) was getting reaped mid-stream by `WorkerRuntimeManager`
   * because nothing in the proxy hot path refreshed `lastUsedAt`.
   * Callers (agent-proxy in `server.ts`, AI proxy in
   * `routes/ai-proxy.ts`) now invoke this on every forwarded SSE
   * chunk and on every project-scoped model call so the reaper only
   * sees a slot as "idle" when the user really has stepped away.
   *
   * Safe no-op if `projectId` has no runtime.
   */
  touch(projectId: string): void {
    if (!projectId || projectId === 'api-key') return
    try {
      this.agentManager.touch(projectId)
    } catch (err: any) {
      console.warn(`[RuntimeManager] touch(${projectId}) failed: ${err?.message ?? err}`)
    }
  }

  private startHealthCheck(projectId: string): void {
    const timer = setInterval(() => {
      this.getHealth(projectId).catch((err) =>
        console.error(`[RuntimeManager] Health check error for ${projectId}:`, err)
      )
    }, this.config.healthCheckInterval)

    this.healthCheckTimers.set(projectId, timer)
  }

  private stopHealthCheck(projectId: string): void {
    const timer = this.healthCheckTimers.get(projectId)
    if (timer) {
      clearInterval(timer)
      this.healthCheckTimers.delete(projectId)
    }
  }

  private toPublicRuntime(runtime: InternalRuntime): IProjectRuntime {
    return {
      id: runtime.id,
      port: runtime.port,
      agentPort: runtime.agentPort || undefined,
      status: runtime.status,
      url: runtime.url,
      startedAt: runtime.startedAt,
      lastHealthCheck: runtime.lastHealthCheck,
    }
  }
}

/**
 * Create a RuntimeManager with environment-based configuration.
 */
export function createRuntimeManager(overrides?: Partial<IRuntimeConfig>): RuntimeManager {
  // The `WORKSPACES_DIR || PROJECT_ROOT/workspaces` resolution is the
  // SAME one apps/api/src/server.ts:316 uses. Historically this
  // fell back to `process.cwd()`, which only happened to do the
  // right thing when the API was launched from inside the
  // workspaces parent. `bun dev:all` from the repo root resolved
  // `process.cwd()` to the repo itself and silently materialised
  // project workspaces at `<repo>/<projectId>` instead of
  // `<repo>/workspaces/<projectId>` — see the long comment on
  // PROJECT_ROOT above.
  const config: Partial<IRuntimeConfig> = {
    basePort: PORT_RANGE_START,
    maxRuntimes: parseInt(process.env.RUNTIME_MAX_COUNT || '10', 10),
    healthCheckInterval: parseInt(process.env.RUNTIME_HEALTH_INTERVAL || '30000', 10),
    workspacesDir: process.env.WORKSPACES_DIR || join(PROJECT_ROOT, 'workspaces'),
    domainSuffix: process.env.RUNTIME_DOMAIN_SUFFIX || 'localhost',
    ...overrides,
  }

  return new RuntimeManager(config)
}

/**
 * Process-scope guard for `RuntimeManager.cleanupStaleProcesses()`. The
 * cleanup is meant to run exactly once at API server boot — re-running
 * it from a second instance would lsof-scan the port range, hit the
 * first instance's freshly-spawned children, and SIGKILL them. See the
 * doc on `cleanupStaleProcesses` for the failure mode this guard
 * defends against. Exposed via `__resetRuntimeManagerInternalsForTests`
 * so unit tests can opt into reproducing the legacy behaviour.
 */
let cleanupRanAtModuleScope = false

/** Default singleton instance (lazy initialized) */
let defaultManager: RuntimeManager | null = null

/**
 * Get the default RuntimeManager singleton.
 */
export function getRuntimeManager(): RuntimeManager {
  if (!defaultManager) {
    defaultManager = createRuntimeManager()
  }
  return defaultManager
}

/**
 * Install an externally-constructed RuntimeManager as the module-level
 * singleton.
 *
 * This exists because the project historically had TWO singletons that
 * lazy-initialised independently:
 *
 *   1. `apps/api/src/server.ts` — owns env-var parsing
 *      (`RUNTIME_MAX_COUNT`, `RUNTIME_DOMAIN_SUFFIX`, `WORKSPACES_DIR`)
 *      and the `"[Runtime] RuntimeManager initialized"` log line, then
 *      stored its result in a module-local `runtimeManager` variable.
 *
 *   2. `apps/api/src/lib/runtime/index.ts` — re-exports `getRuntimeManager`
 *      from this file, which lazy-creates its OWN `defaultManager` with
 *      a different (and slightly less specific) config.
 *
 * `resolve-pod-url.ts` falls back to (2) when no `opts.runtimeManager`
 * is passed, so the first chat request after the API boot triggered a
 * second `new RuntimeManager(...)` whose constructor runs
 * `cleanupStaleProcesses()`. That lsof-by-port-range scan happily
 * SIGKILLed the still-starting Vite child the first manager had just
 * spawned, leaving the first manager's `runtime.process` dead but
 * still-being-awaited inside `waitForReady()`. The visible symptoms
 * were the cascade of `[ProjectChat] turn snapshot proxy error`
 * lines and the eventual SIGTERM of the agent process.
 *
 * The fix: have the canonical entry point (`server.ts`) call this
 * setter immediately after construction so both module-level
 * singletons resolve to the same instance.
 */
export function setRuntimeManager(manager: RuntimeManager): void {
  defaultManager = manager
}

/**
 * Test-only hook: clears the module-scope singleton and re-arms the
 * one-shot `cleanupStaleProcesses` guard. Never call this from product
 * code — it exists so unit tests can simulate fresh process boots.
 */
export function __resetRuntimeManagerInternalsForTests(): void {
  defaultManager = null
  cleanupRanAtModuleScope = false
}
