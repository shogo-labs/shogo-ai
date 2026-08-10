// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Thumbnail API Routes
 *
 * Endpoints for managing project thumbnail images.
 *
 * Storage strategy: the thumbnail is an "artifact" in the Cursor
 * `cloud-agent-artifacts` sense — a derived visual asset that can be
 * firewalled independently of the primary data plane. We write it through
 * the dedicated artifact S3 client/bucket so security teams can block the
 * `artifacts.*` host without killing chat or tool calls. When artifact env
 * vars are unset the helpers transparently fall back to the default S3
 * client + `S3_WORKSPACES_BUCKET`, so existing deployments keep working.
 *
 * If S3 isn't reachable at all (local dev with no MinIO, customer with the
 * artifact host explicitly blocked) we fall back to a base64 data URL
 * stored in Postgres. This is the "graceful degradation" promised by
 * docs/my-machines-networking.md's failure-modes table.
 */

import { Hono } from 'hono'
import { createHash } from 'crypto'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../lib/prisma'
import { validateOutboundUrl } from '../lib/url-validation'
import { deriveThumbnailToken, verifyThumbnailToken } from '../lib/runtime-token'

/**
 * Path (relative to the API origin) that serves a project's thumbnail as image
 * bytes. Used by the projects-list response to replace a stored base64 data URI
 * with a short, cacheable URL — a 37 KB data URI per row was half the weight of
 * the whole list.
 */
export function buildThumbnailImagePath(projectId: string): string {
  return `/api/projects/${projectId}/thumbnail.png?t=${deriveThumbnailToken(projectId)}`
}

/**
 * Replace inlined base64 thumbnails in a projects-list payload with URLs that
 * serve the same bytes. Mutates `payload.items` in place and reports whether
 * anything changed. Rows already holding a presigned S3 link are left alone.
 */
export function rewriteInlineThumbnails(payload: any, origin: string): boolean {
  if (!Array.isArray(payload?.items)) return false
  let changed = false
  for (const item of payload.items) {
    if (item?.id && typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.startsWith('data:')) {
      item.thumbnailUrl = `${origin}${buildThumbnailImagePath(item.id)}`
      changed = true
    }
  }
  return changed
}

/** Splits a `data:` URI into its media type and decoded bytes. */
function decodeDataUri(uri: string): { contentType: string; bytes: Buffer } | null {
  const comma = uri.indexOf(',')
  if (comma < 0) return null
  const meta = uri.slice('data:'.length, comma)
  if (!meta.includes('base64')) return null
  const contentType = meta.split(';')[0] || 'image/png'
  return { contentType, bytes: Buffer.from(uri.slice(comma + 1), 'base64') }
}

async function saveThumbnail(projectId: string, pngBuffer: Buffer): Promise<string> {
  try {
    const { getArtifactS3Client, getArtifactBucket, buildArtifactKey, getArtifactPresignedReadUrl } =
      await import('../lib/s3')
    const bucket = getArtifactBucket()
    const key = buildArtifactKey('thumbnails', `${projectId}.png`)
    const s3 = getArtifactS3Client()

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: pngBuffer,
      ContentType: 'image/png',
      CacheControl: 'max-age=3600',
    }))

    const url = await getArtifactPresignedReadUrl(key, { expiresIn: 86400 * 7 })
    return url
  } catch {
    const base64 = pngBuffer.toString('base64')
    return `data:image/png;base64,${base64}`
  }
}

// Test-only seam: when set, launchPlaywright() routes its dynamic
// imports through this function instead of calling `import()` directly.
// Production code never touches this — the override stays null. Used
// by unit tests to reach the @playwright/test fallback (lines 56-60)
// and the playwright_missing 501 branch (line 142), both of which are
// structurally unreachable from a single bun process because mock.module
// caches the factory's first-call result for the un-installed
// playwright-core specifier. Same shape as _resetBatchApi in
// lib/eval-job-manager.ts and _resetUpstreamCredentialCache in
// lib/federated-upstream.ts.
let _playwrightImportOverride: ((spec: string) => Promise<any>) | null = null
export function _setPlaywrightImportOverride(
  fn: ((spec: string) => Promise<any>) | null,
): void {
  _playwrightImportOverride = fn
}

async function launchPlaywright(): Promise<any> {
  const doImport = _playwrightImportOverride
    ?? ((s: string) => import(s as any))
  try {
    // @ts-expect-error — playwright-core is optionally available at runtime
    const pw = await doImport('playwright-core')
    return pw.chromium
  } catch {}
  try {
    const pw = await doImport('@playwright/test')
    return pw.chromium
  } catch {}
  return null
}

