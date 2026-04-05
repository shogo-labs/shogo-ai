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
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { pkg } from '@shogo/shared-runtime'
import type {
  IRuntimeManager,
  IProjectRuntime,
  IRuntimeConfig,
  IHealthStatus,
  RuntimeStatus,
} from './types'

/** Get the directory where this module is located */
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Path to the bundled Vite + React + TypeScript template.
 * Adjusted for api package location: apps/api/src/lib/runtime -> templates/runtime-template
 */
const BUNDLED_TEMPLATE_DIR = join(__dirname, '..', '..', '..', '..', '..', 'templates', 'runtime-template')

/**
 * Path to the unified runtime server.
 * In desktop mode, AGENT_RUNTIME_ENTRY points to the bun-built bundle.
 * Falls back to source path for cloud/local dev.
 */
const RUNTIME_SERVER = process.env.AGENT_RUNTIME_ENTRY
  || join(__dirname, '..', '..', '..', '..', '..', 'packages', 'agent-runtime', 'src', 'server.ts')

/** Port range for random allocation (obscure high range to avoid conflicts) */
const PORT_RANGE_START = 37100
const PORT_RANGE_END = 37900
const AGENT_PORT_OFFSET = 1000

/** Default configuration values */
const DEFAULT_CONFIG: IRuntimeConfig = {
  basePort: PORT_RANGE_START,
  maxRuntimes: 10,
  healthCheckInterval: 30000,
  workspacesDir: process.cwd(),
  domainSuffix: 'localhost',
  templateDir: '_template',
}

/** Internal runtime state with process handles */
interface InternalRuntime extends IProjectRuntime {
  process: ChildProcess | null
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

  constructor(config: Partial<IRuntimeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.cleanupStaleProcesses()
  }

