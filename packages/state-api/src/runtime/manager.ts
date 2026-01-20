/**
 * Runtime Manager Implementation
 *
 * Spawns and manages Vite dev server processes per project.
 * Uses child_process.spawn with port allocation strategy (base 5200 + offset).
 *
 * @see types.ts for interface definitions
 */

import { spawn, execSync, type ChildProcess } from 'child_process'
import { existsSync, cpSync, mkdirSync } from 'fs'
import { join } from 'path'
import type {
  IRuntimeManager,
  IProjectRuntime,
  IRuntimeConfig,
  IHealthStatus,
  RuntimeStatus,
} from './types'

/** Default configuration values */
const DEFAULT_CONFIG: IRuntimeConfig = {
  basePort: 5200,
  maxRuntimes: 10,
  healthCheckInterval: 30000,
  workspacesDir: process.cwd(),
  domainSuffix: 'localhost',
  templateDir: '_template',
}

/** Internal runtime state with process handle */
interface InternalRuntime extends IProjectRuntime {
  process: ChildProcess | null
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
   * Ensure project directory exists with Vite setup.
   * Copies from template if needed and installs dependencies.
   */
  private async ensureProjectDirectory(projectId: string): Promise<string> {
    const workspacesDir = this.config.workspacesDir || process.cwd()
    const projectDir = join(workspacesDir, projectId)
    const templateDir = join(workspacesDir, this.config.templateDir || '_template')

    // Check if project directory exists
    if (!existsSync(projectDir)) {
      console.log(`[RuntimeManager] Creating project directory for ${projectId}`)

      // Check if template exists
      if (!existsSync(templateDir)) {
        throw new Error(`Template directory not found: ${templateDir}`)
      }

      // Create project directory
      mkdirSync(projectDir, { recursive: true })

      // Copy template to project directory (exclude node_modules to install fresh)
      cpSync(templateDir, projectDir, {
        recursive: true,
        filter: (src) => !src.includes('node_modules'),
      })
      console.log(`[RuntimeManager] Copied template to ${projectDir}`)
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

    // Allocate port
    const port = this.allocatePort()
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
    }
    this.runtimes.set(projectId, runtime)

    try {
      // Spawn Vite dev server in the project directory
      const proc = spawn('bun', ['run', 'vite', '--port', String(port), '--host', '0.0.0.0'], {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: {
          ...process.env,
          PROJECT_ID: projectId,
          VITE_PROJECT_ID: projectId,
          VITE_PORT: String(port),
        },
      })

      runtime.process = proc

      // Handle process events
      proc.on('error', (err) => {
        console.error(`[RuntimeManager] Process error for ${projectId}:`, err)
        runtime.status = 'error'
      })

      proc.on('exit', (code, signal) => {
        console.log(`[RuntimeManager] Process exited for ${projectId}: code=${code}, signal=${signal}`)
        if (runtime.status !== 'stopping' && runtime.status !== 'stopped') {
          runtime.status = 'stopped'
        }
        this.releasePort(port)
      })

      proc.stdout?.on('data', (data) => {
        const output = data.toString()
        // Detect when Vite is ready
        if (output.includes('Local:') || output.includes('ready in')) {
          runtime.status = 'running'
          console.log(`[RuntimeManager] Vite ready for ${projectId} on port ${port}`)
        }
      })

      proc.stderr?.on('data', (data) => {
        console.error(`[RuntimeManager] Vite stderr for ${projectId}:`, data.toString())
      })

      // Wait for Vite to start (with timeout)
      await this.waitForReady(projectId, port, 30000)

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

  async stop(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId)
    if (!runtime) {
      throw new Error(`No runtime found for project ${projectId}`)
    }

    // Stop health check
    this.stopHealthCheck(projectId)

    runtime.status = 'stopping'

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
