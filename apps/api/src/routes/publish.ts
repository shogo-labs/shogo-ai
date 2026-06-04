// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Publish API Routes
 *
 * Endpoints for publishing projects to subdomain.shogo.one URLs.
 * Platform lives at shogo.ai, published apps at shogo.one for isolation.
 * 
 * Architecture:
 *   1. Trigger build in dev runtime pod
 *   2. Download built dist/ files from pod
 *   3. Upload to S3 bucket (persistent storage)
 *   4. Create nginx Knative Service that syncs from S3 via init container
 *   5. Create DomainMapping: {subdomain}.shogo.one -> published-{projectId}
 *   6. Traffic: *.shogo.one DNS -> Kourier ALB -> Knative Service -> nginx
 */

import { Hono } from "hono"
import { S3Client, PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3"
import { prisma } from "../lib/prisma"
import { deriveProjectRuntimeToken } from "../lib/project-runtime-token"

// S3 configuration. `PUBLISH_BUCKET` must be set explicitly in every K8s
// overlay (k8s/overlays/{staging,production-*}/api-service.yaml) — the
// fallback below is a deliberately wrong-looking local-dev value so a
// missing overlay value can't silently route prod uploads to the staging
// bucket. That happened on 2026-05-26: prod api ksvc had no
// PUBLISH_BUCKET, the old default `shogo-published-apps-staging` won,
// and every prod publish wrote to the staging bucket while the
// Cloudflare Worker for *.shogo.one was reading from
// `shogo-published-apps-production` — every published app served
// `ObjectNotFound`. uploadToS3() now also asserts at call time.
const PUBLISH_BUCKET = process.env.PUBLISH_BUCKET || "shogo-published-apps-LOCAL-DEV"
const PUBLISH_DOMAIN = process.env.PUBLISH_DOMAIN || "shogo.one"
const AWS_REGION = process.env.S3_REGION || process.env.AWS_REGION || "us-east-1"

// Per-step timeouts for outbound calls into the runtime pod. Without these,
// a frozen pod (e.g. node memory-pressure stalls or scale-to-zero races)
// hangs the publish HTTP request indefinitely — which is exactly what
// happened to project b11c65dd on 2026-05-20: the runtime went silent for
// 4 minutes, Knative reaped the ksvc mid-flight, and the publish API never
// returned a structured error to Studio. 60s covers a healthy bun-rebuild
// of a typical app; anything longer is almost certainly a stuck pod.
const PUBLISH_BUILD_TIMEOUT_MS = Number(process.env.PUBLISH_BUILD_TIMEOUT_MS) || 60_000
const PUBLISH_DOWNLOAD_TIMEOUT_MS = Number(process.env.PUBLISH_DOWNLOAD_TIMEOUT_MS) || 60_000

// In-flight lock TTL on the project's Knative Service annotation. The
// warm-pool GC honors this annotation and skips deletion while a publish
// is mid-flight; the TTL means a forgotten/crashed lock self-heals.
const PUBLISH_IN_FLIGHT_TTL_MS = 10 * 60 * 1000

// Initialize AWS clients
const s3Client = new S3Client({
  region: AWS_REGION,
  ...(process.env.S3_ENDPOINT && {
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
  }),
})

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
 * Update the project's publish status. Best-effort: never throws — a DB
 * blip should not abort the publish itself, since the source of truth
 * for "is the published service alive" lives in Knative, not Postgres.
 */
async function setPublishStatus(
  projectId: string,
  status: 'idle' | 'building' | 'uploading' | 'configuring' | 'live' | 'failed',
  errorCode: string | null = null,
): Promise<void> {
  try {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        publishStatus: status as any,
        publishError: errorCode,
        publishStatusAt: new Date(),
      },
    })
  } catch (err: any) {
    console.warn(`[Publish] setPublishStatus(${projectId}, ${status}) failed:`, err.message)
  }
}

/**
 * Acquire / release a publish-in-flight lock on the project's Knative
 * Service via a `shogo.io/publish-in-flight` annotation that carries an
 * absolute unix-ms expiry. The warm-pool GC reads this annotation and
 * defers deletion while a publish is mid-flight, mirroring the existing
 * `shogo.io/active=true` deferral. The TTL ensures a forgotten lock
 * self-heals on the next GC pass.
 */
