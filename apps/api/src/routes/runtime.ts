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

      // Why `onVMPermanentlyDisabled: 'throw'`: silently spinning up a
      // host RuntimeManager when the user explicitly enabled VM
      // isolation would create the split-brain described in the
      // agent-proxy gate (preview from host, agent from VM). Better
      // to surface 503 and let the client retry.
      let res
      try {
        const { resolveProjectPodUrl } = await import("../lib/resolve-pod-url")
        res = await resolveProjectPodUrl(projectId, {
          logTag: 'Runtime',
          onVMPermanentlyDisabled: 'throw',
          runtimeManager,
        })
      } catch (vmErr: any) {
        if (process.env.SHOGO_VM_ISOLATION === 'true') {
          console.error('[Runtime] VM pool unavailable, not falling back to host runtime to avoid split-brain:', vmErr.message)
          return c.json(
            { error: { code: "vm_pool_unavailable", message: "VM isolation is enabled but the pool is not ready. Retrying..." } },
            503
          )
        }
        throw vmErr
      }

      if (res.mode === 'host') {
        return c.json({
          success: true,
          projectId,
          status: res.runtime.status,
          url: res.runtime.url,
          port: res.runtime.port,
        })
      }
      return c.json({ success: true, projectId, status: 'running', url: res.url, port: 0 })
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
        { error: { code: "stop_failed", message: error.message || `Failed to stop runtime for project ${projectId}` } },
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
    const handlerStart = Date.now()
    const log = (phase: string, extra?: Record<string, unknown>) => {
      console.log(
        `[sandbox/url:${projectId.slice(0, 8)}] ${phase} ` +
          `(+${Date.now() - handlerStart}ms${extra ? ' ' + JSON.stringify(extra) : ''})`,
      )
    }
    log('start')

    try {
      const t0 = Date.now()
      const project = await validateProject(projectId)
      log('validateProject', { ms: Date.now() - t0 })
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      // The agent URL is always the proxy path on this API server —
      // works the same in host and VM modes (the proxy itself routes
      // to the correct backend via `resolveProjectPodUrl`).
      const host = c.req.header('host') || `localhost:${process.env.API_PORT || process.env.PORT || '8002'}`
      const protocol = c.req.header('x-forwarded-proto') || 'http'
      const agentUrl = `${protocol}://${host}/api/projects/${projectId}/agent-proxy`

      // `onVMPermanentlyDisabled: 'throw'` for the same split-brain
      // reason as `/runtime/start` — the preview iframe specifically
      // would mis-render if VM and host disagreed on workspace state.
      let res
      try {
        const t1 = Date.now()
        const { resolveProjectPodUrl } = await import("../lib/resolve-pod-url")
        log('imported resolve-pod-url', { ms: Date.now() - t1 })
        const t2 = Date.now()
        res = await resolveProjectPodUrl(projectId, {
          logTag: 'Runtime',
          onVMPermanentlyDisabled: 'throw',
          runtimeManager,
        })
        log('resolveProjectPodUrl', { ms: Date.now() - t2, mode: res?.mode, status: (res as any)?.runtime?.status })
      } catch (vmErr: any) {
        if (process.env.SHOGO_VM_ISOLATION === 'true') {
          console.error('[Runtime] VM pool unavailable for sandbox/url:', vmErr.message)
          return c.json(
            { url: null, status: 'starting', ready: false, error: { code: "vm_pool_unavailable", message: "VM starting up, please retry..." } },
            503
          )
        }
        throw vmErr
      }

      if (res.mode === 'host') {
        // The UI is actively opening/viewing this project's preview. Refresh
        // its warm-preview recency (and promote it out of the background
        // heartbeat pool if it was warmed there) so the project on screen is
        // never the LRU eviction victim — the root cause of the cold-start /
        // "Spawning agent-runtime for ws:proj:…" on switch-back. This is the
        // UI-only open signal; agent/chat `touch()` deliberately does NOT
        // promote (a heartbeat-driven turn must not crowd the foreground cap).
        runtimeManager.markPreviewActive(projectId)
        const isReady = res.runtime.status === 'running'
        // Canvas iframe loads directly from the agent runtime so
        // `fetch('/api/...')` resolves same-origin (not via this
        // API server's proxy).
        const base = res.runtime.agentPort
          ? `http://localhost:${res.runtime.agentPort}`
          : res.runtime.url
        // Workspace runtimes (`ws:proj:<anchorId>`) host every attached
        // project under a `/p/<projectId>/` base path on the shared agent
        // port. The iframe + readiness poll must target that subpath, not
        // the runtime root (which 404s). Single-project runtimes serve the
        // app at the root, so they keep the bare base.
        const isWorkspaceRuntime = !!res.runtime.id?.startsWith('ws:')
        const canvasBaseUrl = isWorkspaceRuntime ? `${base}/p/${projectId}` : base
        log('done', { ready: isReady, status: res.runtime.status })
        return c.json({
          url: res.runtime.url,
          directUrl: res.runtime.url,
          agentUrl,
          canvasBaseUrl,
          sandbox: SANDBOX_ATTRIBUTES,
          status: res.runtime.status,
          ready: isReady,
          message: isReady ? "Runtime ready" : `Runtime is ${res.runtime.status}`,
        })
      }

      // K8s, VM and metal modes all expose the runtime at `res.url`
      // directly — same URL serves preview, direct, and canvas.
      const modeLabel = res.mode === 'vm' ? 'VM' : res.mode === 'metal' ? 'Metal' : 'K8s'
      log('done', { ready: true, mode: modeLabel })
      return c.json({
        url: res.url,
        directUrl: res.url,
        agentUrl,
        canvasBaseUrl: res.url,
        sandbox: SANDBOX_ATTRIBUTES,
        status: 'running',
        ready: true,
        message: `Runtime ready (${modeLabel})`,
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

      // For host mode `/restart` must explicitly stop the existing
      // runtime before the helper short-circuits on a running one.
      // For VM/K8s modes the "restart" semantic is the warm-pool
      // assignment itself — no host runtime to stop. We can tell
      // which mode we're in by env probes without going through the
      // helper, but it's simpler to call the helper twice and let
      // the host path do the stop only when needed.
      if (process.env.SHOGO_VM_ISOLATION !== 'true' && !process.env.KUBERNETES_SERVICE_HOST) {
        await runtimeManager.stop(projectId)
      }

      let res
      try {
        const { resolveProjectPodUrl } = await import("../lib/resolve-pod-url")
        res = await resolveProjectPodUrl(projectId, {
          logTag: 'Runtime',
          onVMPermanentlyDisabled: 'throw',
          runtimeManager,
        })
      } catch (vmErr: any) {
        if (process.env.SHOGO_VM_ISOLATION === 'true') {
          console.error('[Runtime] VM pool unavailable for restart:', vmErr.message)
          return c.json(
            { error: { code: "vm_pool_unavailable", message: "VM isolation is enabled but the pool is not ready. Retrying..." } },
            503
          )
        }
        throw vmErr
      }

      if (res.mode === 'host') {
        return c.json({
          success: true,
          projectId,
          status: res.runtime.status,
          url: res.runtime.url,
          port: res.runtime.port,
        })
      }
      return c.json({ success: true, projectId, status: 'running', url: res.url, port: 0 })
    } catch (error: any) {
      console.error("[Runtime] Restart error:", error)
      return c.json(
        { error: { code: "restart_failed", message: error.message || `Failed to restart runtime for project ${projectId}` } },
        500
      )
    }
  })

  return router
}

export default runtimeRoutes