export function thumbnailRoutes() {
  const router = new Hono()

  /**
   * Upload a thumbnail image for a project.
   * Accepts raw PNG/JPEG body.
   */
  router.post('/projects/:projectId/thumbnail', async (c) => {
    const projectId = c.req.param('projectId')

    try {
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })
      if (!project) return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404)

      const body = await c.req.arrayBuffer()
      if (!body || body.byteLength === 0) {
        return c.json({ error: { code: 'empty_body', message: 'No image data' } }, 400)
      }

      const thumbnailUrl = await saveThumbnail(projectId, Buffer.from(body))

      await prisma.project.update({
        where: { id: projectId },
        data: { thumbnailUrl },
      })

      return c.json({ ok: true, thumbnailUrl })
    } catch (error: any) {
      console.error('[Thumbnail] Upload error:', error)
      return c.json({ error: { code: 'upload_failed', message: error.message } }, 500)
    }
  })

  /**
   * Capture a thumbnail by screenshotting a project URL.
   *
   * For APP projects: screenshots the published URL.
   * For agent projects: pass { url: agentUrl } in the body.
   */
  router.post('/projects/:projectId/thumbnail/capture', async (c) => {
    const projectId = c.req.param('projectId')

    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, publishedSubdomain: true, type: true } as any,
      })
      if (!project) return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404)

      let targetUrl: string | null = null

      try {
        const body = await c.req.json<{ url?: string }>().catch(() => ({} as { url?: string }))
        if (body.url) {
          const urlError = validateOutboundUrl(body.url)
          if (urlError) {
            return c.json({ error: { code: 'invalid_url', message: urlError } }, 400)
          }
          targetUrl = body.url
        }
      } catch {}

      if (!targetUrl && project.publishedSubdomain) {
        const publishDomain = process.env.PUBLISH_DOMAIN || 'shogo.one'
        targetUrl = `https://${project.publishedSubdomain}.${publishDomain}`
      }

      if (!targetUrl) {
        try {
          const { getPreviewUrl } = await import('../lib/knative-project-manager')
          targetUrl = getPreviewUrl(projectId)
        } catch {
          return c.json({ error: { code: 'no_url', message: 'No preview URL available' } }, 400)
        }
      }

      const chromium = await launchPlaywright()
      if (!chromium) {
        return c.json({ error: { code: 'playwright_missing', message: 'Playwright not available' } }, 501)
      }

      // Extract auth cookies from the incoming request to pass to Playwright
      const cookieHeader = c.req.header('cookie') || ''
      const parsedUrl = new URL(targetUrl)
      const cookies = cookieHeader.split(';').map((c) => c.trim()).filter(Boolean).map((c) => {
        const [name, ...rest] = c.split('=')
        return {
          name: name.trim(),
          value: rest.join('=').trim(),
          domain: parsedUrl.hostname,
          path: '/',
        }
      })

      console.log(`[Thumbnail] Capturing ${targetUrl} for project ${projectId}`)
      const browser = await chromium.launch({ headless: true })
      try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
        if (cookies.length > 0) {
          await context.addCookies(cookies)
        }
        const page = await context.newPage()
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 })
        await page.waitForTimeout(3000)

        const screenshotBuffer = Buffer.from(await page.screenshot({ type: 'png' }))
        const thumbnailUrl = await saveThumbnail(projectId, screenshotBuffer)

        await prisma.project.update({
          where: { id: projectId },
          data: { thumbnailUrl },
        })

        console.log(`[Thumbnail] Saved for project ${projectId} (${thumbnailUrl.startsWith('data:') ? 'base64' : 's3'})`)
        return c.json({ ok: true, thumbnailUrl })
      } finally {
        await browser.close()
      }
    } catch (error: any) {
      console.error('[Thumbnail] Capture error:', error)
      return c.json({ error: { code: 'capture_failed', message: error.message } }, 500)
    }
  })

  /**
   * Get a project's thumbnail URL.
   */
  router.get('/projects/:projectId/thumbnail', async (c) => {
    const projectId = c.req.param('projectId')

    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { thumbnailUrl: true },
      })
      if (!project?.thumbnailUrl) {
        return c.json({ error: { code: 'not_found', message: 'No thumbnail' } }, 404)
      }

      return c.json({ ok: true, thumbnailUrl: project.thumbnailUrl })
    } catch (error: any) {
      return c.json({ error: { code: 'failed', message: error.message } }, 500)
    }
  })

  /**
   * Serve a project's thumbnail as image bytes, gated by the per-project token
   * in `?t=` rather than by session auth — see `deriveThumbnailToken` for why an
   * image request can't present ambient credentials.
   */
  router.get('/projects/:projectId/thumbnail.png', async (c) => {
    const projectId = c.req.param('projectId')

    if (!verifyThumbnailToken(projectId, c.req.query('t'))) {
      return c.json({ error: { code: 'forbidden', message: 'Invalid thumbnail token' } }, 403)
    }

    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { thumbnailUrl: true },
      })
      const stored = project?.thumbnailUrl
      if (!stored) {
        return c.json({ error: { code: 'not_found', message: 'No thumbnail' } }, 404)
      }

      // S3-backed thumbnails are already a presigned URL. Hand the caller
      // straight to the bucket instead of proxying the bytes through the API.
      if (!stored.startsWith('data:')) {
        return c.redirect(stored, 302)
      }

      const decoded = decodeDataUri(stored)
      if (!decoded) {
        return c.json({ error: { code: 'not_found', message: 'No thumbnail' } }, 404)
      }

      // The URL is stable but the image is re-captured over a project's life, so
      // revalidate rather than serving a stale screenshot for an hour. `private`
      // keeps a capability URL out of shared caches.
      const etag = `"${createHash('sha1').update(decoded.bytes).digest('hex')}"`
      if (c.req.header('if-none-match') === etag) {
        return c.body(null, 304, { ETag: etag, 'Cache-Control': 'private, max-age=60' })
      }

      return c.body(decoded.bytes as any, 200, {
        'Content-Type': decoded.contentType,
        'Content-Length': String(decoded.bytes.byteLength),
        'Cache-Control': 'private, max-age=60',
        ETag: etag,
      })
    } catch (error: any) {
      return c.json({ error: { code: 'failed', message: error.message } }, 500)
    }
  })

  return router
}
