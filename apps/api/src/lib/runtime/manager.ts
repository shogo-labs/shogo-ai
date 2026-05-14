// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime Manager Implementation
 *
 * Spawns and manages Vite dev server processes per project.
 * Uses child_process.spawn with random port allocation in range 37100-37900.
 */

import { spawn, execSync, type ChildProcess } from 'child_process'
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
import { getShogoCloudUrl } from '../cloud-urls'

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
      spawnCommand: (entry: string) => ({ command: pkg.bunBinary, args: ['run', entry] }),
      // Bypass the worker's binary-resolution chain (which expects a
      // compiled `agent-runtime` under ~/.shogo/runtime/) and point at
      // the in-tree source. AGENT_RUNTIME_ENTRY env override still
      // wins (matches the legacy desktop behaviour).
      resolveBin: () => {
        const path = process.env.AGENT_RUNTIME_ENTRY || RUNTIME_SERVER
        if (!existsSync(path)) return null
        return { path, source: 'env' as const }
      },
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

    for (const range of rangesToClean) {
      try {
        const result = execSync(
          `lsof -iTCP:${range.start}-${range.end} -sTCP:LISTEN -t 2>/dev/null || true`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim()

        const selfPid = String(process.pid)
        const parentPid = String(process.ppid)
        // Some lsof builds (notably inside the minimal runtime container
        // images) silently ignore `-t` when another flag isn't honored and
        // fall back to verbose tabular output. If any non-numeric tokens
        // reach `kill -9`, sh will choke on unescaped characters like `(`
        // and spray `/bin/sh: syntax error: unexpected "("` into the logs.
        // Defensively keep only pure integer PIDs.
        const pids = result
          .split(/\s+/)
          .map((p) => p.trim())
          .filter((p) => /^\d+$/.test(p) && p !== selfPid && p !== parentPid && p !== '1')

        if (pids.length > 0) {
          const uniquePids = [...new Set(pids)]
          console.log(`[RuntimeManager] Cleaning up ${uniquePids.length} stale process(es) on ports ${range.start}-${range.end}: ${uniquePids.join(', ')}`)
          for (const pid of uniquePids) {
            try { execSync(`kill -9 ${pid} 2>/dev/null || true`) } catch {}
          }
        }
      } catch {}
    }
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
   */
  private buildUrl(projectId: string, port: number): string {
    const { domainSuffix } = this.config
    if (domainSuffix === 'localhost') {
      return `http://localhost:${port}`
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
    templateId?: string,
    externalProject?: {
      primaryPath: string
    },
  ): Promise<string> {
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
        cpSync(BUNDLED_TEMPLATE_DIR, projectDir, {
          recursive: true,
          filter: copyFilter,
        })
        console.log(`[RuntimeManager] Copied bundled template to ${projectDir}`)
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

    // Agent-template overlay: must apply BEFORE Vite spawns, otherwise the
    // canvas iframe paints the bundled `Project Ready` App.tsx until the
    // agent-runtime later re-seeds and Vite HMR catches up. Overlays both
    // `src/` (so HMR rebuilds the right surface) and the template's
    // pre-built `dist/` (so the canvas iframe paints the right surface
    // *immediately*, before Vite finishes its cold rebuild). We re-apply
    // on every start (idempotent — `cpSync(force:true)`) so a template-
    // source edit in the repo propagates to existing local projects on
    // next start.
    if (templateId) {
      try {
        const { overlayAgentTemplateCodeDirs } = await import('@shogo/agent-runtime/src/workspace-defaults')
        const applied = overlayAgentTemplateCodeDirs(projectDir, templateId)
        if (applied) {
          console.log(`[RuntimeManager] Applied agent template overlay (${templateId}) to ${projectId}`)
        }
      } catch (err: any) {
        console.warn(`[RuntimeManager] Agent template overlay failed for ${templateId}: ${err.message}`)
      }
    }

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
        rmSync(nodeModulesDir, { recursive: true, force: true })
      }

      const cmdName = pkg.isWindows ? 'npm.cmd' : pkg.bunBinary
      console.log(`[RuntimeManager] Installing dependencies for ${projectId} (${cmdName})...`)
      try {
        await pkg.installAsync(projectDir)

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

    return projectDir
  }

  private async getProjectInfo(projectId: string): Promise<{
    templateId?: string
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
          templateId: true,
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
      let techStackId = settings?.techStackId as string | undefined
      if (!techStackId && project?.templateId) {
        const { getAgentTemplateById } = await import('@shogo/agent-runtime/src/agent-templates')
        const template = getAgentTemplateById(project.templateId)
        if (template?.techStack) techStackId = template.techStack
      }
      const workingMode = (project?.workingMode as 'managed' | 'external' | undefined) ?? 'managed'
      const runtimeEnabled =
        typeof project?.runtimeEnabled === 'boolean' ? project.runtimeEnabled : workingMode !== 'external'
      const trustLevel = (project?.trustLevel as 'trusted' | 'restricted' | undefined) ?? 'trusted'
      const folders: { path: string; isPrimary: boolean }[] = Array.isArray(project?.projectFolders)
        ? project.projectFolders.map((f: any) => ({ path: String(f.path), isPrimary: !!f.isPrimary }))
        : []
      return {
        templateId: project?.templateId ?? undefined,
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

    const promise = this.doStart(projectId)
    this.startingPromises.set(projectId, promise)
    try {
      return await promise
    } finally {
      this.startingPromises.delete(projectId)
    }
  }

  private async doStart(projectId: string): Promise<IProjectRuntime> {
    const projectInfo = await this.getProjectInfo(projectId)

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
    const projectDir = await this.ensureProjectDirectory(
      projectId,
      projectInfo.techStackId,
      projectInfo.templateId,
      isExternal ? { primaryPath: externalPrimary! } : undefined,
    )

    // Allocate ports (async to check for stale processes)
    const port = await this.allocatePortAsync()
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
      // Build Vite environment - override DATABASE_URL with projects database if available
      // This ensures project runtimes connect to the isolated projects database, not the platform database
      const viteEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        PROJECT_ID: projectId,
        VITE_PROJECT_ID: projectId,
        VITE_PORT: String(port),
        PORT: String(port),
      }
      
      // Override DATABASE_URL with PROJECTS_DATABASE_URL to isolate project data
      if (process.env.PROJECTS_DATABASE_URL) {
        viteEnv.DATABASE_URL = process.env.PROJECTS_DATABASE_URL
        console.log(`[RuntimeManager] Vite using projects database: ${process.env.PROJECTS_DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`)
      }

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

      let proc: ReturnType<typeof spawn> | null = null

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
        // Hold the project port even though we don't spawn Vite, so the
        // existing /preview proxy keeps routing to the agent port. The
        // agent-runtime serves dist/ at runtimePort.
      } else if (!looksLikeViteProject) {
        console.log(
          `[RuntimeManager] Project ${projectId} has no Vite entry ` +
          `(no vite dep, no vite.config, no src/main.*) — skipping Vite spawn. ` +
          `agent-runtime PreviewManager will own preview if the workspace ` +
          `later writes one.`,
        )
      } else {
        // Run Vite dev server
        // Resolve vite binary directly from node_modules to avoid Windows .bin/ issue
        // (Bun on Windows may not create .bin/ shims, causing "command not found: vite")
        const viteBin = join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js')
        const devArgs = existsSync(viteBin)
          ? [viteBin, '--port', String(port), '--host', '0.0.0.0']
          : ['run', 'dev', '--port', String(port), '--host', '0.0.0.0']
        proc = spawn(pkg.bunBinary, devArgs, {
          cwd: projectDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
          env: viteEnv,
        })
      }

      if (proc) {
        runtime.process = proc

        proc.on('error', (err) => {
          console.error(`[RuntimeManager] Vite process error for ${projectId}:`, err)
          runtime.status = 'error'
        })

        proc.on('exit', (code, signal) => {
          console.log(`[RuntimeManager] Vite process exited for ${projectId}: code=${code}, signal=${signal}`)
          if (runtime.status !== 'stopping' && runtime.status !== 'stopped') {
            runtime.status = 'stopped'
          }
          this.releasePort(port)
        })

        proc.stdout?.on('data', (data) => {
          const output = data.toString()
          if (output.includes('Local:') || output.includes('ready in')) {
            console.log(`[RuntimeManager] Vite ready for ${projectId} on port ${port}`)
          }
          // Forward Vite output to the agent server's console log for the Server tab
          for (const line of output.split('\n')) {
            if (line.trim()) {
              fetch(`http://localhost:${agentPort}/console-log/append`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ line: line.trim(), stream: 'stdout' }),
              }).catch(() => {}) // Ignore if agent isn't ready yet
            }
          }
        })

        proc.stderr?.on('data', (data) => {
          const output = data.toString()
          console.error(`[RuntimeManager] Vite stderr for ${projectId}:`, output)
          // Forward Vite stderr to the agent server's console log for the Server tab
          for (const line of output.split('\n')) {
            if (line.trim()) {
              fetch(`http://localhost:${agentPort}/console-log/append`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ line: line.trim(), stream: 'stderr' }),
              }).catch(() => {}) // Ignore if agent isn't ready yet
            }
          }
        })
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
                TRUST_LEVEL: projectInfo.trustLevel ?? 'restricted',
                RUNTIME_ENABLED: projectInfo.runtimeEnabled ? 'true' : 'false',
              }
            : {}),
          ...(projectInfo.templateId ? { TEMPLATE_ID: projectInfo.templateId } : {}),
          ...(projectInfo.name ? { AGENT_NAME: projectInfo.name } : {}),
          ...(projectInfo.techStackId ? { TECH_STACK_ID: projectInfo.techStackId } : {}),
          // PORT / API_SERVER_PORT / SKILL_SERVER_PORT are injected by
          // WorkerRuntimeManager.buildEnv() based on its own per-project
          // port allocation. Setting them here would override and
          // double-bind. PreviewManager still reads API_SERVER_PORT
          // (preferred) and the SKILL_SERVER_PORT alias the worker
          // sets the same value to.
          // Single source of truth for "where is the running app?".
          // The agent-runtime injects this into its system prompt so QA /
          // browser-use subagents navigate to the right URL instead of
          // hallucinating one from `vite.config.ts` (where the template
          // hardcodes 5173, but the actual port is whatever RuntimeManager
          // allocated here).
          PUBLIC_PREVIEW_URL: url,
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
        const proxyUrl = `http://localhost:${apiPort}/api/ai/v1`
        runtimeEnv.AI_PROXY_URL = proxyUrl

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
        runtimeEnv.TOOLS_PROXY_URL = `http://localhost:${apiPort}/api`

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
          console.log(`[RuntimeManager] Shogo Cloud mode: all providers routed through proxy for ${projectId}`)
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
          templateId: projectInfo.templateId,
          name: projectInfo.name,
          workspaceId: runtimeEnv.WORKSPACE_ID,
          extraEnv: runtimeEnv,
        }

        const agentStatus = await this.agentManager.ensureRunning(projectId, spawnConfig)
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
      } else {
        console.warn(`[RuntimeManager] Runtime server not found at ${runtimeServerPath}, skipping startup`)
      }

      // Wait for Vite dev server if it was started and is still alive.
      // If the process already exited (e.g. vite binary missing during dep install),
      // skip the wait — the agent server alone is sufficient for chat.
      if (runtime.process && !runtime.process.killed && runtime.process.exitCode === null) {
        await this.waitForReady(projectId, port, 30000, runtime.process)
      } else if (runtime.process) {
        console.warn(`[RuntimeManager] Vite process already exited for ${projectId} (code=${runtime.process.exitCode}), skipping waitForReady`)
      }

      // No explicit agent-readiness wait: WorkerRuntimeManager.ensureRunning()
      // already polled /health to completion before resolving above.
      // The legacy `waitForAgentReady` (and its stale-projectId guard)
      // is preserved on this class for any AGPL-internal caller that
      // still wants to invoke it directly, but it's no longer part of
      // the start path.

      runtime.status = 'running'
      this.startHealthCheck(projectId)

      return this.toPublicRuntime(runtime)
    } catch (err) {
      runtime.status = 'error'
      this.releasePort(port)
      if (runtime.process) {
        runtime.process.kill('SIGTERM')
      }
      // Tear down the agent-runtime via the embedded worker manager.
      // It owns the ChildProcess and the per-project port reservation.
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

    // A spawned child can die two distinct ways:
    //   - cleanly: `exitCode` flips to a number, `signalCode` stays null
    //   - by signal (incl. SIGKILL from our own `cleanupStaleProcesses`
    //     scanner if a second RuntimeManager is constructed): `exitCode`
    //     stays `null`, `signalCode` flips to the signal name. Checking
    //     only `exitCode !== null` misses the signal case entirely and
    //     reverts to the 30s generic-timeout error.
    const isDead = (p: typeof process): boolean =>
      !!p && (p.exitCode !== null || p.signalCode != null || p.killed === true)

    while (Date.now() - startTime < timeoutMs) {
      if (isDead(process)) {
        throw new Error(
          `Vite process for runtime ${projectId} exited (code=${process!.exitCode}` +
            (process!.signalCode ? `, signal=${process!.signalCode}` : '') +
            `) before becoming ready on port ${port}`,
        )
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1000)
      try {
        const response = await fetch(`http://localhost:${port}`, {
          method: 'HEAD',
          signal: controller.signal,
        })
        clearTimeout(timer)
        // Accept any response - server is running even if app has errors
        // This includes 200, 404, 500, etc.
        void response
        return
      } catch {
        clearTimeout(timer)
        // Server not ready yet (connection refused, timeout, etc.)
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
    throw new Error(`Timeout waiting for runtime ${projectId} to start on port ${port}`)
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
        const response = await fetch(`http://localhost:${port}/health`, {
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
