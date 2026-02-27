/**
 * Publish API Routes
 *
 * Endpoints for publishing projects to subdomain.shogo.one URLs.
 * Platform lives at shogo.ai, published apps at shogo.one for isolation.
 * 
 * Architecture:
 *   1. Provision database on shared CloudNativePG cluster (if not exists)
 *   2. Trigger build in project-runtime pod
 *   3. Download built dist/ files from pod
 *   4. Upload to S3 bucket
 *   5. Invalidate CloudFront cache
 *   6. Serve via CloudFront CDN at {subdomain}.shogo.one
 *
 * Future: Deploy published Node server as a lightweight Knative Service
 * that connects to the provisioned database for API routes.
 */

import { Hono } from "hono"
import { resolve } from "path"
import { S3Client, PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3"
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront"
import { prisma } from "../lib/prisma"
import { getProjectPodUrl } from "../lib/knative-project-manager"
import * as checkpointService from "../services/checkpoint.service"
import * as databaseService from "../services/database.service"

// Workspaces directory for checkpoint creation
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || resolve(__dirname, '../../../../workspaces')

// S3 and CloudFront configuration
const PUBLISH_BUCKET = process.env.PUBLISH_BUCKET || "shogo-published-apps-staging"
const PUBLISH_CLOUDFRONT_ID = process.env.PUBLISH_CLOUDFRONT_ID || ""
const PUBLISH_DOMAIN = process.env.PUBLISH_DOMAIN || "shogo.one"
const AWS_REGION = process.env.S3_REGION || process.env.AWS_REGION || "us-east-1"

// Initialize AWS clients
const s3Client = new S3Client({ region: AWS_REGION })
const cloudfrontClient = PUBLISH_CLOUDFRONT_ID ? new CloudFrontClient({ region: AWS_REGION }) : null

// Check if we're in Kubernetes (S3 publishing mode) or local dev
function isKubernetes(): boolean {
  return !!(process.env.KUBERNETES_SERVICE_HOST || process.env.PROJECT_NAMESPACE)
}

// Reserved subdomains that cannot be used
const RESERVED_SUBDOMAINS = new Set([
  "api", "www", "studio", "app", "admin", "mail", "email", "ftp", "ssh",
  "test", "dev", "staging", "prod", "production", "cdn", "static", "assets",
  "media", "images", "files", "download", "downloads", "upload", "uploads",
  "status", "health", "docs", "blog", "support", "help", "auth", "login",
  "logout", "signup", "signin", "register", "account", "dashboard", "console",
  "panel", "portal",
])

// Subdomain validation rules
const SUBDOMAIN_MIN_LENGTH = 3
const SUBDOMAIN_MAX_LENGTH = 63
const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/**
 * Validate subdomain format and availability
 */
function validateSubdomain(subdomain: string): { valid: boolean; reason?: string } {
  if (subdomain.length < SUBDOMAIN_MIN_LENGTH) {
    return { valid: false, reason: `Subdomain must be at least ${SUBDOMAIN_MIN_LENGTH} characters` }
  }
  if (subdomain.length > SUBDOMAIN_MAX_LENGTH) {
    return { valid: false, reason: `Subdomain cannot exceed ${SUBDOMAIN_MAX_LENGTH} characters` }
  }
  if (!SUBDOMAIN_PATTERN.test(subdomain)) {
    return {
      valid: false,
      reason: "Subdomain must start and end with alphanumeric, contain only lowercase letters, numbers, and hyphens",
    }
  }
  if (subdomain.includes("--")) {
    return { valid: false, reason: "Subdomain cannot contain consecutive hyphens" }
  }
  if (RESERVED_SUBDOMAINS.has(subdomain)) {
    return { valid: false, reason: "This subdomain is reserved" }
  }
  return { valid: true }
}

/**
 * Get the MIME type for a file based on extension
 */
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const mimeTypes: Record<string, string> = {
    'html': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'mjs': 'application/javascript',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'webp': 'image/webp',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'eot': 'application/vnd.ms-fontobject',
    'txt': 'text/plain',
    'xml': 'application/xml',
    'map': 'application/json',
  }
  return mimeTypes[ext || ''] || 'application/octet-stream'
}

/**
 * Trigger a build in the project-runtime pod
 */
