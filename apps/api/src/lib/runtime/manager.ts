// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime Manager Implementation
 *
 * Spawns and manages Vite dev server processes per project.
 * Uses child_process.spawn with port allocation strategy (base 5200 + offset).
 */

import { spawn, execSync, type ChildProcess } from 'child_process'
import { existsSync, cpSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
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
 * Path to the project-runtime server.
 * Used for local development to run the agent chat endpoint.
 */
const PROJECT_RUNTIME_SERVER = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'project-runtime', 'src', 'server.ts')

/**
 * Path to the agent-runtime server.
 * In desktop mode, AGENT_RUNTIME_ENTRY points to the bun-built bundle.
 * Falls back to source path for cloud/local dev.
 */
const AGENT_RUNTIME_SERVER = process.env.AGENT_RUNTIME_ENTRY
  || join(__dirname, '..', '..', '..', '..', '..', 'packages', 'agent-runtime', 'src', 'server.ts')

/**
 * Path to the MCP server (for project-runtime to spawn).
 */
const MCP_SERVER_PATH = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'project-runtime', 'src', 'mcp-templates.ts')

/** Default configuration values */
const DEFAULT_CONFIG: IRuntimeConfig = {
  basePort: 5200,
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

  constructor(config: Partial<IRuntimeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Check if a port is actually in use by attempting to connect to it.
   * This helps detect stale processes from previous API server instances.
   */
  private async isPortInUse(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://localhost:${port}/`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(500),
      })
      return true // Port responded
    } catch {
      return false // Port not responding
    }
  }

  /**
   * Kill any process running on the specified port.
   * Cross-platform: uses lsof on macOS/Linux, netstat on Windows.
   *
   * Excludes the current process (and its parent) to avoid
   * the API server killing itself when it has connections to the port.
   */
  private killProcessOnPort(port: number): void {
    try {
      const isWindows = process.platform === 'win32'
      let pids: string[] = []

      if (isWindows) {
        const result = execSync(
          `netstat -ano | findstr :${port} | findstr LISTENING`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim()
        pids = result.split('\n')
          .map(line => line.trim().split(/\s+/).pop() || '')
          .filter(pid => pid.length > 0 && pid !== '0')
        pids = [...new Set(pids)]
      } else {
        const result = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf-8' })
        pids = result.trim().split('\n').filter(pid => pid.length > 0)
      }

      const selfPid = String(process.pid)
      const parentPid = String(process.ppid)
      const safePids = pids.filter(pid => pid !== selfPid && pid !== parentPid)

      if (pids.length > 0 && safePids.length === 0) {
        console.log(`[RuntimeManager] Port ${port} is held by the current process — skipping kill`)
      }

      for (const pid of safePids) {
        try {
          console.log(`[RuntimeManager] Killing stale process ${pid} on port ${port}`)
          if (isWindows) {
            execSync(`taskkill /F /PID ${pid} 2>nul`, { stdio: 'pipe' })
          } else {
            execSync(`kill -9 ${pid} 2>/dev/null || true`)
          }
        } catch {
          // Process might have already exited
        }
      }
      
      if (safePids.length > 0) {
        if (isWindows) {
          execSync('timeout /t 1 /nobreak >nul 2>&1', { stdio: 'pipe' })
        } else {
          execSync('sleep 0.5')
        }
      }
    } catch (err) {
      console.warn(`[RuntimeManager] Failed to kill process on port ${port}:`, err)
    }
  }

  /**
   * Allocate a port for a project - in local dev, always use the same port per project.
   * If the port is in use by a stale process, kill it first.
   * This ensures consistent port assignments and avoids port drift on hot reload.
   */
  private async allocatePortAsync(): Promise<number> {
    const { basePort, maxRuntimes } = this.config
    
    // In local development, always try to use basePort first (5200)
    // This provides consistent URLs and avoids confusion
    const port = basePort
    const agentPort = port + 1000
    
    // Check if ports are in use
    const viteInUse = await this.isPortInUse(port)
    const agentInUse = await this.isPortInUse(agentPort)
    
    // If either port is in use by a stale process, kill it
    if (viteInUse) {
      console.log(`[RuntimeManager] Port ${port} is in use, killing stale process...`)
      this.killProcessOnPort(port)
    }
    if (agentInUse) {
      console.log(`[RuntimeManager] Port ${agentPort} is in use, killing stale process...`)
      this.killProcessOnPort(agentPort)
    }
    
    // Verify ports are now free
    const stillViteInUse = await this.isPortInUse(port)
    const stillAgentInUse = await this.isPortInUse(agentPort)
    
    if (stillViteInUse || stillAgentInUse) {
      console.error(`[RuntimeManager] Failed to free ports ${port}/${agentPort}, trying next available...`)
      // Fall back to finding next available port
      for (let offset = 1; offset < maxRuntimes; offset++) {
        const nextPort = basePort + offset
        const nextAgentPort = nextPort + 1000
        if (!this.usedPorts.has(nextPort)) {
          const nextViteInUse = await this.isPortInUse(nextPort)
          const nextAgentInUse = await this.isPortInUse(nextAgentPort)
          if (!nextViteInUse && !nextAgentInUse) {
            this.usedPorts.add(nextPort)
            return nextPort
          }
        }
      }
      throw new Error(`Cannot allocate port - all ports occupied`)
    }
    
    this.usedPorts.add(port)
    return port
  }

  /**
   * Allocate next available port starting from basePort.
   * @deprecated Use allocatePortAsync for proper stale process detection
   */
  private allocatePort(): number {
    const { basePort, maxRuntimes } = this.config
    for (let offset = 0; offset < maxRuntimes; offset++) {
      const port = basePort + offset
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port)
        return port
      }
    }
    throw new Error(`Maximum runtimes (${maxRuntimes}) reached. Cannot allocate port.`)
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

    // Check if project directory exists
    if (!existsSync(projectDir)) {
      console.log(`[RuntimeManager] Creating project directory for ${projectId}`)

      // Create project directory
      mkdirSync(projectDir, { recursive: true })

      // Template resolution order: bundled > workspace > inline
      if (existsSync(BUNDLED_TEMPLATE_DIR) && existsSync(join(BUNDLED_TEMPLATE_DIR, 'package.json'))) {
        console.log(`[RuntimeManager] Copying bundled template from ${BUNDLED_TEMPLATE_DIR}`)
        cpSync(BUNDLED_TEMPLATE_DIR, projectDir, {
          recursive: true,
          filter: (src) => !src.includes('node_modules') && !src.includes('.git'),
        })
        console.log(`[RuntimeManager] Copied bundled template to ${projectDir}`)
      } else if (existsSync(workspaceTemplateDir)) {
        console.log(`[RuntimeManager] Copying workspace template from ${workspaceTemplateDir}`)
        cpSync(workspaceTemplateDir, projectDir, {
          recursive: true,
          filter: (src) => !src.includes('node_modules') && !src.includes('.git'),
        })
        console.log(`[RuntimeManager] Copied workspace template to ${projectDir}`)
      } else {
        console.log(`[RuntimeManager] No template found, creating minimal project inline`)
        this.createMinimalProject(projectDir)
      }
    }

    // Check if node_modules exists, if not install dependencies
    const nodeModulesDir = join(projectDir, 'node_modules')
    if (!existsSync(nodeModulesDir)) {
      console.log(`[RuntimeManager] Installing dependencies for ${projectId}...`)
      try {
        execSync('bun install', {
          cwd: projectDir,
          stdio: 'pipe',
          timeout: 60000,
        })
        console.log(`[RuntimeManager] Dependencies installed for ${projectId}`)
      } catch (err: any) {
        console.error(`[RuntimeManager] Failed to install dependencies:`, err.message)
        throw new Error(`Failed to install dependencies for project ${projectId}`)
      }
    }

    return projectDir
  }

  private async getProjectInfo(projectId: string): Promise<{ type: 'APP' | 'AGENT'; templateId?: string; name?: string }> {
    try {
      const { prisma } = await import('../prisma')
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { type: true, templateId: true, name: true },
      })
      return {
        type: (project?.type as 'APP' | 'AGENT') || 'APP',
        templateId: project?.templateId ?? undefined,
        name: project?.name ?? undefined,
      }
    } catch {
      return { type: 'APP' }
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

  async start(projectId: string): Promise<IProjectRuntime> {
    // Check if already running
    const existing = this.runtimes.get(projectId)
    if (existing && existing.status === 'running') {
      throw new Error(`Runtime for project ${projectId} is already running`)
    }

    const projectInfo = await this.getProjectInfo(projectId)
    const isAgentProject = projectInfo.type === 'AGENT'

    // Ensure project directory exists with dependencies
    const projectDir = await this.ensureProjectDirectory(projectId)

    // Allocate ports (async to check for stale processes)
    const port = await this.allocatePortAsync()
    const agentPort = port + 1000
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
      // Agent projects don't need a Vite dev server — only the agent-runtime
      if (!isAgentProject) {

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
      let proc: ReturnType<typeof spawn>
      const devArgs = ['run', 'dev', '--port', String(port), '--host', '0.0.0.0']
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

      } // end if (!isAgentProject) — skip Vite for agent projects

      // Spawn runtime agent server for local development
      const runtimeServerPath = isAgentProject ? AGENT_RUNTIME_SERVER : PROJECT_RUNTIME_SERVER
      if (existsSync(runtimeServerPath)) {
        console.log(`[RuntimeManager] Starting ${isAgentProject ? 'agent' : 'project'} runtime for ${projectId} on port ${agentPort}`)
        
        // Build environment for runtime
        const runtimeEnv: Record<string, string> = {
          ...process.env as Record<string, string>,
          PROJECT_ID: projectId,
          PROJECT_DIR: projectDir,
          ...(isAgentProject ? { AGENT_DIR: projectDir } : {}),
          ...(projectInfo.templateId ? { TEMPLATE_ID: projectInfo.templateId } : {}),
          ...(projectInfo.name ? { AGENT_NAME: projectInfo.name } : {}),
          PORT: String(agentPort),
          SCHEMAS_PATH: join(this.config.workspacesDir || process.cwd(), '..', '.schemas'),
          MCP_SERVER_PATH: MCP_SERVER_PATH,
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

        try {
          const { generateProxyToken } = await import('../ai-proxy-token')
          const { getProjectOwnerUserId } = await import('../project-user-context')
          const workspaceId = await this.getProjectWorkspaceId(projectId) || 'local-dev'
          const ownerUserId = await getProjectOwnerUserId(projectId)
          runtimeEnv.AI_PROXY_TOKEN = await generateProxyToken(projectId, workspaceId, ownerUserId, 7 * 24 * 60 * 60 * 1000)
          console.log(`[RuntimeManager] Generated AI proxy token for ${projectId} (workspace: ${workspaceId}, owner: ${ownerUserId})`)
        } catch (err: any) {
          console.error(`[RuntimeManager] Failed to generate proxy token for ${projectId}: ${err.message}`)
          console.error(`[RuntimeManager] Runtime will start without AI proxy — LLM calls will fail`)
        }

        // Tools proxy URL — enables file-index-engine embeddings and other tool
        // requests to route through the API server (same as Kubernetes managers do).
        runtimeEnv.TOOLS_PROXY_URL = `http://localhost:${apiPort}/api`

        // Strip the raw platform API key so the child process cannot bypass the proxy.
        delete runtimeEnv.ANTHROPIC_API_KEY
        delete runtimeEnv.ANTHROPIC_BASE_URL
        
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

        agentProc.stdout?.on('data', (data) => {
          const output = data.toString().trim()
          if (output) {
            console.log(`[Agent:${projectId.slice(0, 8)}] ${output}`)
          }
        })

        agentProc.stderr?.on('data', (data) => {
          const output = data.toString().trim()
          if (output) {
            console.error(`[Agent:${projectId.slice(0, 8)}] ${output}`)
          }
        })
      } else {
        console.warn(`[RuntimeManager] Runtime server not found at ${runtimeServerPath}, skipping startup`)
      }

      // Wait for Vite to start (skip for agent projects — no Vite)
      if (!isAgentProject) {
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
      try {
        const response = await fetch(`http://localhost:${port}`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(1000),
        })
        // Accept any response - server is running even if app has errors
        // This includes 200, 404, 500, etc.
        return
      } catch {
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
      try {
        const response = await fetch(`http://localhost:${port}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(2000),
        })
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

    try {
      const healthPort = runtime.agentPort && !runtime.process ? runtime.agentPort : runtime.port
      const response = await fetch(`http://localhost:${healthPort}${runtime.process ? '' : '/health'}`, {
        method: runtime.process ? 'HEAD' : 'GET',
        signal: AbortSignal.timeout(5000),
      })

      const healthStatus: IHealthStatus = {
        healthy: response.ok || response.status === 404,
        lastCheck: Date.now(),
      }

      runtime.lastHealthCheck = healthStatus
      return healthStatus
    } catch (err: any) {
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
    basePort: parseInt(process.env.RUNTIME_BASE_PORT || '5200', 10),
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
