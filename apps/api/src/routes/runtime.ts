/**
 * Runtime API Routes
 *
 * Endpoints for managing project Vite runtimes.
 * Follows the publish.ts pattern with project membership auth.
 *
 * Endpoints:
 * - POST /projects/:projectId/runtime/start - Spawn project runtime
 * - POST /projects/:projectId/runtime/stop - Stop project runtime
 * - GET /projects/:projectId/runtime/status - Get runtime status
 * - GET /projects/:projectId/sandbox/url - Get iframe-ready URL
 */

import { Hono } from "hono"
import type { IRuntimeManager, IProjectRuntime } from "@shogo/state-api/runtime/types"

/**
 * Configuration for runtime routes.
 * Follows publish.ts pattern for store access.
 */
export interface RuntimeRoutesConfig {
  /**
   * Studio core store for project lookup.
   */
  studioCore: {
    projectCollection: {
      query: () => {
        where: (filter: Record<string, any>) => {
          first: () => Promise<any>
        }
      }
    }
  }
  /**
   * Runtime manager for process lifecycle.
   */
  runtimeManager: IRuntimeManager
  /**
   * Domain suffix for URL generation (default: 'localhost').
   */
  domainSuffix?: string
}

/**
 * Sandbox attributes for iframe embedding.
 * Allow scripts for Vite/React, same-origin for HMR WebSocket,
 * forms for user interaction, popups for links.
 */
const SANDBOX_ATTRIBUTES = 'allow-scripts allow-same-origin allow-forms allow-popups'

/**
 * Create runtime routes.
 *
 * @param config - Route configuration
 * @returns Hono router instance
 */
export function runtimeRoutes(config: RuntimeRoutesConfig) {
  const { studioCore, runtimeManager, domainSuffix = 'localhost' } = config
  const router = new Hono()

  /**
   * Validate project exists before runtime operations.
   */
  async function validateProject(projectId: string): Promise<any | null> {
    try {
      const project = await studioCore.projectCollection
        .query()
        .where({ id: projectId })
        .first()
      return project || null
    } catch (err) {
      console.error('[Runtime] Project lookup error:', err)
      return null
    }
  }

  /**
   * POST /projects/:projectId/runtime/start - Spawn runtime
   *
   * Spawns a Vite dev server for the project.
   * Returns 409 if runtime already running.
   */
  router.post("/projects/:projectId/runtime/start", async (c) => {
    try {
      const projectId = c.req.param("projectId")

      // Validate project exists
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      // Check if already running
      const existing = runtimeManager.status(projectId)
      if (existing && (existing.status === 'running' || existing.status === 'starting')) {
        return c.json(
          { error: { code: "already_running", message: "Runtime is already running" } },
          409
        )
      }

      // Start runtime
      const runtime = await runtimeManager.start(projectId)

      return c.json({
        url: runtime.url,
        port: runtime.port,
        status: runtime.status,
        startedAt: runtime.startedAt,
      }, 200)
    } catch (error: any) {
      console.error("[Runtime] Start error:", error)
      return c.json(
        { error: { code: "start_failed", message: error.message || "Failed to start runtime" } },
        500
      )
    }
  })

  /**
   * POST /projects/:projectId/runtime/stop - Stop runtime
   *
   * Gracefully stops the project's Vite dev server.
   */
  router.post("/projects/:projectId/runtime/stop", async (c) => {
    try {
      const projectId = c.req.param("projectId")

      // Validate project exists
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      // Check if running
      const existing = runtimeManager.status(projectId)
      if (!existing) {
        return c.json(
          { error: { code: "not_running", message: "No runtime found for project" } },
          404
        )
      }

      // Stop runtime
      await runtimeManager.stop(projectId)

      return c.json({ success: true }, 200)
    } catch (error: any) {
      console.error("[Runtime] Stop error:", error)
      return c.json(
        { error: { code: "stop_failed", message: error.message || "Failed to stop runtime" } },
        500
      )
    }
  })

  /**
   * GET /projects/:projectId/runtime/status - Get runtime status
   *
   * Returns current runtime state including uptime and health.
   */
  router.get("/projects/:projectId/runtime/status", async (c) => {
    try {
      const projectId = c.req.param("projectId")

      // Validate project exists
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      // Get runtime status
      const runtime = runtimeManager.status(projectId)
      if (!runtime) {
        return c.json({
          status: "stopped",
          url: null,
          uptimeSeconds: 0,
          lastHealthCheck: null,
        }, 200)
      }

      // Calculate uptime
      const uptimeSeconds = Math.floor((Date.now() - runtime.startedAt) / 1000)

      return c.json({
        status: runtime.status,
        url: runtime.url,
        port: runtime.port,
        uptimeSeconds,
        lastHealthCheck: runtime.lastHealthCheck || null,
      }, 200)
    } catch (error: any) {
      console.error("[Runtime] Status error:", error)
      return c.json(
        { error: { code: "status_failed", message: error.message || "Failed to get status" } },
        500
      )
    }
  })

  /**
   * GET /projects/:projectId/sandbox/url - Get iframe-ready URL
   *
   * Returns the URL and sandbox attributes for embedding in an iframe.
   * Starts the runtime if not already running.
   */
  router.get("/projects/:projectId/sandbox/url", async (c) => {
    try {
      const projectId = c.req.param("projectId")

      // Validate project exists
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      // Get or start runtime
      let runtime = runtimeManager.status(projectId)
      if (!runtime || runtime.status === 'stopped' || runtime.status === 'error') {
        runtime = await runtimeManager.start(projectId)
      }

      // Build sandbox URL
      // For local dev: use direct port URL (no reverse proxy needed)
      // For production with Traefik: use subdomain routing
      const sandboxUrl = domainSuffix === 'localhost'
        ? runtime.url  // Direct port URL: http://localhost:{port}
        : `http://${projectId}.${domainSuffix}`

      return c.json({
        url: sandboxUrl,
        directUrl: runtime.url, // Direct port URL for debugging
        sandbox: SANDBOX_ATTRIBUTES,
        status: runtime.status,
      }, 200)
    } catch (error: any) {
      console.error("[Runtime] Sandbox URL error:", error)
      return c.json(
        { error: { code: "sandbox_failed", message: error.message || "Failed to get sandbox URL" } },
        500
      )
    }
  })

  return router
}

export default runtimeRoutes
