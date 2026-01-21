/**
 * Runtime Manager Types
 *
 * TypeScript interfaces for runtime management: IRuntimeManager (orchestration),
 * IProjectRuntime (per-instance state), IRuntimeConfig (env config),
 * IHealthStatus (health checks).
 *
 * Pure types with no runtime imports following service-interface pattern.
 *
 * @see packages/state-api/src/auth/types.ts for similar pattern
 */

/**
 * Runtime status enum representing the lifecycle states of a project runtime.
 */
export type RuntimeStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

/**
 * Health status for a project runtime.
 * Used by getHealth() to report runtime health.
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
 * Passed to RuntimeManager constructor for customization.
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
 *
 * Responsible for:
 * - Spawning Vite dev server processes per project
 * - Port allocation and tracking
 * - Health monitoring
 * - Graceful shutdown
 *
 * Implementations:
 * - RuntimeManager (production - spawns real Vite processes)
 * - MockRuntimeManager (testing - simulates lifecycle)
 */
export interface IRuntimeManager {
  /**
   * Start a runtime for the specified project.
   * Spawns a Vite dev server with a unique port.
   *
   * @param projectId - The project to start runtime for
   * @returns The started runtime instance
   * @throws If max runtimes reached or spawn fails
   */
  start(projectId: string): Promise<IProjectRuntime>

  /**
   * Stop the runtime for the specified project.
   * Sends SIGTERM and waits for graceful shutdown.
   *
   * @param projectId - The project to stop runtime for
   * @returns void on success
   * @throws If project has no active runtime
   */
  stop(projectId: string): Promise<void>

  /**
   * Restart the runtime for the specified project.
   * Stops the current runtime and starts a new one.
   * Useful after major file changes (e.g., template copy).
   *
   * @param projectId - The project to restart runtime for
   * @returns The restarted runtime instance
   */
  restart(projectId: string): Promise<IProjectRuntime>

  /**
   * Get the current status of a project's runtime.
   *
   * @param projectId - The project to check
   * @returns Runtime instance if exists, null otherwise
   */
  status(projectId: string): IProjectRuntime | null

  /**
   * Perform health check on a project's runtime.
   *
   * @param projectId - The project to health check
   * @returns Health status with healthy flag and last check time
   */
  getHealth(projectId: string): Promise<IHealthStatus>

  /**
   * Stop all active runtimes.
   * Used during graceful server shutdown.
   *
   * @returns void when all runtimes stopped
   */
  stopAll(): Promise<void>

  /**
   * Get list of all active project IDs.
   *
   * @returns Array of project IDs with active runtimes
   */
  getActiveProjects(): string[]
}
