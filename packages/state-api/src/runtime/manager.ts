/**
 * Runtime Manager Implementation
 *
 * Spawns and manages Vite dev server processes per project.
 * Uses child_process.spawn with port allocation strategy (base 5200 + offset).
 *
 * @see types.ts for interface definitions
 */

import { spawn, execSync, type ChildProcess } from 'child_process'
import { existsSync, cpSync, mkdirSync, writeFileSync } from 'fs'
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
 * This template is a real Vite project created with `bun create vite`.
 */
const BUNDLED_TEMPLATE_DIR = join(__dirname, '..', '..', 'runtime-template')

/**
 * Path to the project-runtime server.
 * Used for local development to run the agent chat endpoint.
 */
const PROJECT_RUNTIME_SERVER = join(__dirname, '..', '..', '..', 'project-runtime', 'src', 'server.ts')

/**
 * Path to the MCP server (for project-runtime to spawn).
 * Uses server-templates.ts which only exposes template tools (template.list, template.copy).
 */
const MCP_SERVER_PATH = join(__dirname, '..', '..', '..', 'mcp', 'src', 'server-templates.ts')

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
 *
 * Port allocation strategy:
 * - Base port (default 5200) + project index
 * - Maintains a Map of projectId -> port assignments
 * - Recycles ports when runtimes stop
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
   * Allocate next available port starting from basePort.
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
    // For local dev, use direct port URL (no reverse proxy needed)
    // In production with Traefik, use subdomain routing
    if (domainSuffix === 'localhost') {
      return `http://localhost:${port}`
    }
    return `http://${projectId}.${domainSuffix}`
  }

  /**
   * Create a minimal Vite + React project structure.
   * Used when no template directory exists.
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
   * 
   * Template resolution order:
   * 1. Bundled template (runtime-template/ in this package) - preferred
   * 2. Workspace template (workspacesDir/_template) - for custom templates
   * 3. Inline minimal project - fallback
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
        // Use bundled Vite template from this package
        console.log(`[RuntimeManager] Copying bundled template from ${BUNDLED_TEMPLATE_DIR}`)
        cpSync(BUNDLED_TEMPLATE_DIR, projectDir, {
          recursive: true,
          filter: (src) => !src.includes('node_modules') && !src.includes('.git'),
        })
        console.log(`[RuntimeManager] Copied bundled template to ${projectDir}`)
      } else if (existsSync(workspaceTemplateDir)) {
        // Use workspace-specific template
        console.log(`[RuntimeManager] Copying workspace template from ${workspaceTemplateDir}`)
        cpSync(workspaceTemplateDir, projectDir, {
          recursive: true,
          filter: (src) => !src.includes('node_modules') && !src.includes('.git'),
        })
        console.log(`[RuntimeManager] Copied workspace template to ${projectDir}`)
      } else {
        // No template found - create minimal project inline (fallback)
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
          timeout: 60000, // 60 second timeout for install
        })
        console.log(`[RuntimeManager] Dependencies installed for ${projectId}`)
      } catch (err: any) {
        console.error(`[RuntimeManager] Failed to install dependencies:`, err.message)
        throw new Error(`Failed to install dependencies for project ${projectId}`)
      }
    }

    return projectDir
  }

  async start(projectId: string): Promise<IProjectRuntime> {
    // Check if already running
    const existing = this.runtimes.get(projectId)
    if (existing && existing.status === 'running') {
      throw new Error(`Runtime for project ${projectId} is already running`)
    }

    // Ensure project directory exists with dependencies
    const projectDir = await this.ensureProjectDirectory(projectId)

    // Allocate ports - Vite preview and agent server
    const port = this.allocatePort()
    const agentPort = port + 1000 // Agent server runs 1000 ports higher (e.g., 5200 -> 6200)
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
      // Spawn Vite dev server in the project directory
      // Use `bun run dev` to properly initialize TanStack Start and other Vite plugins
      // Pass port via VITE_PORT env var since some frameworks don't support --port flag directly
      const proc = spawn('bun', ['run', 'dev', '--port', String(port), '--host', '0.0.0.0'], {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: {
          ...process.env,
          PROJECT_ID: projectId,
          VITE_PROJECT_ID: projectId,
          VITE_PORT: String(port),
          PORT: String(port),
        },
      })

      runtime.process = proc

      // Handle Vite process events
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
        // Detect when Vite is ready
        if (output.includes('Local:') || output.includes('ready in')) {
          console.log(`[RuntimeManager] Vite ready for ${projectId} on port ${port}`)
        }
      })

      proc.stderr?.on('data', (data) => {
        console.error(`[RuntimeManager] Vite stderr for ${projectId}:`, data.toString())
      })

      // Spawn project-runtime agent server for local development
      // This provides the /agent/chat endpoint that the API proxies to
      if (existsSync(PROJECT_RUNTIME_SERVER)) {
        console.log(`[RuntimeManager] Starting agent server for ${projectId} on port ${agentPort}`)
        const agentProc = spawn('bun', ['run', PROJECT_RUNTIME_SERVER], {
          cwd: projectDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
          env: {
            ...process.env,
            PROJECT_ID: projectId,
            PROJECT_DIR: projectDir,
            PORT: String(agentPort),
            SCHEMAS_PATH: join(this.config.workspacesDir || process.cwd(), '..', '.schemas'),
            MCP_SERVER_PATH: MCP_SERVER_PATH,
            NODE_ENV: 'development',
          },
        })

        runtime.agentProcess = agentProc

        agentProc.on('error', (err) => {
          console.error(`[RuntimeManager] Agent process error for ${projectId}:`, err)
        })

        agentProc.on('exit', (code, signal) => {
          console.log(`[RuntimeManager] Agent process exited for ${projectId}: code=${code}, signal=${signal}`)
        })

        agentProc.stdout?.on('data', (data) => {
          const output = data.toString()
          if (output.includes('Starting server') || output.includes('port')) {
            console.log(`[RuntimeManager] Agent server ready for ${projectId} on port ${agentPort}`)
          }
        })

        agentProc.stderr?.on('data', (data) => {
          console.error(`[RuntimeManager] Agent stderr for ${projectId}:`, data.toString())
        })
      } else {
        console.warn(`[RuntimeManager] Agent server not found at ${PROJECT_RUNTIME_SERVER}, skipping agent startup`)
      }

      // Wait for Vite to start (with timeout)
      await this.waitForReady(projectId, port, 30000)

      // Wait for agent server to be ready (critical for chat functionality)
      // This prevents the race condition where chat requests fail because
      // the agent server hasn't finished starting
      if (runtime.agentProcess) {
        console.log(`[RuntimeManager] Waiting for agent server on port ${agentPort}...`)
        await this.waitForAgentReady(projectId, agentPort, 30000)
        console.log(`[RuntimeManager] Agent server ready for ${projectId}`)
      }

      runtime.status = 'running'

      // Start health check timer
      this.startHealthCheck(projectId)

      // Return public runtime info (without process)
      return this.toPublicRuntime(runtime)
    } catch (err) {
      // Cleanup on failure
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
        if (response.ok || response.status === 404) {
          // Server is responding (404 is ok - may be a Vite placeholder page)
          return
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    throw new Error(`Timeout waiting for runtime ${projectId} to start on port ${port}`)
  }

  /**
   * Wait for the agent server (project-runtime) to be ready.
   * Checks the /health endpoint to ensure the server can accept requests.
   * Uses constant 500ms delay with max 50 retries (up to 25 seconds total).
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
          // Agent server is ready
          return
        }
      } catch {
        // Server not ready yet
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
      throw new Error(`No runtime found for project ${projectId}`)
    }

    // Stop health check
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
      // Send SIGTERM for graceful shutdown
      runtime.process.kill('SIGTERM')

      // Wait for process to exit with timeout
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          // Force kill if not exited
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
   * Restart the runtime for the specified project.
   * Stops the current runtime (if running) and starts a new one.
   * Useful after major file changes like template copy.
   */
  async restart(projectId: string): Promise<IProjectRuntime> {
    console.log(`[RuntimeManager] Restarting runtime for ${projectId}`)
    
    // Stop if currently running
    const existing = this.runtimes.get(projectId)
    if (existing && existing.status !== 'stopped') {
      console.log(`[RuntimeManager] Stopping existing runtime for ${projectId}`)
      await this.stop(projectId)
    }
    
    // Start fresh
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
      const response = await fetch(`http://localhost:${runtime.port}`, {
        method: 'HEAD',
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

  /**
   * Start periodic health checks for a runtime.
   */
  private startHealthCheck(projectId: string): void {
    const timer = setInterval(() => {
      this.getHealth(projectId).catch((err) =>
        console.error(`[RuntimeManager] Health check error for ${projectId}:`, err)
      )
    }, this.config.healthCheckInterval)

    this.healthCheckTimers.set(projectId, timer)
  }

  /**
   * Stop health checks for a runtime.
   */
  private stopHealthCheck(projectId: string): void {
    const timer = this.healthCheckTimers.get(projectId)
    if (timer) {
      clearInterval(timer)
      this.healthCheckTimers.delete(projectId)
    }
  }

  /**
   * Convert internal runtime to public interface (strips process handle).
   */
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