async function acquirePublishLock(projectId: string): Promise<void> {
  if (!isKubernetes()) return
  try {
    const { mergePatchKnativeService } = await import("../lib/knative-project-manager")
    const namespace = process.env.PROJECT_NAMESPACE || 'shogo-staging-workspaces'
    const serviceName = `project-${projectId}`
    const expiry = String(Date.now() + PUBLISH_IN_FLIGHT_TTL_MS)
    await mergePatchKnativeService(namespace, serviceName, {
      metadata: { annotations: { 'shogo.io/publish-in-flight': expiry } },
    })
  } catch (err: any) {
    // Lock failures are non-fatal: a missing ksvc still means publish
    // proceeds (downstream calls will fail cleanly with their own
    // structured errors), and we'd rather not block publish on a
    // transient k8s API hiccup.
    console.warn(`[Publish] acquirePublishLock(${projectId}) failed:`, err.message)
  }
}

async function releasePublishLock(projectId: string): Promise<void> {
  if (!isKubernetes()) return
  try {
    const { mergePatchKnativeService } = await import("../lib/knative-project-manager")
    const namespace = process.env.PROJECT_NAMESPACE || 'shogo-staging-workspaces'
    const serviceName = `project-${projectId}`
    // null on a merge-patch annotation deletes the key.
    await mergePatchKnativeService(namespace, serviceName, {
      metadata: { annotations: { 'shogo.io/publish-in-flight': null } },
    })
  } catch (err: any) {
    console.warn(`[Publish] releasePublishLock(${projectId}) failed:`, err.message)
  }
}

/**
 * Trigger a build in the runtime pod
 */