async function triggerBuild(projectId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const podUrl = await getProjectPodUrl(projectId)
    console.log(`[Publish] Triggering build for project ${projectId} at ${podUrl}`)
    
    const response = await fetch(`${podUrl}/preview/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      return { success: false, error: `Build failed: ${response.status} - ${errorText}` }
    }
    
    const result = await response.json()
    console.log(`[Publish] Build complete:`, result)
    return { success: true }
  } catch (err: any) {
    console.error(`[Publish] Build error:`, err)
    return { success: false, error: err.message || 'Build failed' }
  }
}

/**
 * Download dist/ files from the project-runtime pod
 */
async function downloadDistFiles(projectId: string): Promise<Map<string, Buffer>> {
  const podUrl = await getProjectPodUrl(projectId)
  const files = new Map<string, Buffer>()
  
  // Get the file list from the pod
  console.log(`[Publish] Downloading dist files from ${podUrl}`)
  
  // The project-runtime should expose an endpoint to list/download dist files
  // For now, we'll use a simple API that returns all files
  const response = await fetch(`${podUrl}/api/dist-files`)
  
  if (!response.ok) {
    throw new Error(`Failed to get dist files: ${response.status}`)
  }
  
  const distFiles = await response.json() as Array<{ path: string; content: string }>
  
  for (const file of distFiles) {
    // Content is base64 encoded
    const buffer = Buffer.from(file.content, 'base64')
    files.set(file.path, buffer)
  }
  
  console.log(`[Publish] Downloaded ${files.size} files`)
  return files
}

/**
 * Upload files to S3 bucket under the subdomain prefix
 */
async function uploadToS3(subdomain: string, files: Map<string, Buffer>): Promise<void> {
  console.log(`[Publish] Uploading ${files.size} files to S3 bucket ${PUBLISH_BUCKET}/${subdomain}/`)
  
  for (const [filePath, content] of files) {
    const key = `${subdomain}/${filePath}`
    const contentType = getMimeType(filePath)
    
    await s3Client.send(new PutObjectCommand({
      Bucket: PUBLISH_BUCKET,
      Key: key,
      Body: content,
      ContentType: contentType,
      CacheControl: filePath === 'index.html' ? 'max-age=0, must-revalidate' : 'max-age=31536000, immutable',
    }))
  }
  
  console.log(`[Publish] Upload complete`)
}

/**
 * Delete all files for a subdomain from S3
 */
async function deleteFromS3(subdomain: string): Promise<void> {
  console.log(`[Publish] Deleting files for subdomain ${subdomain} from S3`)
  
  // List all objects with the subdomain prefix
  const listResponse = await s3Client.send(new ListObjectsV2Command({
    Bucket: PUBLISH_BUCKET,
    Prefix: `${subdomain}/`,
  }))
  
  if (!listResponse.Contents || listResponse.Contents.length === 0) {
    console.log(`[Publish] No files found for subdomain ${subdomain}`)
    return
  }
  
  // Delete all objects
  const objects = listResponse.Contents.map(obj => ({ Key: obj.Key! }))
  await s3Client.send(new DeleteObjectsCommand({
    Bucket: PUBLISH_BUCKET,
    Delete: { Objects: objects },
  }))
  
  console.log(`[Publish] Deleted ${objects.length} files`)
}

/**
 * Invalidate CloudFront cache for a subdomain
 */
async function invalidateCloudFront(subdomain: string): Promise<void> {
  if (!cloudfrontClient || !PUBLISH_CLOUDFRONT_ID) {
    console.log(`[Publish] CloudFront not configured, skipping invalidation`)
    return
  }
  
  console.log(`[Publish] Invalidating CloudFront cache for ${subdomain}`)
  
  await cloudfrontClient.send(new CreateInvalidationCommand({
    DistributionId: PUBLISH_CLOUDFRONT_ID,
    InvalidationBatch: {
      CallerReference: `${subdomain}-${Date.now()}`,
      Paths: {
        Quantity: 1,
        Items: [`/${subdomain}/*`],
      },
    },
  }))
  
  console.log(`[Publish] CloudFront invalidation created`)
}

/**
 * Create publish routes
 */
export function publishRoutes() {
  const router = new Hono()

  /**
   * GET /subdomains/:subdomain/check - Check subdomain availability
   */
  router.get("/subdomains/:subdomain/check", async (c) => {
    try {
      const subdomain = c.req.param("subdomain").toLowerCase()

      const validation = validateSubdomain(subdomain)
      if (!validation.valid) {
        return c.json({ available: false, reason: validation.reason }, 200)
      }

      // Check if already taken by another project
      const existingProject = await prisma.project.findUnique({
        where: { publishedSubdomain: subdomain },
        select: { id: true },
      })

      if (existingProject) {
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

      const validation = validateSubdomain(subdomain)
      if (!validation.valid) {
        return c.json({ error: { code: "invalid_subdomain", message: validation.reason } }, 400)
      }

      // Get the project
      const project = await prisma.project.findUnique({
        where: { id: projectId },
      })
      if (!project) {
        return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      }

      // Check if subdomain is available (unless it's the same project's subdomain)
      if (project.publishedSubdomain !== subdomain) {
        const existingProject = await prisma.project.findUnique({
          where: { publishedSubdomain: subdomain },
          select: { id: true },
        })

        if (existingProject) {
          return c.json({ error: { code: "subdomain_taken", message: "Subdomain is already in use" } }, 409)
        }
      }

      // If project already has a different subdomain, clean up old S3 files
      if (project.publishedSubdomain && project.publishedSubdomain !== subdomain) {
        try {
          await deleteFromS3(project.publishedSubdomain)
        } catch (err) {
          console.warn("[Publish] Failed to delete old S3 files:", err)
        }
      }

      // Ensure project database exists on shared CloudNativePG cluster
      // This is idempotent - if the database already exists, it just updates credentials
      let publishedDbUrl: string | null = null
      try {
        const dbInfo = await databaseService.provisionDatabase(projectId)
        publishedDbUrl = dbInfo.connectionUrl
        console.log(`[Publish] Database provisioned: ${dbInfo.databaseName}`)
      } catch (err: any) {
        console.warn("[Publish] Database provisioning failed (non-blocking):", err.message)
        // Continue - the project might not need a database (static site)
      }

      // In Kubernetes: Build, download, and upload to S3
      if (isKubernetes()) {
        // Step 1: Trigger build
        const buildResult = await triggerBuild(projectId)
        if (!buildResult.success) {
          return c.json({
            error: { code: "build_failed", message: buildResult.error || "Build failed" }
          }, 500)
        }

        // Step 2: Download dist files
        let files: Map<string, Buffer>
        try {
          files = await downloadDistFiles(projectId)
        } catch (err: any) {
          console.error("[Publish] Failed to download dist files:", err)
          return c.json({
            error: { code: "download_failed", message: err.message || "Failed to download build files" }
          }, 500)
        }

        if (files.size === 0) {
          return c.json({
            error: { code: "no_files", message: "No files to publish - build may have failed" }
          }, 400)
        }

        // Step 3: Upload to S3
        try {
          await uploadToS3(subdomain, files)
        } catch (err: any) {
          console.error("[Publish] Failed to upload to S3:", err)
          return c.json({
            error: { code: "upload_failed", message: err.message || "Failed to upload to S3" }
          }, 500)
        }

        // Step 4: Invalidate CloudFront cache
        try {
          await invalidateCloudFront(subdomain)
        } catch (err: any) {
          console.warn("[Publish] CloudFront invalidation failed:", err)
          // Don't fail the publish for this - it will eventually expire
        }
      } else {
        // Local development: Just log and update database
        console.log(`[Publish] Local mode - would publish to ${subdomain}.${PUBLISH_DOMAIN}`)
      }

      // Update project with publish info
      const publishedAt = new Date()
      await prisma.project.update({
        where: { id: projectId },
        data: {
          publishedSubdomain: subdomain,
          publishedAt,
          accessLevel: accessLevel as any,
          siteTitle,
          siteDescription,
        },
      })

      // Auto-checkpoint on publish (fire-and-forget)
      const workspacePath = resolve(WORKSPACES_DIR, projectId)
      checkpointService.createCheckpoint({
        projectId,
        workspacePath,
        message: `Published to ${subdomain}.${PUBLISH_DOMAIN}`,
        name: `Publish: ${subdomain}.${PUBLISH_DOMAIN}`,
        isAutomatic: true,
      }).catch((err) => {
        console.warn('[Publish] Auto-checkpoint failed (non-blocking):', err.message)
      })

      // Auto-capture thumbnail after publish (fire-and-forget, delayed to let CDN propagate)
      setTimeout(() => {
        captureThumbnail(projectId, `https://${subdomain}.${PUBLISH_DOMAIN}`).catch((err) => {
          console.warn('[Publish] Auto-thumbnail failed (non-blocking):', err.message)
        })
      }, 5000)

      return c.json(
        {
          url: `https://${subdomain}.${PUBLISH_DOMAIN}`,
          subdomain,
          publishedAt: publishedAt.getTime(),
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

      const project = await prisma.project.findUnique({
        where: { id: projectId },
      })
      if (!project) {
        return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      }

      if (!project.publishedSubdomain) {
        return c.json({ error: { code: "not_published", message: "Project is not published" } }, 400)
      }

      // Delete files from S3
      if (isKubernetes()) {
        try {
          await deleteFromS3(project.publishedSubdomain)
          await invalidateCloudFront(project.publishedSubdomain)
        } catch (err) {
          console.warn("[Publish] Failed to delete from S3:", err)
        }
      }

      // Note: We intentionally keep the project database on unpublish.
      // The database is shared with the development environment and dropping
      // it would destroy user data. Database cleanup happens on project deletion.

      // Clear publish info from project
      await prisma.project.update({
        where: { id: projectId },
        data: {
          publishedSubdomain: null,
          publishedAt: null,
          accessLevel: "anyone",
          siteTitle: null,
          siteDescription: null,
        },
      })

      return c.json({ success: true }, 200)
    } catch (error: any) {
      console.error("[Publish] Unpublish error:", error)
      return c.json({ error: { code: "unpublish_failed", message: error.message } }, 500)
    }
  })

  /**
   * POST /projects/:projectId/republish - Republish with latest changes
   */
  router.post("/projects/:projectId/republish", async (c) => {
    try {
      const projectId = c.req.param("projectId")

      const project = await prisma.project.findUnique({
        where: { id: projectId },
      })
      if (!project) {
        return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      }

      if (!project.publishedSubdomain) {
        return c.json({ error: { code: "not_published", message: "Project is not published" } }, 400)
      }

      const subdomain = project.publishedSubdomain

      if (isKubernetes()) {
        // Rebuild and republish
        const buildResult = await triggerBuild(projectId)
        if (!buildResult.success) {
          return c.json({
            error: { code: "build_failed", message: buildResult.error || "Build failed" }
          }, 500)
        }

        const files = await downloadDistFiles(projectId)
        if (files.size === 0) {
          return c.json({
            error: { code: "no_files", message: "No files to publish" }
          }, 400)
        }

        await uploadToS3(subdomain, files)
        await invalidateCloudFront(subdomain)
      }

      // Update publishedAt timestamp
      const publishedAt = new Date()
      await prisma.project.update({
        where: { id: projectId },
        data: { publishedAt },
      })

      // Auto-checkpoint on republish (fire-and-forget)
      const workspacePath = resolve(WORKSPACES_DIR, projectId)
      checkpointService.createCheckpoint({
        projectId,
        workspacePath,
        message: `Republished to ${subdomain}.${PUBLISH_DOMAIN}`,
        name: `Republish: ${subdomain}.${PUBLISH_DOMAIN}`,
        isAutomatic: true,
      }).catch((err) => {
        console.warn('[Publish] Auto-checkpoint on republish failed (non-blocking):', err.message)
      })

      return c.json({
        url: `https://${subdomain}.${PUBLISH_DOMAIN}`,
        subdomain,
        publishedAt: publishedAt.getTime(),
      }, 200)
    } catch (error: any) {
      console.error("[Publish] Republish error:", error)
      return c.json({ error: { code: "republish_failed", message: error.message } }, 500)
    }
  })

  /**
   * PATCH /projects/:projectId/publish - Update publish settings
   */
  router.patch("/projects/:projectId/publish", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      const body = await c.req.json<{
        accessLevel?: "anyone" | "authenticated" | "private"
        siteTitle?: string
        siteDescription?: string
      }>()

      const project = await prisma.project.findUnique({
        where: { id: projectId },
      })
      if (!project) {
        return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      }

      if (!project.publishedSubdomain) {
        return c.json({ error: { code: "not_published", message: "Project is not published" } }, 400)
      }

      // Build update object
      const updates: Record<string, any> = {}
      if (body.accessLevel !== undefined) updates.accessLevel = body.accessLevel
      if (body.siteTitle !== undefined) updates.siteTitle = body.siteTitle
      if (body.siteDescription !== undefined) updates.siteDescription = body.siteDescription

      let updatedProject = project
      if (Object.keys(updates).length > 0) {
        updatedProject = await prisma.project.update({
          where: { id: projectId },
          data: updates,
        })
      }

      return c.json(
        {
          url: `https://${project.publishedSubdomain}.${PUBLISH_DOMAIN}`,
          subdomain: project.publishedSubdomain,
          publishedAt: project.publishedAt?.getTime(),
          accessLevel: updatedProject.accessLevel,
          siteTitle: updatedProject.siteTitle,
          siteDescription: updatedProject.siteDescription,
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

/**
 * Capture a thumbnail by calling the thumbnail capture endpoint internally.
 */
async function captureThumbnail(projectId: string, url: string): Promise<void> {
  try {
    const port = process.env.API_PORT || '8002'
    await fetch(`http://localhost:${port}/api/projects/${projectId}/thumbnail/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
  } catch (err: any) {
    console.warn(`[Thumbnail] Capture failed for ${projectId}:`, err.message)
  }
}

export default publishRoutes
