/**
 * Runtime Manager Types
 *
 * TypeScript interfaces for runtime management: IRuntimeManager (orchestration),
 * IProjectRuntime (per-instance state), IRuntimeConfig (env config),
 * IHealthStatus (health checks).
 */

/**
 * Runtime status enum representing the lifecycle states of a project runtime.
 */
export type RuntimeStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

/**
 * Health status for a project runtime.
 */
export interface IHealthStatus {
  /** Whether the runtime is healthy and responding */
  healthy: boolean
  /** Timestamp of the last health check (Unix ms) */
  lastCheck: number
  /** Error message if health check failed */
  error?: string
}

/**
 * Per-project runtime instance state.
 * Represents a running Vite dev server for a specific project.
 */
export interface IProjectRuntime {
  /** Project ID this runtime belongs to */
  id: string
  /** Port the Vite dev server is running on */
  port: number
  /** Port the agent server is running on (for local dev) */
  agentPort?: number
  /** Current status of the runtime */
  status: RuntimeStatus
  /** Full URL to access the runtime (e.g., http://localhost:5200) */
  url: string
  /** Timestamp when runtime started (Unix ms) */
  startedAt: number
  /** Last health check result */
  lastHealthCheck?: IHealthStatus
}

/**
 * Configuration for the RuntimeManager.
 */
export interface IRuntimeConfig {
  /** Base port for Vite dev servers (default: 5200) */
  basePort: number
  /** Maximum number of concurrent runtimes (default: 10) */
  maxRuntimes: number
  /** Health check interval in milliseconds (default: 30000) */
  healthCheckInterval: number
  /** Directory containing project workspaces */
  workspacesDir?: string
  /** Domain suffix for subdomain routing (default: 'localhost') */
  domainSuffix?: string
  /** Template directory name within workspacesDir (default: '_template') */
  templateDir?: string
}

/**
 * Runtime Manager interface for orchestrating project Vite runtimes.
 */
export interface IRuntimeManager {
  /**
   * Start a runtime for the specified project.
   */
  start(projectId: string): Promise<IProjectRuntime>

  /**
   * Stop the runtime for the specified project.
   */
  stop(projectId: string): Promise<void>

  /**
   * Restart the runtime for the specified project.
   */
  restart(projectId: string): Promise<IProjectRuntime>

  /**
   * Get the current status of a project's runtime.
   */
  status(projectId: string): IProjectRuntime | null

  /**
   * Perform health check on a project's runtime.
   */
  getHealth(projectId: string): Promise<IHealthStatus>

  /**
   * Stop all active runtimes.
   */
  stopAll(): Promise<void>

  /**
   * Get list of all active project IDs.
   */
  getActiveProjects(): string[]
}