async function triggerBuild(projectId: string): Promise<{ success: boolean; error?: string; code?: string }> {
  try {
    const { getProjectPodUrl } = await import("../lib/knative-project-manager")
    const podUrl = await getProjectPodUrl(projectId)
    console.log(`[Publish] Triggering build for project ${projectId} at ${podUrl}`)

    const response = await fetch(`${podUrl}/preview/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(PUBLISH_BUILD_TIMEOUT_MS),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return { success: false, code: 'build_failed', error: `Build failed: ${response.status} - ${errorText}` }
    }

    const result = await response.json()
    console.log(`[Publish] Build complete:`, result)
    return { success: true }
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    if (isTimeout) {
      console.error(`[Publish] Build timed out after ${PUBLISH_BUILD_TIMEOUT_MS}ms for ${projectId}`)
      return {
        success: false,
        code: 'build_timeout',
        error: `Build timed out after ${PUBLISH_BUILD_TIMEOUT_MS / 1000}s — the runtime pod is unresponsive`,
      }
    }
    console.error(`[Publish] Build error:`, err)
    return { success: false, code: 'build_failed', error: err.message || 'Build failed' }
  }
}

/**
 * Download dist/ files from the runtime pod
 */
async function downloadDistFiles(projectId: string): Promise<Map<string, Buffer>> {
  const { getProjectPodUrl } = await import("../lib/knative-project-manager")
  const podUrl = await getProjectPodUrl(projectId)
  const files = new Map<string, Buffer>()

  console.log(`[Publish] Downloading dist files from ${podUrl}`)

  // Endpoint lives under the runtime-owned `/agent/*` namespace (auth-gated
  // via `x-runtime-token`). The previous `/api/dist-files` placement was
  // shadowed by the runtime's `app.all('/api/*')` user-app proxy, so every
  // publish before this fix either got a bare 404 (proxy's no-port branch)
  // or the user app's SPA fallback HTML (which then failed JSON parsing).
  const response = await fetch(`${podUrl}/agent/dist-files`, {
    headers: { 'x-runtime-token': await deriveProjectRuntimeToken(projectId) },
    signal: AbortSignal.timeout(PUBLISH_DOWNLOAD_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`Failed to get dist files: ${response.status}`)
  }

  const distFiles = await response.json() as Array<{ path: string; content: string }>

  for (const file of distFiles) {
    const buffer = Buffer.from(file.content, 'base64')
    files.set(file.path, buffer)
  }

  console.log(`[Publish] Downloaded ${files.size} files`)
  return files
}

/**
 * Force the runtime pod to flush its git sync so the published source is
 * committed + pushed into the durable repo before we tag HEAD. Best-effort
 * — a pod in legacy `s3` mode (or with git sync inactive) returns
 * `flushed:false` and we fall back to whatever HEAD the durable repo
 * already holds. Never throws; the publish must still proceed.
 */
async function flushGitSync(
  projectId: string,
  opts: { tag?: string; tagMessage?: string } = {},
): Promise<{ sha: string | null; tag: string | null } | null> {
  try {
    const { getProjectPodUrl } = await import("../lib/knative-project-manager")
    const podUrl = await getProjectPodUrl(projectId)
    const response = await fetch(`${podUrl}/agent/git-flush`, {
      method: 'POST',
      headers: {
        'x-runtime-token': await deriveProjectRuntimeToken(projectId),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tag: opts.tag, tagMessage: opts.tagMessage }),
      signal: AbortSignal.timeout(PUBLISH_BUILD_TIMEOUT_MS),
    })
    if (!response.ok) {
      console.warn(`[Publish] git-flush returned ${response.status} for ${projectId} (continuing)`)
      return null
    }
    const result = await response.json().catch(() => ({})) as { sha?: string; tag?: string }
    console.log(`[Publish] git-flush for ${projectId}:`, result)
    return { sha: result.sha ?? null, tag: result.tag ?? null }
  } catch (err: any) {
    console.warn(`[Publish] git-flush failed for ${projectId} (continuing):`, err?.message ?? err)
    return null
  }
}

/**
 * Mark the published commit with an annotated git tag so the publish is a
 * traceable, immutable point in the project's history (visible in the
 * commit graph as a `tag:` decoration). Records `publishedCommitSha` +
 * `publishedTag` on the Project for the publish panel.
 *
 * Pod-owned model: the pod owns the durable repo, so the tag is created
 * AND persisted by the pod inside `/agent/git-flush` (we pass the tag name
 * and read back the tagged sha). The API just records the result; the tag
 * shows up in the graph on the API's next read-hydrate. Best-effort — a
 * failure here must not fail an otherwise-successful publish.
 */
async function tagPublishedCommit(
  projectId: string,
  subdomain: string,
): Promise<{ sha: string; tag: string } | null> {
  const tag = `publish/${subdomain}/${Math.floor(Date.now() / 1000)}`
  const result = await flushGitSync(projectId, {
    tag,
    tagMessage: `Published ${subdomain}.${PUBLISH_DOMAIN}`,
  })
  if (!result?.sha) {
    console.warn(`[Publish] No HEAD to tag for ${projectId} (pod git sync inactive or repo empty?)`)
    return null
  }
  console.log(`[Publish] Tagged ${projectId} HEAD ${result.sha.slice(0, 8)} as ${tag}`)
  return { sha: result.sha, tag: result.tag ?? tag }
}

/**
 * Upload files to S3 bucket under the subdomain prefix
 */
async function uploadToS3(subdomain: string, files: Map<string, Buffer>): Promise<void> {
  // Hard-fail in K8s mode if the overlay forgot to set PUBLISH_BUCKET
  // — silently uploading to the LOCAL-DEV fallback would land prod
  // content in a non-existent bucket (or worse, the wrong env's bucket
  // if the name happened to collide). See the long comment on
  // PUBLISH_BUCKET above for the 2026-05-26 incident.
  if (isKubernetes() && !process.env.PUBLISH_BUCKET) {
    throw new Error(
      "PUBLISH_BUCKET env var is not set. The api ksvc overlay must set " +
      "this explicitly to the OCI Object Storage bucket the *.shogo.one " +
      "Cloudflare Worker reads from " +
      "(`shogo-published-apps-${environment}` per " +
      "terraform/modules/publish-hosting-oci). Refusing to upload " +
      "without it.",
    )
  }
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
   * GET /projects/:projectId/publish - Current publish state for the panel.
   * Returns null-ish fields when the project has never been published.
   */
  router.get("/projects/:projectId/publish", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
          publishedSubdomain: true,
          publishedAt: true,
          accessLevel: true,
          siteTitle: true,
          siteDescription: true,
          publishStatus: true,
          publishedCommitSha: true,
          publishedTag: true,
        } as any,
      }) as (Record<string, any>) | null
      if (!project) {
        return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      }
      return c.json({
        subdomain: project.publishedSubdomain ?? undefined,
        publishedAt: project.publishedAt ? new Date(project.publishedAt).getTime() : undefined,
        accessLevel: project.accessLevel ?? undefined,
        siteTitle: project.siteTitle ?? undefined,
        siteDescription: project.siteDescription ?? undefined,
        publishStatus: project.publishStatus ?? undefined,
        publishedCommitSha: project.publishedCommitSha ?? undefined,
        publishedTag: project.publishedTag ?? undefined,
      }, 200)
    } catch (error: any) {
      console.error("[Publish] Get publish state error:", error)
      return c.json({ error: { code: "get_state_failed", message: error.message } }, 500)
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

      // In Kubernetes: Build, download, and upload to S3
      if (isKubernetes()) {
        // Hold the publish-in-flight lock for the entire pipeline so the
        // warm-pool GC can't yank the runtime ksvc out from under us.
        await acquirePublishLock(projectId)
        try {
          // Step 1: Trigger build
          await setPublishStatus(projectId, 'building')
          const buildResult = await triggerBuild(projectId)
          if (!buildResult.success) {
            await setPublishStatus(projectId, 'failed', buildResult.code || 'build_failed')
            return c.json({
              error: { code: buildResult.code || "build_failed", message: buildResult.error || "Build failed" }
            }, 500)
          }

          // Step 2: Download dist files
          let files: Map<string, Buffer>
          try {
            files = await downloadDistFiles(projectId)
          } catch (err: any) {
            console.error("[Publish] Failed to download dist files:", err)
            const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
            const code = isTimeout ? 'download_timeout' : 'download_failed'
            await setPublishStatus(projectId, 'failed', code)
            return c.json({
              error: { code, message: err.message || "Failed to download build files" }
            }, 500)
          }

          if (files.size === 0) {
            await setPublishStatus(projectId, 'failed', 'no_files')
            return c.json({
              error: { code: "no_files", message: "No files to publish - build may have failed" }
            }, 400)
          }

          // Step 3: Upload to S3
          await setPublishStatus(projectId, 'uploading')
          try {
            await uploadToS3(subdomain, files)
          } catch (err: any) {
            console.error("[Publish] Failed to upload to S3:", err)
            await setPublishStatus(projectId, 'failed', 'upload_failed')
            return c.json({
              error: { code: "upload_failed", message: err.message || "Failed to upload to S3" }
            }, 500)
          }

          // Step 4: Create/update published Knative service (nginx + S3 init container)
          await setPublishStatus(projectId, 'configuring')
          try {
            const { getKnativeProjectManager } = await import("../lib/knative-project-manager")
            const manager = getKnativeProjectManager()
            const serviceUrl = await manager.createPublishedService(projectId, subdomain)
            console.log(`[Publish] Published service created: ${serviceUrl}`)

            // Step 5: Create DomainMapping {subdomain}.shogo.one -> published-{projectId}
            await manager.createPublishedDomainMapping(subdomain, projectId)
          } catch (err: any) {
            console.warn("[Publish] Published service/DomainMapping creation failed:", err.message)
            await setPublishStatus(projectId, 'failed', 'configure_failed')
            return c.json({
              error: { code: "configure_failed", message: err.message || "Failed to configure published service" }
            }, 500)
          }
        } finally {
          // Always release the lock, even on a thrown error path. The
          // 10-min TTL is a backstop, not the primary release mechanism.
          await releasePublishLock(projectId)
        }
      } else {
        // Local development: Just log and update database
        console.log(`[Publish] Local mode - would publish to ${subdomain}.${PUBLISH_DOMAIN}`)
      }

      // Tag the published commit in the durable git repo. This replaces
      // the old auto-checkpoint-on-publish, which created the checkpoint
      // against WORKSPACES_DIR/<id> on the API pod — a path that doesn't
      // exist in the cloud topology (the workspace lives on the runtime
      // pod / object storage), so it silently no-op'd for every cloud
      // publish. Tagging flushes the pod's git sync, hydrates the durable
      // repo here, and marks HEAD with `publish/<subdomain>/<ts>`.
      const tagged = await tagPublishedCommit(projectId, subdomain)

      // Update project with publish info
      const publishedAt = new Date()
      await prisma.project.update({
        where: { id: projectId },
        data: {
          publishedSubdomain: subdomain,
          publishedAt,
          publishStatus: 'live' as any,
          publishError: null,
          publishStatusAt: publishedAt,
          accessLevel: accessLevel as any,
          siteTitle,
          siteDescription,
          ...(tagged && { publishedCommitSha: tagged.sha, publishedTag: tagged.tag }),
        } as any,
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
      // Best-effort status update — the projectId comes from the route
      // param so we may have crashed before validating it; swallow.
      try {
        await setPublishStatus(c.req.param("projectId"), 'failed', 'publish_failed')
      } catch {}
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

      // Delete DomainMapping, Knative service, and S3 files
      if (isKubernetes()) {
        try {
          const { getKnativeProjectManager } = await import("../lib/knative-project-manager")
          const manager = getKnativeProjectManager()
          await manager.deletePublishedDomainMapping(project.publishedSubdomain)
          await manager.deletePublishedService(projectId)
          console.log(`[Publish] Published service + DomainMapping deleted for ${projectId}`)
        } catch (err: any) {
          console.warn("[Publish] Failed to delete published service:", err.message)
        }

        try {
          await deleteFromS3(project.publishedSubdomain)
        } catch (err) {
          console.warn("[Publish] Failed to delete from S3:", err)
        }
      }

      // Clear publish info from project
      await prisma.project.update({
        where: { id: projectId },
        data: {
          publishedSubdomain: null,
          publishedAt: null,
          publishStatus: 'idle' as any,
          publishError: null,
          publishStatusAt: new Date(),
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
        await acquirePublishLock(projectId)
        try {
          await setPublishStatus(projectId, 'building')
          const buildResult = await triggerBuild(projectId)
          if (!buildResult.success) {
            await setPublishStatus(projectId, 'failed', buildResult.code || 'build_failed')
            return c.json({
              error: { code: buildResult.code || "build_failed", message: buildResult.error || "Build failed" }
            }, 500)
          }

          let files: Map<string, Buffer>
          try {
            files = await downloadDistFiles(projectId)
          } catch (err: any) {
            const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
            const code = isTimeout ? 'download_timeout' : 'download_failed'
            await setPublishStatus(projectId, 'failed', code)
            return c.json({ error: { code, message: err.message || 'Failed to download build files' } }, 500)
          }

          if (files.size === 0) {
            await setPublishStatus(projectId, 'failed', 'no_files')
            return c.json({
              error: { code: "no_files", message: "No files to publish" }
            }, 400)
          }

          await setPublishStatus(projectId, 'uploading')
          await uploadToS3(subdomain, files)

          // Force a new Knative revision so the init container re-syncs from S3
          await setPublishStatus(projectId, 'configuring')
          try {
            const { getKnativeProjectManager } = await import("../lib/knative-project-manager")
            const manager = getKnativeProjectManager()
            await manager.forcePublishedRevision(projectId)
          } catch (err: any) {
            console.warn("[Publish] Failed to force new revision:", err.message)
          }
        } finally {
          await releasePublishLock(projectId)
        }
      }

      // Tag the republished commit in the durable git repo (replaces the
      // old WORKSPACES_DIR-based auto-checkpoint — see the publish handler).
      const tagged = await tagPublishedCommit(projectId, subdomain)

      // Update publishedAt timestamp
      const publishedAt = new Date()
      await prisma.project.update({
        where: { id: projectId },
        data: {
          publishedAt,
          publishStatus: 'live' as any,
          publishError: null,
          publishStatusAt: publishedAt,
          ...(tagged && { publishedCommitSha: tagged.sha, publishedTag: tagged.tag }),
        } as any,
      })

      return c.json({
        url: `https://${subdomain}.${PUBLISH_DOMAIN}`,
        subdomain,
        publishedAt: publishedAt.getTime(),
      }, 200)
    } catch (error: any) {
      console.error("[Publish] Republish error:", error)
      try {
        await setPublishStatus(c.req.param("projectId"), 'failed', 'republish_failed')
      } catch {}
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
