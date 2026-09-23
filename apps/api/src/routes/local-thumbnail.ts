// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { prisma } from '../lib/prisma'
import { deriveThumbnailToken, verifyThumbnailToken } from '../lib/runtime-token'

function decodeDataUri(uri: string): { contentType: string; bytes: Buffer } | null {
  const comma = uri.indexOf(',')
  if (comma < 0 || !uri.startsWith('data:') || !uri.slice(0, comma).includes('base64')) return null
  return {
    contentType: uri.slice('data:'.length, comma).split(';')[0] || 'image/png',
    bytes: Buffer.from(uri.slice(comma + 1), 'base64'),
  }
}

function dataUrl(contentType: string, bytes: ArrayBuffer): string {
  return `data:${contentType || 'image/png'};base64,${Buffer.from(bytes).toString('base64')}`
}

export function localThumbnailRoutes(): Hono {
  const router = new Hono()

  router.post('/projects/:projectId/thumbnail', async (c) => {
    const projectId = c.req.param('projectId')
    const body = await c.req.arrayBuffer()
    if (body.byteLength === 0) {
      return c.json({ error: { code: 'empty_body', message: 'No image data' } }, 400)
    }
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })
    if (!project) return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404)
    const thumbnailUrl = dataUrl(c.req.header('content-type') || 'image/png', body)
    await prisma.project.update({ where: { id: projectId }, data: { thumbnailUrl } })
    return c.json({ ok: true, thumbnailUrl })
  })

  router.get('/projects/:projectId/thumbnail', async (c) => {
    const project = await prisma.project.findUnique({
      where: { id: c.req.param('projectId') },
      select: { thumbnailUrl: true },
    })
    if (!project?.thumbnailUrl) return c.json({ error: { code: 'not_found', message: 'No thumbnail' } }, 404)
    return c.json({ ok: true, thumbnailUrl: project.thumbnailUrl })
  })

  router.get('/projects/:projectId/thumbnail.png', async (c) => {
    const projectId = c.req.param('projectId')
    if (!verifyThumbnailToken(projectId, c.req.query('t'))) {
      return c.json({ error: { code: 'forbidden', message: 'Invalid thumbnail token' } }, 403)
    }
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { thumbnailUrl: true },
    })
    const decoded = project?.thumbnailUrl ? decodeDataUri(project.thumbnailUrl) : null
    if (!decoded) return c.json({ error: { code: 'not_found', message: 'No thumbnail' } }, 404)
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
  })

  // Screenshot capture is optional in desktop builds. If Playwright is
  // installed, capture the supplied URL and use the same data-URL storage.
  router.post('/projects/:projectId/thumbnail/capture', async (c) => {
    const projectId = c.req.param('projectId')
    const body = await c.req.json<{ url?: string }>().catch(() => ({ url: undefined }))
    if (!body.url) return c.json({ error: { code: 'no_url', message: 'A URL is required in local mode' } }, 400)
    try {
      const optionalModule = 'playwright-core'
      const playwright = await import(optionalModule)
      const browser = await playwright.chromium.launch({ headless: true })
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
        await page.goto(body.url, { waitUntil: 'networkidle', timeout: 30_000 })
        const bytes = await page.screenshot({ type: 'png' })
        const thumbnailUrl = dataUrl('image/png', bytes.buffer)
        await prisma.project.update({ where: { id: projectId }, data: { thumbnailUrl } })
        return c.json({ ok: true, thumbnailUrl })
      } finally {
        await browser.close()
      }
    } catch (error: any) {
      return c.json({
        error: { code: 'capture_failed', message: error?.message || 'Playwright is not available' },
      }, 501)
    }
  })

  return router
}

export function buildLocalThumbnailImagePath(projectId: string): string {
  return `/api/projects/${projectId}/thumbnail.png?t=${deriveThumbnailToken(projectId)}`
}
