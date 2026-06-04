// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
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
   *
   * `opts.background` marks a non-UI start (the local heartbeat scheduler):
   * such runtimes are kept out of the warm-preview cap and are managed as a
   * separate system. Defaults to a foreground (preview) start.
   */
  start(projectId: string, opts?: { background?: boolean }): Promise<IProjectRuntime>

  /**
   * Stop the runtime for the specified project.
   *
   * `reason` is a diagnostic tag identifying the trigger (e.g. 'preview-lru',
   * 'background-lru', 'attach-restart', 'shutdown', 'external'); it is logged
   * so a runtime teardown can be attributed to its cause.
   */
  stop(projectId: string, reason?: string): Promise<void>

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

  /**
   * Mark a project as recently active. Resets the idle-eviction
   * window in the underlying agent-runtime manager so a long chat
   * stream / background tool call doesn't get reaped at 15 minutes.
   *
   * Called from:
   *   - the `/api/projects/:id/agent-proxy/*` request path on every
   *     incoming request and on every forwarded SSE chunk, and
   *   - the AI proxy after a project-scoped token decodes, so the
   *     agent's outbound model calls also keep its runtime alive.
   *
   * Safe no-op if no runtime exists for `projectId`.
   */
  touch(projectId: string): void

  /**
   * Mark a project's preview as actively open in the UI (the
   * `GET /sandbox/url` signal). Promotes a background/heartbeat runtime the
   * user just opened into the protected foreground preview set and refreshes
   * its position in the warm-preview MRU so the project currently on screen is
   * never the LRU eviction victim. Unlike {@link touch}, this must only be
   * called from the UI preview-open path (never from agent/chat traffic, which
   * can be heartbeat-driven).
   *
   * Safe no-op when the project has no running anchored runtime.
   */
  markPreviewActive(projectId: string): void
}
