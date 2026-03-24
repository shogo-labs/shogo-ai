// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Thumbnail API Routes
 *
 * Endpoints for managing project thumbnail images.
 * Storage strategy: tries S3 first, falls back to base64 data URL in the DB
 * (so it works locally without MinIO/Docker).
 */

import { Hono } from 'hono'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../lib/prisma'
import { validateOutboundUrl } from '../lib/url-validation'

async function saveThumbnail(projectId: string, pngBuffer: Buffer): Promise<string> {
  // Try S3 first
  try {
    const { getS3Client, getPresignedReadUrl } = await import('../lib/s3')
    const bucket = process.env.S3_WORKSPACES_BUCKET || 'shogo-workspaces'
    const key = `thumbnails/${projectId}.png`
    const s3 = getS3Client()

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: pngBuffer,
      ContentType: 'image/png',
      CacheControl: 'max-age=3600',
    }))

    const url = await getPresignedReadUrl(key, { bucket, expiresIn: 86400 * 7 })
    return url
  } catch {
    // S3 unavailable — fall back to base64 data URL stored in DB
    const base64 = pngBuffer.toString('base64')
    return `data:image/png;base64,${base64}`
  }
}

async function launchPlaywright(): Promise<any> {
  try {
    // @ts-expect-error — playwright-core is optionally available at runtime
    const pw = await import('playwright-core')
    return pw.chromium
  } catch {}
  try {
    const pw = await import('@playwright/test')
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

  return router
}
