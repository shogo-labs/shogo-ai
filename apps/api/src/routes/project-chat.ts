/**
 * Project Chat Proxy Routes
 *
 * Proxies chat requests to per-project runtime pods.
 *
 * In Kubernetes: Routes to Knative Services via internal DNS
 * In Local Dev: Routes to local RuntimeManager-spawned processes
 *
 * Endpoints:
 * - POST /projects/:projectId/chat - Proxy chat to project pod
 */

import { Hono } from "hono"
import { getProjectPodUrl } from "../lib/knative-project-manager"
import { prisma } from "../lib/prisma"
import type { IRuntimeManager } from "../lib/runtime"

// Environment detection
const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

// =============================================================================
// Configuration
// =============================================================================

export interface ProjectChatRoutesConfig {
  /**
   * Local runtime manager (used in non-K8s environments).
   */
  runtimeManager?: IRuntimeManager
}

// =============================================================================
// Routes
// =============================================================================

export function projectChatRoutes(config: ProjectChatRoutesConfig) {
  const { runtimeManager } = config
  const router = new Hono()

  /**
   * Validate project exists before operations.
   */
  async function validateProject(projectId: string) {
    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, workspaceId: true },
      })
      return project || null
    } catch (err) {
      console.error("[ProjectChat] Project lookup error:", err)
      return null
    }
  }

  /**
   * Wait for runtime to become ready (status === 'running').
   * Used when runtime is already starting from another request.
   */
  async function waitForRuntimeReady(projectId: string, timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now()
    const checkInterval = 500

    while (Date.now() - startTime < timeoutMs) {
      const runtime = runtimeManager?.status(projectId)
      if (runtime?.status === 'running') {
        return
      }
      if (runtime?.status === 'error' || runtime?.status === 'stopped') {
        throw new Error(`Runtime for ${projectId} failed to start: ${runtime.status}`)
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval))
    }
    throw new Error(`Timeout waiting for runtime ${projectId} to become ready`)
  }

  /**
   * Get the URL for a project's runtime agent server.
   * Handles both Kubernetes (Knative) and local development.
   *
   * Properly handles concurrent requests by:
   * - Starting the runtime if stopped/error/missing
   * - Waiting if runtime is already starting from another request
   */
  async function getProjectUrl(projectId: string): Promise<string> {
    if (isKubernetes()) {
      // In Kubernetes: Use Knative project manager
      return await getProjectPodUrl(projectId)
    } else if (runtimeManager) {
      // Local development: Use RuntimeManager
      let runtime = runtimeManager.status(projectId)

      if (!runtime || runtime.status === "stopped" || runtime.status === "error") {
        // No runtime or failed - start it
        console.log(`[ProjectChat] Starting runtime for ${projectId}...`)
        runtime = await runtimeManager.start(projectId)
      } else if (runtime.status === "starting") {
        // Runtime is being started by another request - wait for it
        console.log(`[ProjectChat] Runtime for ${projectId} is starting, waiting...`)
        await waitForRuntimeReady(projectId)
        runtime = runtimeManager.status(projectId)!
      }
      // else: runtime.status === "running" - proceed immediately

      // Use agentPort if available, otherwise calculate from Vite port
      // Agent runs on port = Vite port + 1000 (e.g., 5200 -> 6200)
      const agentPort = runtime.agentPort || (runtime.port + 1000)
      return `http://localhost:${agentPort}`
    } else {
      throw new Error("No runtime manager available for local development")
    }
  }

  /**
   * POST /projects/:projectId/chat - Proxy chat to project pod
   *
   * Forwards the chat request to the project's runtime pod and streams
   * the response back to the client.
   *
   * Includes retry logic for transient errors (connection refused, etc.)
   * during cold starts when the pod may not be fully ready yet.
   */
  router.post("/projects/:projectId/chat", async (c) => {
    const projectId = c.req.param("projectId")
    console.log(`[ProjectChat] Received chat request for project: ${projectId}`)

    try {
      // Validate project exists
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      // Get project pod URL
      let podUrl: string
      try {
        podUrl = await getProjectUrl(projectId)
      } catch (err: any) {
        console.error(`[ProjectChat] Failed to get project URL:`, err)
        return c.json(
          { error: { code: "pod_unavailable", message: "Project runtime unavailable" } },
          503
        )
      }

      console.log(`[ProjectChat] Proxying to: ${podUrl}/agent/chat`)

      // Get the request body
      const body = await c.req.text()

      // Forward headers
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }

      // Copy relevant headers from original request
      const authHeader = c.req.header("Authorization")
      if (authHeader) headers["Authorization"] = authHeader

      const sessionHeader = c.req.header("X-Session-Id")
      if (sessionHeader) headers["X-Session-Id"] = sessionHeader

      // Retry configuration for transient errors during cold starts
      // Uses constant 500ms delay with max 50 retries (up to 25 seconds total)
      const MAX_RETRIES = 50
      const RETRY_DELAY_MS = 500
      let lastError: Error | null = null

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          // Make request to project pod
          const response = await fetch(`${podUrl}/agent/chat`, {
            method: "POST",
            headers,
            body,
          })

          // Check for errors
          if (!response.ok) {
            const errorText = await response.text()
            console.error(`[ProjectChat] Pod returned error: ${response.status} ${errorText}`)

            // Don't retry on client errors (4xx)
            if (response.status >= 400 && response.status < 500) {
              return c.json(
                { error: { code: "pod_error", message: `Pod error: ${response.status}` } },
                response.status as any
              )
            }

            // Retry on 5xx errors (server temporarily unavailable)
            if (attempt < MAX_RETRIES) {
              console.log(`[ProjectChat] Retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt}/${MAX_RETRIES})...`)
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
              continue
            }

            return c.json(
              { error: { code: "pod_error", message: `Pod error: ${response.status}` } },
              response.status as any
            )
          }

          // Stream the response back
          // Copy response headers
          const responseHeaders = new Headers()
          response.headers.forEach((value, key) => {
            // Don't copy certain headers
            if (!["content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) {
              responseHeaders.set(key, value)
            }
          })

          // Add CORS headers
          responseHeaders.set("Access-Control-Allow-Origin", "*")
          responseHeaders.set("Access-Control-Allow-Methods", "POST, OPTIONS")
          responseHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id")

          // Return the streaming response
          return new Response(response.body, {
            status: response.status,
            headers: responseHeaders,
          })
        } catch (fetchError: any) {
          lastError = fetchError

          // Retry on connection errors (ECONNREFUSED, ECONNRESET, etc.)
          const isTransientError =
            fetchError.code === 'ECONNREFUSED' ||
            fetchError.code === 'ECONNRESET' ||
            fetchError.code === 'ETIMEDOUT' ||
            fetchError.cause?.code === 'ECONNREFUSED' ||
            fetchError.cause?.code === 'ECONNRESET' ||
            fetchError.cause?.code === 'ETIMEDOUT' ||
            fetchError.message?.includes('connection refused') ||
            fetchError.message?.includes('ECONNREFUSED')

          if (isTransientError && attempt < MAX_RETRIES) {
            console.log(`[ProjectChat] Connection error, retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt}/${MAX_RETRIES}):`, fetchError.message || fetchError.code)
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
            continue
          }

          // Non-transient error or max retries reached
          throw fetchError
        }
      }

      // Should not reach here, but handle just in case
      console.error("[ProjectChat] Max retries exceeded:", lastError)
      return c.json(
        { error: { code: "proxy_error", message: lastError?.message || "Max retries exceeded" } },
        503
      )
    } catch (error: any) {
      console.error("[ProjectChat] Proxy error:", error)
      return c.json(
        { error: { code: "proxy_error", message: error.message || "Proxy failed" } },
        500
      )
    }
  })

  /**
   * GET /projects/:projectId/chat/status - Check project runtime status
   */
  router.get("/projects/:projectId/chat/status", async (c) => {
    const projectId = c.req.param("projectId")

    try {
      // Validate project exists
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      if (isKubernetes()) {
        // In Kubernetes: Check Knative Service status
        const { getKnativeProjectManager } = await import("../lib/knative-project-manager")
        const manager = getKnativeProjectManager()
        const status = await manager.getStatus(projectId)

        return c.json({
          mode: "kubernetes",
          exists: status.exists,
          ready: status.ready,
          url: status.url,
          replicas: status.replicas,
        })
      } else if (runtimeManager) {
        // Local development: Check RuntimeManager
        const runtime = runtimeManager.status(projectId)

        return c.json({
          mode: "local",
          exists: !!runtime,
          ready: runtime?.status === "running",
          url: runtime?.url || null,
          status: runtime?.status || "stopped",
        })
      } else {
        return c.json({
          mode: "none",
          exists: false,
          ready: false,
          url: null,
          message: "No runtime manager configured",
        })
      }
    } catch (error: any) {
      console.error("[ProjectChat] Status error:", error)
      return c.json(
        { error: { code: "status_error", message: error.message } },
        500
      )
    }
  })

  /**
   * POST /projects/:projectId/chat/wake - Wake up a scaled-to-zero pod
   */
  router.post("/projects/:projectId/chat/wake", async (c) => {
    const projectId = c.req.param("projectId")

    try {
      // Validate project exists
      const project = await validateProject(projectId)
      if (!project) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      // Get or create the project URL (this will create pod if needed)
      const url = await getProjectUrl(projectId)

      // In Kubernetes, wait for pod to be ready
      if (isKubernetes()) {
        const { getKnativeProjectManager } = await import("../lib/knative-project-manager")
        const manager = getKnativeProjectManager()
        await manager.waitForReady(projectId, 60000)
      }

      return c.json({
        success: true,
        url,
        message: "Project runtime is ready",
      })
    } catch (error: any) {
      console.error("[ProjectChat] Wake error:", error)
      return c.json(
        { error: { code: "wake_error", message: error.message } },
        500
      )
    }
  })

  return router
}

export default projectChatRoutes
