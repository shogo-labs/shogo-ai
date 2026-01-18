/**
 * Publish API Routes
 *
 * Endpoints for publishing projects to subdomain.shogo.ai URLs.
 * Creates Knative DomainMappings for routing.
 */

import { Hono } from "hono"
import * as k8s from "@kubernetes/client-node"
import * as fs from "fs"

// Initialize Kubernetes client lazily (created on first use)
let k8sCustomApi: k8s.CustomObjectsApi | null = null

function getK8sClient(): k8s.CustomObjectsApi {
  if (k8sCustomApi) {
    return k8sCustomApi
  }

  const kc = new k8s.KubeConfig()

  // Try in-cluster config first (when running in Kubernetes)
  const serviceAccountDir = "/var/run/secrets/kubernetes.io/serviceaccount"
  const caPath = `${serviceAccountDir}/ca.crt`
  const tokenPath = `${serviceAccountDir}/token`
  const namespacePath = `${serviceAccountDir}/namespace`

  if (fs.existsSync(caPath) && fs.existsSync(tokenPath)) {
    // Manual in-cluster configuration
    const ca = fs.readFileSync(caPath, "utf8")
    const token = fs.readFileSync(tokenPath, "utf8")
    const host = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`

    kc.loadFromOptions({
      clusters: [
        {
          name: "in-cluster",
          server: host,
          caData: Buffer.from(ca).toString("base64"),
          skipTLSVerify: true, // TODO: Fix proper CA verification
        },
      ],
      users: [
        {
          name: "in-cluster",
          token: token,
        },
      ],
      contexts: [
        {
          name: "in-cluster",
          cluster: "in-cluster",
          user: "in-cluster",
        },
      ],
      currentContext: "in-cluster",
    })
    console.log("[Publish] Loaded Kubernetes config from cluster (manual setup)")
  } else {
    // Fall back to default config for local development
    try {
      kc.loadFromDefault()
      console.log("[Publish] Loaded Kubernetes config from default")
    } catch (defaultError) {
      console.error("[Publish] Failed to load any Kubernetes config:", defaultError)
      throw new Error("Failed to initialize Kubernetes client")
    }
  }

  k8sCustomApi = kc.makeApiClient(k8s.CustomObjectsApi)
  return k8sCustomApi
}

// Reserved subdomains that cannot be used
const RESERVED_SUBDOMAINS = new Set([
  "api",
  "www",
  "studio",
  "app",
  "admin",
  "mail",
  "email",
  "ftp",
  "ssh",
  "test",
  "dev",
  "staging",
  "prod",
  "production",
  "cdn",
  "static",
  "assets",
  "media",
  "images",
  "files",
  "download",
  "downloads",
  "upload",
  "uploads",
  "status",
  "health",
  "docs",
  "blog",
  "support",
  "help",
  "auth",
  "login",
  "logout",
  "signup",
  "signin",
  "register",
  "account",
  "dashboard",
  "console",
  "panel",
  "portal",
])

// Subdomain validation rules
const SUBDOMAIN_MIN_LENGTH = 3
const SUBDOMAIN_MAX_LENGTH = 63
const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/**
 * Validate subdomain format and availability
 */
function validateSubdomain(subdomain: string): { valid: boolean; reason?: string } {
  // Length check
  if (subdomain.length < SUBDOMAIN_MIN_LENGTH) {
    return { valid: false, reason: `Subdomain must be at least ${SUBDOMAIN_MIN_LENGTH} characters` }
  }
  if (subdomain.length > SUBDOMAIN_MAX_LENGTH) {
    return { valid: false, reason: `Subdomain cannot exceed ${SUBDOMAIN_MAX_LENGTH} characters` }
  }

  // Format check (lowercase alphanumeric + hyphens, no leading/trailing hyphens)
  if (!SUBDOMAIN_PATTERN.test(subdomain)) {
    return {
      valid: false,
      reason: "Subdomain must start and end with alphanumeric, contain only lowercase letters, numbers, and hyphens",
    }
  }

  // No consecutive hyphens
  if (subdomain.includes("--")) {
    return { valid: false, reason: "Subdomain cannot contain consecutive hyphens" }
  }

  // Reserved check
  if (RESERVED_SUBDOMAINS.has(subdomain)) {
    return { valid: false, reason: "This subdomain is reserved" }
  }

  return { valid: true }
}

// Knative DomainMapping constants
const KNATIVE_GROUP = "serving.knative.dev"
const KNATIVE_VERSION = "v1beta1"
const DOMAIN_MAPPING_PLURAL = "domainmappings"
const NAMESPACE = "shogo-workspaces"
const BASE_DOMAIN = "shogo.ai"

/**
 * Check if a DomainMapping exists in Knative
 */
async function domainMappingExists(subdomain: string): Promise<boolean> {
  try {
    const client = getK8sClient()
    await client.getNamespacedCustomObject({
      group: KNATIVE_GROUP,
      version: KNATIVE_VERSION,
      namespace: NAMESPACE,
      plural: DOMAIN_MAPPING_PLURAL,
      name: `${subdomain}.${BASE_DOMAIN}`,
    })
    return true
  } catch (error: any) {
    if (error?.response?.statusCode === 404) {
      return false
    }
    // Log unexpected errors but return false to be safe
    console.warn("[Publish] Error checking DomainMapping:", error?.message || error)
    return false
  }
}

/**
 * Create a Knative DomainMapping
 */
async function createDomainMapping(subdomain: string): Promise<void> {
  const client = getK8sClient()
  const domainMappingName = `${subdomain}.${BASE_DOMAIN}`
  const domainMapping = {
    apiVersion: `${KNATIVE_GROUP}/${KNATIVE_VERSION}`,
    kind: "DomainMapping",
    metadata: {
      name: domainMappingName,
      namespace: NAMESPACE,
    },
    spec: {
      ref: {
        name: "studio",
        kind: "Service",
        apiVersion: "serving.knative.dev/v1",
      },
    },
  }

  try {
    // Try to create new mapping
    await client.createNamespacedCustomObject({
      group: KNATIVE_GROUP,
      version: KNATIVE_VERSION,
      namespace: NAMESPACE,
      plural: DOMAIN_MAPPING_PLURAL,
      body: domainMapping,
    })
    console.log(`[Publish] Created DomainMapping: ${domainMappingName}`)
  } catch (error: any) {
    // If it already exists, update it instead
    if (error?.response?.statusCode === 409) {
      await client.replaceNamespacedCustomObject({
        group: KNATIVE_GROUP,
        version: KNATIVE_VERSION,
        namespace: NAMESPACE,
        plural: DOMAIN_MAPPING_PLURAL,
        name: domainMappingName,
        body: domainMapping,
      })
      console.log(`[Publish] Updated existing DomainMapping: ${domainMappingName}`)
    } else {
      throw error
    }
  }
}

/**
 * Delete a Knative DomainMapping
 */
async function deleteDomainMapping(subdomain: string): Promise<void> {
  const domainMappingName = `${subdomain}.${BASE_DOMAIN}`
  try {
    const client = getK8sClient()
    await client.deleteNamespacedCustomObject({
      group: KNATIVE_GROUP,
      version: KNATIVE_VERSION,
      namespace: NAMESPACE,
      plural: DOMAIN_MAPPING_PLURAL,
      name: domainMappingName,
    })
    console.log(`[Publish] Deleted DomainMapping: ${domainMappingName}`)
  } catch (error: any) {
    // Ignore 404 errors (already deleted)
    if (error?.response?.statusCode !== 404) {
      throw error
    }
  }
}

/**
 * Store interface for project operations
 */
export interface PublishRoutesConfig {
  studioCore: {
    projectCollection: {
      query: () => {
        where: (filter: Record<string, any>) => {
          first: () => Promise<any>
          toArray: () => Promise<any[]>
        }
      }
      updateOne: (id: string, data: Record<string, any>) => Promise<void>
    }
  }
}

/**
 * Create publish routes
 */
export function publishRoutes(config: PublishRoutesConfig) {
  const { studioCore } = config
  const router = new Hono()

  /**
   * GET /subdomains/:subdomain/check - Check subdomain availability
   */
  router.get("/subdomains/:subdomain/check", async (c) => {
    try {
      const subdomain = c.req.param("subdomain").toLowerCase()

      // Validate format
      const validation = validateSubdomain(subdomain)
      if (!validation.valid) {
        return c.json({ available: false, reason: validation.reason }, 200)
      }

      // Check if already taken by another project
      const existingProjects = await studioCore.projectCollection
        .query()
        .where({ publishedSubdomain: subdomain })
        .toArray()

      if (existingProjects.length > 0) {
        return c.json({ available: false, reason: "Subdomain is already in use" }, 200)
      }

      // Check if DomainMapping exists in Knative (edge case - orphaned mapping)
      const mappingExists = await domainMappingExists(subdomain)
      if (mappingExists) {
        return c.json({ available: false, reason: "Subdomain is already in use" }, 200)
      }

      return c.json({ available: true }, 200)
    } catch (error: any) {
      console.error("[Publish] Check subdomain error:", error)
      return c.json({ error: { code: "check_failed", message: error.message } }, 500)
    }
  })

  /**
   * POST /projects/:projectId/publish - Publish a project
   */
  router.post("/projects/:projectId/publish", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      const body = await c.req.json<{
        subdomain: string
        accessLevel?: "anyone" | "authenticated" | "private"
        siteTitle?: string
        siteDescription?: string
      }>()

      const { subdomain: rawSubdomain, accessLevel = "anyone", siteTitle, siteDescription } = body
      const subdomain = rawSubdomain.toLowerCase()

      // Validate subdomain
      const validation = validateSubdomain(subdomain)
      if (!validation.valid) {
        return c.json({ error: { code: "invalid_subdomain", message: validation.reason } }, 400)
      }

      // Get the project
      const project = await studioCore.projectCollection.query().where({ id: projectId }).first()
      if (!project) {
        return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      }

      // Check if subdomain is available (unless it's the same project's subdomain)
      if (project.publishedSubdomain !== subdomain) {
        const existingProjects = await studioCore.projectCollection
          .query()
          .where({ publishedSubdomain: subdomain })
          .toArray()

        if (existingProjects.length > 0) {
          return c.json({ error: { code: "subdomain_taken", message: "Subdomain is already in use" } }, 409)
        }
      }

      // If project already has a different subdomain, clean up old DomainMapping
      if (project.publishedSubdomain && project.publishedSubdomain !== subdomain) {
        try {
          await deleteDomainMapping(project.publishedSubdomain)
        } catch (err) {
          console.warn("[Publish] Failed to delete old DomainMapping:", err)
        }
      }

      // Create Knative DomainMapping
      try {
        await createDomainMapping(subdomain)
      } catch (err: any) {
        console.error("[Publish] Failed to create DomainMapping:", err)
        return c.json(
          { error: { code: "infrastructure_error", message: "Failed to create domain mapping" } },
          500
        )
      }

      // Update project with publish info
      const publishedAt = Date.now()
      await studioCore.projectCollection.updateOne(projectId, {
        publishedSubdomain: subdomain,
        publishedAt,
        accessLevel,
        siteTitle,
        siteDescription,
      })

      return c.json(
        {
          url: `https://${subdomain}.shogo.ai`,
          subdomain,
          publishedAt,
          accessLevel,
        },
        200
      )
    } catch (error: any) {
      console.error("[Publish] Publish error:", error)
      return c.json({ error: { code: "publish_failed", message: error.message } }, 500)
    }
  })

  /**
   * POST /projects/:projectId/unpublish - Unpublish a project
   */
  router.post("/projects/:projectId/unpublish", async (c) => {
    try {
      const projectId = c.req.param("projectId")

      // Get the project
      const project = await studioCore.projectCollection.query().where({ id: projectId }).first()
      if (!project) {
        return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      }

      if (!project.publishedSubdomain) {
        return c.json({ error: { code: "not_published", message: "Project is not published" } }, 400)
      }

      // Delete Knative DomainMapping
      try {
        await deleteDomainMapping(project.publishedSubdomain)
      } catch (err) {
        console.warn("[Publish] Failed to delete DomainMapping:", err)
        // Continue anyway to clear local state
      }

      // Clear publish info from project
      await studioCore.projectCollection.updateOne(projectId, {
        publishedSubdomain: undefined,
        publishedAt: undefined,
        accessLevel: undefined,
        siteTitle: undefined,
        siteDescription: undefined,
      })

      return c.json({ success: true }, 200)
    } catch (error: any) {
      console.error("[Publish] Unpublish error:", error)
      return c.json({ error: { code: "unpublish_failed", message: error.message } }, 500)
    }
  })

  /**
   * PATCH /projects/:projectId/publish - Update publish settings without redeploying
   */
  router.patch("/projects/:projectId/publish", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      const body = await c.req.json<{
        accessLevel?: "anyone" | "authenticated" | "private"
        siteTitle?: string
        siteDescription?: string
      }>()

      // Get the project
      const project = await studioCore.projectCollection.query().where({ id: projectId }).first()
      if (!project) {
        return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      }

      if (!project.publishedSubdomain) {
        return c.json({ error: { code: "not_published", message: "Project is not published" } }, 400)
      }

      // Build update object (only include provided fields)
      const updates: Record<string, any> = {}
      if (body.accessLevel !== undefined) updates.accessLevel = body.accessLevel
      if (body.siteTitle !== undefined) updates.siteTitle = body.siteTitle
      if (body.siteDescription !== undefined) updates.siteDescription = body.siteDescription

      if (Object.keys(updates).length > 0) {
        await studioCore.projectCollection.updateOne(projectId, updates)
      }

      return c.json(
        {
          url: `https://${project.publishedSubdomain}.shogo.ai`,
          subdomain: project.publishedSubdomain,
          publishedAt: project.publishedAt,
          accessLevel: updates.accessLevel ?? project.accessLevel,
          siteTitle: updates.siteTitle ?? project.siteTitle,
          siteDescription: updates.siteDescription ?? project.siteDescription,
        },
        200
      )
    } catch (error: any) {
      console.error("[Publish] Update publish settings error:", error)
      return c.json({ error: { code: "update_failed", message: error.message } }, 500)
    }
  })

  return router
}

export default publishRoutes
