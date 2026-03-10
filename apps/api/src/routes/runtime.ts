// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime API Routes
 *
 * Endpoints for managing project Vite runtimes.
 * Uses Prisma for project validation.
 *
 * Endpoints:
 * - POST /projects/:projectId/runtime/start - Spawn project runtime
 * - POST /projects/:projectId/runtime/stop - Stop project runtime
 * - GET /projects/:projectId/runtime/status - Get runtime status
 * - GET /projects/:projectId/sandbox/url - Get iframe-ready URL
 */

import { Hono } from "hono"
import { existsSync } from "fs"
import { join } from "path"
import { prisma } from "../lib/prisma"
import type { IRuntimeManager, IProjectRuntime } from "../lib/runtime"

/**
 * Configuration for runtime routes.
 */
export interface RuntimeRoutesConfig {
  /**
   * Runtime manager for process lifecycle.
   */
  runtimeManager: IRuntimeManager
  /**
   * Domain suffix for URL generation (default: 'localhost').
   */
  domainSuffix?: string
  /**
   * Workspaces directory for fallback project validation.
   * Required if database is not available.
   */
  workspacesDir?: string
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
  const { runtimeManager, domainSuffix = 'localhost', workspacesDir } = config
  const router = new Hono()

  /**
   * Validate project exists before runtime operations.
   * Falls back to workspace directory check if database not available.
   */
  async function validateProject(projectId: string): Promise<any | null> {
    // Try database validation first
    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, workspaceId: true },
      })
      if (project) return project
    } catch (err) {
      console.warn('[Runtime] Database lookup failed, falling back to filesystem:', err)
    }

    // Fall back to filesystem check
    if (workspacesDir) {
      const projectDir = join(workspacesDir, projectId)
      if (existsSync(projectDir)) {
        return { id: projectId }
      }
    }

    return null
  }

  /**
   * POST /projects/:projectId/runtime/start - Spawn project runtime
   *
   * Starts a Vite dev server for the project. Idempotent - if already running,
   * returns existing runtime info.
   */
  router.post("/projects/:projectId/runtime/start", async (c) => {
    const projectId = c.req.param("projectId")

    try {
      // Validate project
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      // Start or get existing runtime
      const runtime = await runtimeManager.start(projectId)

      return c.json({
        success: true,
        projectId,
        status: runtime.status,
        url: runtime.url,
        port: runtime.port,
      })
    } catch (error: any) {
      console.error("[Runtime] Start error:", error)
      return c.json(
        { error: { code: "start_failed", message: error.message || "Failed to start runtime" } },
        500
      )
    }
  })

  /**
   * POST /projects/:projectId/runtime/stop - Stop project runtime
   *
   * Stops the Vite dev server. Idempotent - if not running, succeeds.
   */
  router.post("/projects/:projectId/runtime/stop", async (c) => {
    const projectId = c.req.param("projectId")

    try {
      await runtimeManager.stop(projectId)

      return c.json({
        success: true,
        projectId,
        status: "stopped",
      })
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
   * Returns current status of the runtime (running, stopped, starting, error).
   * Response format matches Kubernetes environment for frontend compatibility.
   */
  router.get("/projects/:projectId/runtime/status", async (c) => {
    const projectId = c.req.param("projectId")

    try {
      const runtime = runtimeManager.status(projectId)

      if (!runtime) {
        return c.json({
          projectId,
          status: "stopped",
          ready: false,
          url: null,
          port: null,
          message: "Runtime not started",
        })
      }

      const isReady = runtime.status === 'running'
      return c.json({
        projectId,
        status: runtime.status,
        ready: isReady,
        url: runtime.url,
        port: runtime.port,
        message: isReady ? "Runtime ready" : `Runtime is ${runtime.status}`,
      })
    } catch (error: any) {
      console.error("[Runtime] Status error:", error)
      return c.json(
        { error: { code: "status_failed", message: error.message || "Failed to get status" } },
        500
      )
    }
  })

  /**
   * GET /projects/:projectId/sandbox/url - Get sandbox URL
   *
   * Returns URL with sandbox attributes for secure iframe embedding.
   * Response format matches Kubernetes environment for frontend compatibility.
   */
  router.get("/projects/:projectId/sandbox/url", async (c) => {
    const projectId = c.req.param("projectId")

    try {
      // Validate project exists in database
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      // Get or start runtime
      let runtime = runtimeManager.status(projectId)
      if (!runtime || runtime.status === 'stopped') {
        runtime = await runtimeManager.start(projectId)
      }

      const isReady = runtime.status === 'running'

      // Build agent URL as an agent-proxy path through the API server so it works
      // with tunnels (ngrok) and cross-origin setups. The API server proxies
      // requests to the actual agent runtime (localhost:agentPort).
      const host = c.req.header('host') || 'localhost:8002'
      const protocol = c.req.header('x-forwarded-proto') || 'http'
      const agentUrl = `${protocol}://${host}/api/projects/${projectId}/agent-proxy`

      // Return format matching Kubernetes response for frontend compatibility
      return c.json({
        url: runtime.url,
        directUrl: runtime.url,
        agentUrl,
        sandbox: SANDBOX_ATTRIBUTES,
        status: runtime.status,
        ready: isReady,
        message: isReady ? "Runtime ready" : `Runtime is ${runtime.status}`,
      })
    } catch (error: any) {
      console.error("[Runtime] Sandbox URL error:", error)
      return c.json(
        { 
          url: null,
          status: 'error',
          ready: false,
          error: { code: "sandbox_failed", message: error.message || "Failed to get sandbox URL" } 
        },
        500
      )
    }
  })

  /**
   * POST /projects/:projectId/runtime/restart - Restart project runtime
   *
   * Stops and starts the runtime. Useful after config changes.
   */
  router.post("/projects/:projectId/runtime/restart", async (c) => {
    const projectId = c.req.param("projectId")

    try {
      // Validate project
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      // Stop first (ignore if not running)
      await runtimeManager.stop(projectId)

      // Start fresh
      const runtime = await runtimeManager.start(projectId)

      return c.json({
        success: true,
        projectId,
        status: runtime.status,
        url: runtime.url,
        port: runtime.port,
      })
    } catch (error: any) {
      console.error("[Runtime] Restart error:", error)
      return c.json(
        { error: { code: "restart_failed", message: error.message || "Failed to restart runtime" } },
        500
      )
    }
  })

  return router
}

export default runtimeRoutes
