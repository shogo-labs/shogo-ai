/**
 * Mock Runtime Manager
 *
 * Simulates runtime lifecycle without spawning actual processes.
 * Tracks state transitions and provides test helpers.
 *
 * @see types.ts for interface definitions
 */

import type {
  IRuntimeManager,
  IProjectRuntime,
  IRuntimeConfig,
  IHealthStatus,
  RuntimeStatus,
} from './types'

/** Default configuration for mock */
const DEFAULT_CONFIG: IRuntimeConfig = {
  basePort: 5200,
  maxRuntimes: 10,
  healthCheckInterval: 30000,
  workspacesDir: '/mock/workspaces',
  domainSuffix: 'localhost',
}

/** Configuration for simulating delays and failures */
export interface MockRuntimeConfig extends Partial<IRuntimeConfig> {
  /** Delay in ms for start operation (default: 0) */
  startDelay?: number
  /** Delay in ms for stop operation (default: 0) */
  stopDelay?: number
  /** Project IDs that should fail on start */
  failOnStart?: string[]
  /** Project IDs that should report unhealthy */
  unhealthyProjects?: string[]
}

/**
 * MockRuntimeManager for testing.
 *
 * Features:
 * - Simulates runtime lifecycle without real processes
 * - Configurable delays for async operations
 * - Configurable failure modes
 * - Test helpers for assertions
 */
export class MockRuntimeManager implements IRuntimeManager {
  private config: IRuntimeConfig & MockRuntimeConfig
  private runtimes: Map<string, IProjectRuntime> = new Map()
  private usedPorts: Set<number> = new Set()

  /** History of started project IDs */
  private startHistory: string[] = []
  /** History of stopped project IDs */
  private stopHistory: string[] = []

  constructor(config: MockRuntimeConfig = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      startDelay: 0,
      stopDelay: 0,
      failOnStart: [],
      unhealthyProjects: [],
      ...config,
    }
  }

  /**
   * Allocate next available port.
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
    throw new Error(`Maximum runtimes (${maxRuntimes}) reached`)
  }

  /**
   * Release a port.
   */
  private releasePort(port: number): void {
    this.usedPorts.delete(port)
  }

  /**
   * Build mock URL for project.
   */
  private buildUrl(projectId: string, port: number): string {
    return `http://${projectId}.${this.config.domainSuffix}:${port}`
  }

  async start(projectId: string): Promise<IProjectRuntime> {
    // Check if should fail
    if (this.config.failOnStart?.includes(projectId)) {
      throw new Error(`Mock failure: Cannot start runtime for ${projectId}`)
    }

    // Check if already running
    const existing = this.runtimes.get(projectId)
    if (existing && existing.status === 'running') {
      throw new Error(`Runtime for project ${projectId} is already running`)
    }

    // Simulate delay
    if (this.config.startDelay && this.config.startDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.startDelay))
    }

    // Allocate port and create runtime
    const port = this.allocatePort()
    const runtime: IProjectRuntime = {
      id: projectId,
      port,
      status: 'running',
      url: this.buildUrl(projectId, port),
      startedAt: Date.now(),
    }

    this.runtimes.set(projectId, runtime)
    this.startHistory.push(projectId)

    return runtime
  }

  async stop(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId)
    if (!runtime) {
      throw new Error(`No runtime found for project ${projectId}`)
    }

    // Simulate delay
    if (this.config.stopDelay && this.config.stopDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.stopDelay))
    }

    this.releasePort(runtime.port)
    this.runtimes.delete(projectId)
    this.stopHistory.push(projectId)
  }

  status(projectId: string): IProjectRuntime | null {
    return this.runtimes.get(projectId) ?? null
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

    // Check if configured as unhealthy
    if (this.config.unhealthyProjects?.includes(projectId)) {
      const healthStatus: IHealthStatus = {
        healthy: false,
        lastCheck: Date.now(),
        error: 'Mock unhealthy status',
      }
      runtime.lastHealthCheck = healthStatus
      return healthStatus
    }

    const healthStatus: IHealthStatus = {
      healthy: true,
      lastCheck: Date.now(),
    }
    runtime.lastHealthCheck = healthStatus
    return healthStatus
  }

  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.runtimes.keys()).map((projectId) =>
      this.stop(projectId)
    )
    await Promise.all(stopPromises)
  }

  getActiveProjects(): string[] {
    return Array.from(this.runtimes.keys()).filter((id) => {
      const runtime = this.runtimes.get(id)
      return runtime && runtime.status === 'running'
    })
  }

  // =========================================================================
  // Test Helpers
  // =========================================================================

  /**
   * Get all project IDs that were started.
   */
  getStartedProjects(): string[] {
    return [...this.startHistory]
  }

  /**
   * Get all project IDs that were stopped.
   */
  getStoppedProjects(): string[] {
    return [...this.stopHistory]
  }

  /**
   * Get current runtime count.
   */
  getRuntimeCount(): number {
    return this.runtimes.size
  }

  /**
   * Get all active runtimes.
   */
  getAllRuntimes(): IProjectRuntime[] {
    return Array.from(this.runtimes.values())
  }

  /**
   * Check if a specific project has been started.
   */
  wasStarted(projectId: string): boolean {
    return this.startHistory.includes(projectId)
  }

  /**
   * Check if a specific project has been stopped.
   */
  wasStopped(projectId: string): boolean {
    return this.stopHistory.includes(projectId)
  }

  /**
   * Reset all state (runtimes, history, ports).
   */
  reset(): void {
    this.runtimes.clear()
    this.usedPorts.clear()
    this.startHistory = []
    this.stopHistory = []
  }

  /**
   * Configure a project to fail on start.
   */
  setFailOnStart(projectId: string): void {
    if (!this.config.failOnStart) {
      this.config.failOnStart = []
    }
    if (!this.config.failOnStart.includes(projectId)) {
      this.config.failOnStart.push(projectId)
    }
  }

  /**
   * Configure a project to report unhealthy.
   */
  setUnhealthy(projectId: string): void {
    if (!this.config.unhealthyProjects) {
      this.config.unhealthyProjects = []
    }
    if (!this.config.unhealthyProjects.includes(projectId)) {
      this.config.unhealthyProjects.push(projectId)
    }
  }

  /**
   * Remove failure configuration for a project.
   */
  clearFailure(projectId: string): void {
    if (this.config.failOnStart) {
      this.config.failOnStart = this.config.failOnStart.filter((id) => id !== projectId)
    }
    if (this.config.unhealthyProjects) {
      this.config.unhealthyProjects = this.config.unhealthyProjects.filter(
        (id) => id !== projectId
      )
    }
  }

  /**
   * Set the delay for start operations.
   */
  setStartDelay(ms: number): void {
    this.config.startDelay = ms
  }

  /**
   * Set the delay for stop operations.
   */
  setStopDelay(ms: number): void {
    this.config.stopDelay = ms
  }
}

/**
 * Create a MockRuntimeManager with default test configuration.
 */
export function createMockRuntimeManager(config?: MockRuntimeConfig): MockRuntimeManager {
  return new MockRuntimeManager(config)
}