  /**
   * Kill any leftover processes from previous API server sessions on our port range.
   * Runs synchronously at construction so ports are free before any start() call.
   */
  private cleanupStaleProcesses(): void {
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
        const pids = result.split('\n').filter(p => p.trim() && p !== selfPid && p !== parentPid)

        if (pids.length > 0) {
          console.log(`[RuntimeManager] Cleaning up ${pids.length} stale process(es) on ports ${range.start}-${range.end}: ${pids.join(', ')}`)
          for (const pid of pids) {
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
          return result.trim().split('\n').filter(pid => pid.length > 0)
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
   * Both the Vite port and agent port (offset by AGENT_PORT_OFFSET) must be free.
   */
  private async allocatePortAsync(): Promise<number> {
    const range = PORT_RANGE_END - PORT_RANGE_START
    const maxAttempts = Math.min(range, 50)

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const port = PORT_RANGE_START + Math.floor(Math.random() * range)
      const agentPort = port + AGENT_PORT_OFFSET

      if (this.usedPorts.has(port)) continue

      const skillServerPort = agentPort + 1
      const viteInUse = await this.isPortListening(port)
      const agentInUse = await this.isPortListening(agentPort)
      const skillInUse = await this.isPortListening(skillServerPort)

      if (!viteInUse && !agentInUse && !skillInUse) {
        this.usedPorts.add(port)
        console.log(`[RuntimeManager] Allocated ports ${port}/${agentPort}/${skillServerPort}`)
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
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
   */
  private async ensureProjectDirectory(projectId: string): Promise<string> {
    const workspacesDir = this.config.workspacesDir || process.cwd()
    const projectDir = join(workspacesDir, projectId)
    const workspaceTemplateDir = join(workspacesDir, this.config.templateDir || '_template')

    // Ensure workspaces directory exists
    if (!existsSync(workspacesDir)) {
      mkdirSync(workspacesDir, { recursive: true })
    }

    // Template copy filter: exclude bun.lock so `bun install` does a fresh
    // platform-appropriate resolution (a Mac-generated lockfile causes
    // incomplete installs on Windows)
    const copyFilter = (src: string) =>
      !src.includes('node_modules') && !src.includes('.git') && !src.endsWith('bun.lock') && !src.endsWith('bun.lockb')

    const needsSeed = !existsSync(projectDir) || !existsSync(join(projectDir, 'package.json'))

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

    // Install dependencies if needed.
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

      const cmdName = pkg.isWindows ? 'npm.cmd' : 'bun'
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

  private async getProjectInfo(projectId: string): Promise<{ templateId?: string; name?: string }> {
    try {
      const { prisma } = await import('../prisma')
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { templateId: true, name: true },
      })
      return {
        templateId: project?.templateId ?? undefined,
        name: project?.name ?? undefined,
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

    // Ensure project directory exists with dependencies
    const projectDir = await this.ensureProjectDirectory(projectId)

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

      // [EXPO DISABLED] Detect if this is an Expo project
      // let isExpoProject = false
      // try {
      //   const pkgJsonPath = join(projectDir, 'package.json')
      //   if (existsSync(pkgJsonPath)) {
      //     const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
      //     isExpoProject = !!(pkgJson.dependencies?.expo || pkgJson.devDependencies?.expo)
      //   }
      // } catch {
      // }

      // [EXPO DISABLED] Expo branch commented out -- only Vite dev server path remains
      // if (isExpoProject) {
      //   console.log(`[RuntimeManager] Installing dependencies for Expo project ${projectId}...`)
      //   const installProc = spawn('bun', ['install'], {
      //     cwd: projectDir,
      //     stdio: ['ignore', 'pipe', 'pipe'],
      //     env: viteEnv,
      //   })
      //
      //   await new Promise<void>((resolve, reject) => {
      //     installProc.on('exit', (code) => {
      //       if (code === 0) {
      //         console.log(`[RuntimeManager] Dependencies installed for ${projectId}`)
      //         resolve()
      //       } else {
      //         reject(new Error(`bun install failed with code ${code}`))
      //       }
      //     })
      //     installProc.on('error', reject)
      //     installProc.stderr?.on('data', (data) => {
      //       console.error(`[RuntimeManager] bun install stderr: ${data.toString()}`)
      //     })
      //   })
      //
      //   console.log(`[RuntimeManager] Setting up database for ${projectId}...`)
      //   const prismaGenProc = spawn('bunx', ['prisma', 'generate'], {
      //     cwd: projectDir,
      //     stdio: ['ignore', 'pipe', 'pipe'],
      //     env: viteEnv,
      //   })
      //   await new Promise<void>((resolve) => {
      //     prismaGenProc.on('exit', () => resolve())
      //     prismaGenProc.on('error', () => resolve())
      //   })
      //
      //   const prismaPushProc = spawn('bunx', ['prisma', 'db', 'push', '--accept-data-loss'], {
      //     cwd: projectDir,
      //     stdio: ['ignore', 'pipe', 'pipe'],
      //     env: viteEnv,
      //   })
      //   await new Promise<void>((resolve) => {
      //     prismaPushProc.on('exit', () => resolve())
      //     prismaPushProc.on('error', () => resolve())
      //   })
      //
      //   console.log(`[RuntimeManager] Building Expo project ${projectId}...`)
      //   const buildProc = spawn('bun', ['run', 'build'], {
      //     cwd: projectDir,
      //     stdio: ['ignore', 'pipe', 'pipe'],
      //     env: viteEnv,
      //   })
      //
      //   await new Promise<void>((resolve, reject) => {
      //     buildProc.on('exit', (code) => {
      //       if (code === 0) {
      //         console.log(`[RuntimeManager] Expo build completed for ${projectId}`)
      //         resolve()
      //       } else {
      //         reject(new Error(`Expo build failed with code ${code}`))
      //       }
      //     })
      //     buildProc.on('error', reject)
      //     buildProc.stderr?.on('data', (data) => {
      //       console.error(`[RuntimeManager] Expo build stderr: ${data.toString()}`)
      //     })
      //   })
      //
      //   console.log(`[RuntimeManager] Starting Expo Hono server for ${projectId} on port ${port}`)
      //   proc = spawn('bun', ['run', 'start'], {
      //     cwd: projectDir,
      //     stdio: ['ignore', 'pipe', 'pipe'],
      //     detached: false,
      //     env: { ...viteEnv, PORT: String(port) },
      //   })
      // } else {

      // Run Vite dev server
      // Resolve vite binary directly from node_modules to avoid Windows .bin/ issue
      // (Bun on Windows may not create .bin/ shims, causing "command not found: vite")
      let proc: ReturnType<typeof spawn>
      const viteBin = join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js')
      const devArgs = existsSync(viteBin)
        ? [viteBin, '--port', String(port), '--host', '0.0.0.0']
        : ['run', 'dev', '--port', String(port), '--host', '0.0.0.0']
      proc = spawn('bun', devArgs, {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: viteEnv,
      })
      // }

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

      // Spawn unified runtime server for local development
      const runtimeServerPath = RUNTIME_SERVER
      if (existsSync(runtimeServerPath)) {
        console.log(`[RuntimeManager] Starting unified runtime for ${projectId} on port ${agentPort}`)
        
        // Build environment for runtime
        const runtimeEnv: Record<string, string> = {
          ...process.env as Record<string, string>,
          PROJECT_ID: projectId,
          PROJECT_DIR: projectDir,
          WORKSPACE_DIR: projectDir,
          ...(projectInfo.templateId ? { TEMPLATE_ID: projectInfo.templateId } : {}),
          ...(projectInfo.name ? { AGENT_NAME: projectInfo.name } : {}),
          PORT: String(agentPort),
          SKILL_SERVER_PORT: String(agentPort + 1),
          SCHEMAS_PATH: join(this.config.workspacesDir || process.cwd(), '..', '.schemas'),
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

        // Per-project runtime auth tokens (deterministic — derived from signing secret + projectId)
        const { deriveRuntimeToken, deriveWebhookToken } = await import('../runtime-token')
        runtimeEnv.RUNTIME_AUTH_SECRET = deriveRuntimeToken(projectId)
        runtimeEnv.WEBHOOK_TOKEN = deriveWebhookToken(projectId)

        // Strip the raw platform API key only when proxy is active,
        // so the child process cannot bypass billing/usage tracking.
        if (proxyConfigured) {
          delete runtimeEnv.ANTHROPIC_API_KEY
          delete runtimeEnv.ANTHROPIC_BASE_URL
        }

        // When Shogo Cloud API key is active, route all providers through the local proxy.
        // The local proxy will forward requests to the Shogo Cloud proxy.
        if (process.env.SHOGO_API_KEY) {
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
        
        const agentProc = spawn('bun', ['run', runtimeServerPath], {
          cwd: projectDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
          env: runtimeEnv,
        })

        runtime.agentProcess = agentProc

        agentProc.on('error', (err) => {
          console.error(`[RuntimeManager] Agent process error for ${projectId}:`, err)
        })

        agentProc.on('exit', (code, signal) => {
          console.log(`[RuntimeManager] Agent process exited for ${projectId}: code=${code}, signal=${signal}`)
          if (runtime.status !== 'stopping' && runtime.status !== 'stopped') {
            runtime.status = 'stopped'
          }
        })

        const agentPrefix = `[Agent:${projectId.slice(0, 8)}]`
        agentProc.stdout?.on('data', (data) => {
          const lines = data.toString().trimEnd().split('\n')
          for (const line of lines) {
            if (line) console.log(`${agentPrefix} ${line}`)
          }
        })

        agentProc.stderr?.on('data', (data) => {
          const lines = data.toString().trimEnd().split('\n')
          for (const line of lines) {
            if (line) console.error(`${agentPrefix} ${line}`)
          }
        })
      } else {
        console.warn(`[RuntimeManager] Runtime server not found at ${runtimeServerPath}, skipping startup`)
      }

      // Wait for Vite dev server if it was started
      if (runtime.process) {
        await this.waitForReady(projectId, port, 30000)
      }

      // Wait for agent server
      if (runtime.agentProcess) {
        console.log(`[RuntimeManager] Waiting for agent server on port ${agentPort}...`)
        await this.waitForAgentReady(projectId, agentPort, 30000)
        console.log(`[RuntimeManager] Agent server ready for ${projectId}`)
      }

      runtime.status = 'running'
      this.startHealthCheck(projectId)

      return this.toPublicRuntime(runtime)
    } catch (err) {
      runtime.status = 'error'
      this.releasePort(port)
      if (runtime.process) {
        runtime.process.kill('SIGTERM')
      }
      if (runtime.agentProcess) {
        runtime.agentProcess.kill('SIGTERM')
      }
      throw err
    }
  }

  /**
   * Wait for Vite server to be ready.
   * Accepts any HTTP response (including 500) as "server is ready" because:
   * - Vite returns 500 when the app has runtime errors (e.g., missing DATABASE_URL)
   * - The server is still functional and can serve the error page
   */
  private async waitForReady(projectId: string, port: number, timeoutMs: number): Promise<void> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
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
        return
      } catch {
        clearTimeout(timer)
        // Server not ready yet (connection refused, timeout, etc.)
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    throw new Error(`Timeout waiting for runtime ${projectId} to start on port ${port}`)
  }

  /**
   * Wait for the agent server to be ready and verify it's for the correct project.
   * This prevents routing to stale agent processes from other projects (e.g., after hot reload).
   */
  private async waitForAgentReady(projectId: string, port: number, _timeoutMs: number): Promise<void> {
    const MAX_RETRIES = 50
    const RETRY_DELAY_MS = 500

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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

    // Stop agent process first
    if (runtime.agentProcess) {
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
      const healthPort = runtime.agentPort && !runtime.process ? runtime.agentPort : runtime.port
      const response = await fetch(`http://localhost:${healthPort}${runtime.process ? '' : '/health'}`, {
        method: runtime.process ? 'HEAD' : 'GET',
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
  const config: Partial<IRuntimeConfig> = {
    basePort: PORT_RANGE_START,
    maxRuntimes: parseInt(process.env.RUNTIME_MAX_COUNT || '10', 10),
    healthCheckInterval: parseInt(process.env.RUNTIME_HEALTH_INTERVAL || '30000', 10),
    workspacesDir: process.env.WORKSPACES_DIR || process.cwd(),
    domainSuffix: process.env.RUNTIME_DOMAIN_SUFFIX || 'localhost',
    ...overrides,
  }

  return new RuntimeManager(config)
}

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
