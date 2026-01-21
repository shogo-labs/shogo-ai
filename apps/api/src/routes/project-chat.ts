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
import type { IRuntimeManager } from "@shogo/state-api/runtime"

// Environment detection
const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

// =============================================================================
// Configuration
// =============================================================================

export interface ProjectChatRoutesConfig {
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
   * Local runtime manager (used in non-K8s environments).
   */
  runtimeManager?: IRuntimeManager
}

// =============================================================================
// Routes
// =============================================================================

export function projectChatRoutes(config: ProjectChatRoutesConfig) {
  const { studioCore, runtimeManager } = config
  const router = new Hono()

  /**
   * Validate project exists before operations.
   */
  async function validateProject(projectId: string): Promise<any | null> {
    try {
      const project = await studioCore.projectCollection
        .query()
        .where({ id: projectId })
        .first()
      return project || null
    } catch (err) {
      console.error("[ProjectChat] Project lookup error:", err)
      return null
    }
  }

  /**
   * Get the URL for a project's runtime.
   * Handles both Kubernetes (Knative) and local development.
   */
  async function getProjectUrl(projectId: string): Promise<string> {
    if (isKubernetes()) {
      // In Kubernetes: Use Knative project manager
      return await getProjectPodUrl(projectId)
    } else if (runtimeManager) {
      // Local development: Use RuntimeManager
      let runtime = runtimeManager.status(projectId)
      if (!runtime || runtime.status === "stopped" || runtime.status === "error") {
        runtime = await runtimeManager.start(projectId)
      }
      // Local runtime runs agent on port 8080, not Vite port
      // For now, assume same port - can be configured later
      return runtime.url.replace(/:\d+$/, ":8080")
    } else {
      throw new Error("No runtime manager available for local development")
    }
  }

  /**
   * POST /projects/:projectId/chat - Proxy chat to project pod
   *
   * Forwards the chat request to the project's runtime pod and streams
   * the response back to the client.
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
