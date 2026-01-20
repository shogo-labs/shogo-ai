/**
 * Project Admin Routes
 *
 * Administrative endpoints for managing project runtime pods.
 * These endpoints are typically used by platform operators and
 * automated systems for monitoring and managing project resources.
 *
 * Endpoints:
 * - GET /admin/projects - List all project pods
 * - GET /admin/projects/:projectId - Get specific project pod status
 * - POST /admin/projects/:projectId/scale - Scale project pod
 * - DELETE /admin/projects/:projectId - Delete project pod
 * - POST /admin/projects/:projectId/warmup - Warm up a project pod
 */

import { Hono } from "hono"
import { 
  getKnativeProjectManager, 
  type ProjectPodInfo,
  type ProjectPodStatus 
} from "../lib/knative-project-manager"

// Environment detection
const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

// =============================================================================
// Types
// =============================================================================

interface AdminResponse<T = unknown> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
  }
}

// =============================================================================
// Routes
// =============================================================================

export function projectAdminRoutes() {
  const router = new Hono()

  /**
   * Check if Kubernetes is available.
   * Returns error response if not in Kubernetes environment.
   */
  function requireKubernetes(c: any): AdminResponse | null {
    if (!isKubernetes()) {
      return {
        success: false,
        error: {
          code: "not_kubernetes",
          message: "Admin endpoints require Kubernetes environment",
        },
      }
    }
    return null
  }

  /**
   * GET /admin/projects - List all project pods
   *
   * Returns a list of all project runtime pods in the namespace.
   */
  router.get("/admin/projects", async (c) => {
    const k8sError = requireKubernetes(c)
    if (k8sError) {
      return c.json(k8sError, 400)
    }

    try {
      const manager = getKnativeProjectManager()
      const projects = await manager.listProjects()

      return c.json({
        success: true,
        data: {
          projects,
          count: projects.length,
        },
      })
    } catch (error: any) {
      console.error("[ProjectAdmin] Failed to list projects:", error)
      return c.json({
        success: false,
        error: {
          code: "list_failed",
          message: error.message || "Failed to list projects",
        },
      }, 500)
    }
  })

  /**
   * GET /admin/projects/:projectId - Get project pod status
   *
   * Returns detailed status for a specific project pod.
   */
  router.get("/admin/projects/:projectId", async (c) => {
    const k8sError = requireKubernetes(c)
    if (k8sError) {
      return c.json(k8sError, 400)
    }

    const projectId = c.req.param("projectId")

    try {
      const manager = getKnativeProjectManager()
      const status = await manager.getStatus(projectId)

      if (!status.exists) {
        return c.json({
          success: false,
          error: {
            code: "not_found",
            message: `Project pod ${projectId} does not exist`,
          },
        }, 404)
      }

      // Perform health check if pod exists
      const healthy = await manager.healthCheck(projectId)

      return c.json({
        success: true,
        data: {
          projectId,
          status,
          healthy,
        },
      })
    } catch (error: any) {
      console.error("[ProjectAdmin] Failed to get project status:", error)
      return c.json({
        success: false,
        error: {
          code: "status_failed",
          message: error.message || "Failed to get project status",
        },
      }, 500)
    }
  })

  /**
   * POST /admin/projects/:projectId/scale - Scale project pod
   *
   * Scales a project pod to a specific number of replicas.
   * Set replicas to 0 to scale to zero (but keep the service).
   * Set replicas to 1 to warm up the pod.
   */
  router.post("/admin/projects/:projectId/scale", async (c) => {
    const k8sError = requireKubernetes(c)
    if (k8sError) {
      return c.json(k8sError, 400)
    }

    const projectId = c.req.param("projectId")

    try {
      const body = await c.req.json()
      const replicas = typeof body.replicas === "number" ? body.replicas : 1

      if (replicas < 0 || replicas > 1) {
        return c.json({
          success: false,
          error: {
            code: "invalid_replicas",
            message: "Replicas must be 0 or 1",
          },
        }, 400)
      }

      const manager = getKnativeProjectManager()

      // Check if project exists
      const status = await manager.getStatus(projectId)
      if (!status.exists) {
        return c.json({
          success: false,
          error: {
            code: "not_found",
            message: `Project pod ${projectId} does not exist`,
          },
        }, 404)
      }

      // Scale the project
      await manager.scaleProject(projectId, replicas)

      return c.json({
        success: true,
        data: {
          projectId,
          replicas,
          message: replicas === 0 ? "Project scaled to zero" : "Project warmed up",
        },
      })
    } catch (error: any) {
      console.error("[ProjectAdmin] Failed to scale project:", error)
      return c.json({
        success: false,
        error: {
          code: "scale_failed",
          message: error.message || "Failed to scale project",
        },
      }, 500)
    }
  })

  /**
   * POST /admin/projects/:projectId/warmup - Warm up a project pod
   *
   * Warms up a project pod by scaling it to 1 and waiting for it to be ready.
   */
  router.post("/admin/projects/:projectId/warmup", async (c) => {
    const k8sError = requireKubernetes(c)
    if (k8sError) {
      return c.json(k8sError, 400)
    }

    const projectId = c.req.param("projectId")

    try {
      const manager = getKnativeProjectManager()

      // Check if project exists
      const status = await manager.getStatus(projectId)
      if (!status.exists) {
        // Create the project
        await manager.createProject(projectId)
      }

      // Scale to 1 and wait for ready
      await manager.scaleProject(projectId, 1)
      await manager.waitForReady(projectId, 120000) // 2 minute timeout

      const newStatus = await manager.getStatus(projectId)

      return c.json({
        success: true,
        data: {
          projectId,
          status: newStatus,
          message: "Project warmed up and ready",
        },
      })
    } catch (error: any) {
      console.error("[ProjectAdmin] Failed to warm up project:", error)
      return c.json({
        success: false,
        error: {
          code: "warmup_failed",
          message: error.message || "Failed to warm up project",
        },
      }, 500)
    }
  })

  /**
   * DELETE /admin/projects/:projectId - Delete project pod
   *
   * Deletes a project's Knative Service and PVC.
   * This is a destructive operation that removes all project data.
   */
  router.delete("/admin/projects/:projectId", async (c) => {
    const k8sError = requireKubernetes(c)
    if (k8sError) {
      return c.json(k8sError, 400)
    }

    const projectId = c.req.param("projectId")

    try {
      const manager = getKnativeProjectManager()
      await manager.deleteProject(projectId)

      return c.json({
        success: true,
        data: {
          projectId,
          message: "Project pod and storage deleted",
        },
      })
    } catch (error: any) {
      console.error("[ProjectAdmin] Failed to delete project:", error)
      return c.json({
        success: false,
        error: {
          code: "delete_failed",
          message: error.message || "Failed to delete project",
        },
      }, 500)
    }
  })

  /**
   * GET /admin/stats - Get aggregate stats
   *
   * Returns aggregate statistics about project pods.
   */
  router.get("/admin/stats", async (c) => {
    const k8sError = requireKubernetes(c)
    if (k8sError) {
      return c.json(k8sError, 400)
    }

    try {
      const manager = getKnativeProjectManager()
      const projects = await manager.listProjects()

      const stats = {
        total: projects.length,
        ready: projects.filter((p) => p.status.ready).length,
        running: projects.filter((p) => p.status.replicas > 0).length,
        scaled_to_zero: projects.filter((p) => p.status.replicas === 0).length,
      }

      return c.json({
        success: true,
        data: stats,
      })
    } catch (error: any) {
      console.error("[ProjectAdmin] Failed to get stats:", error)
      return c.json({
        success: false,
        error: {
          code: "stats_failed",
          message: error.message || "Failed to get stats",
        },
      }, 500)
    }
  })

  return router
}

export default projectAdminRoutes
