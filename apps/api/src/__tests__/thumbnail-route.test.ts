// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/routes/thumbnail.ts — project thumbnail endpoints.
 *
 * Three endpoints + a private saveThumbnail() / launchPlaywright() pair.
 * Strategy:
 *
 *  - Mock prisma (project.findUnique / project.update)
 *  - Mock @aws-sdk/client-s3 (PutObjectCommand is a constructor we can
 *    inspect, no `.send()` is invoked from the test)
 *  - Mock url-validation (validateOutboundUrl) so we control the SSRF
 *    gate without depending on its implementation
 *  - Mock the dynamic imports: `../lib/s3` (for the artifact helpers)
 *    and `../lib/knative-project-manager` (for getPreviewUrl)
 *  - Stub Playwright by mocking the dynamic import `playwright-core`
 *    (and ensuring `@playwright/test` is NOT used by mocking it too)
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

// ─── prisma mock ──────────────────────────────────────────────────────────

const findUnique = mock(async (_: any): Promise<any> => null)
const updateProject = mock(async (_: any): Promise<any> => ({}))
mock.module('../lib/prisma', () => ({
  prisma: {
    project: { findUnique, update: updateProject },
  },
  SubscriptionStatus: {
    active: 'active',
    past_due: 'past_due',
    canceled: 'canceled',
    incomplete: 'incomplete',
    incomplete_expired: 'incomplete_expired',
    trialing: 'trialing',
    unpaid: 'unpaid',
    paused: 'paused',
  },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

// ─── url-validation mock ──────────────────────────────────────────────────

const validateOutboundUrlMock = mock((_: string): string | null => null)
mock.module('../lib/url-validation', () => ({
  validateOutboundUrl: validateOutboundUrlMock,
}))

// ─── s3 dynamic-import mock ───────────────────────────────────────────────

const s3SendMock = mock(async () => ({}))
const getArtifactS3ClientMock = mock(() => ({ send: s3SendMock }))
const getArtifactBucketMock = mock(() => 'artifacts-bucket')
const buildArtifactKeyMock = mock(
  (prefix: string, name: string) => `${prefix}/${name}`,
)
const getArtifactPresignedReadUrlMock = mock(
  async (key: string, _opts?: any) => `https://s3.example/${key}?sig=abc`,
)
let s3ImportShouldThrow = false
mock.module('../lib/s3', () => {
  if (s3ImportShouldThrow) {
    throw new Error('s3 module unavailable')
  }
  return {
    getArtifactS3Client: getArtifactS3ClientMock,
    getArtifactBucket: getArtifactBucketMock,
    buildArtifactKey: buildArtifactKeyMock,
    getArtifactPresignedReadUrl: getArtifactPresignedReadUrlMock,
  }
})

// ─── @aws-sdk/client-s3 mock ──────────────────────────────────────────────

class FakePutObjectCommand {
  input: any
  constructor(input: any) {
    this.input = input
  }
}
mock.module('@aws-sdk/client-s3', () => ({
  PutObjectCommand: FakePutObjectCommand,
}))

// ─── knative-project-manager mock ─────────────────────────────────────────

const getPreviewUrlMock = mock((_: string) => 'http://preview.local')
let knativeImportShouldThrow = false
mock.module('../lib/knative-project-manager', () => {
  if (knativeImportShouldThrow) {
    throw new Error('knative module unavailable')
  }
  return { getPreviewUrl: getPreviewUrlMock }
})

// ─── playwright mocks ─────────────────────────────────────────────────────

const screenshotBytes = new Uint8Array([137, 80, 78, 71]) // PNG header bytes
const pageGoto = mock(async (_url: string, _opts: any) => {})
const pageWait = mock(async (_ms: number) => {})
const pageScreenshot = mock(async (_opts: any) => screenshotBytes)
const ctxAddCookies = mock(async (_: any[]) => {})
const ctxNewPage = mock(async () => ({
  goto: pageGoto,
  waitForTimeout: pageWait,
  screenshot: pageScreenshot,
}))
const browserNewContext = mock(async (_opts: any) => ({
  addCookies: ctxAddCookies,
  newPage: ctxNewPage,
}))
const browserClose = mock(async () => {})
const chromiumLaunch = mock(async (_opts: any) => ({
  newContext: browserNewContext,
  close: browserClose,
}))

let playwrightCoreAvailable = true
let playwrightTestAvailable = false
mock.module('playwright-core', () => {
  if (!playwrightCoreAvailable) throw new Error('module not found')
  return { chromium: { launch: chromiumLaunch } }
})
mock.module('@playwright/test', () => {
  if (!playwrightTestAvailable) throw new Error('module not found')
  return { chromium: { launch: chromiumLaunch } }
})

// ─── load route under test ────────────────────────────────────────────────

const { thumbnailRoutes } = await import('../routes/thumbnail')

// ─── helpers ──────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono()
  app.route('/api', thumbnailRoutes())
  return app
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])

beforeEach(() => {
  findUnique.mockReset()
  updateProject.mockReset()
  validateOutboundUrlMock.mockReset()
  validateOutboundUrlMock.mockImplementation(() => null)

  s3SendMock.mockReset()
  s3SendMock.mockImplementation(async () => ({}))
  getArtifactS3ClientMock.mockReset()
  getArtifactS3ClientMock.mockImplementation(() => ({ send: s3SendMock }))
  getArtifactBucketMock.mockReset()
  getArtifactBucketMock.mockImplementation(() => 'artifacts-bucket')
  buildArtifactKeyMock.mockReset()
  buildArtifactKeyMock.mockImplementation((p: string, n: string) => `${p}/${n}`)
  getArtifactPresignedReadUrlMock.mockReset()
  getArtifactPresignedReadUrlMock.mockImplementation(
    async (k: string) => `https://s3.example/${k}?sig=abc`,
  )
  s3ImportShouldThrow = false

  getPreviewUrlMock.mockReset()
  getPreviewUrlMock.mockImplementation(() => 'http://preview.local')
  knativeImportShouldThrow = false

  pageGoto.mockReset()
  pageGoto.mockImplementation(async () => {})
  pageWait.mockReset()
  pageWait.mockImplementation(async () => {})
  pageScreenshot.mockReset()
  pageScreenshot.mockImplementation(async () => screenshotBytes)
  ctxAddCookies.mockReset()
  ctxAddCookies.mockImplementation(async () => {})
  ctxNewPage.mockReset()
  ctxNewPage.mockImplementation(async () => ({
    goto: pageGoto,
    waitForTimeout: pageWait,
    screenshot: pageScreenshot,
  }))
  browserNewContext.mockReset()
  browserNewContext.mockImplementation(async () => ({
    addCookies: ctxAddCookies,
    newPage: ctxNewPage,
  }))
  browserClose.mockReset()
  browserClose.mockImplementation(async () => {})
  chromiumLaunch.mockReset()
  chromiumLaunch.mockImplementation(async () => ({
    newContext: browserNewContext,
    close: browserClose,
  }))
  playwrightCoreAvailable = true
  playwrightTestAvailable = false

  // Default: project exists.
  findUnique.mockImplementation(async () => ({
    id: 'proj-1',
    publishedSubdomain: null,
    type: 'agent',
  }))
  updateProject.mockImplementation(async () => ({ id: 'proj-1' }))
})

// ─── POST /projects/:id/thumbnail (upload) ────────────────────────────────

describe('POST /projects/:projectId/thumbnail — upload', () => {
  test('404 when project not found', async () => {
    findUnique.mockImplementation(async () => null)
    const res = await makeApp().request('/api/projects/p404/thumbnail', {
      method: 'POST',
      body: PNG,
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('not_found')
  })

  test('400 when body is empty', async () => {
    const res = await makeApp().request('/api/projects/proj-1/thumbnail', {
      method: 'POST',
      body: new Uint8Array(0),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('empty_body')
  })

  test('happy path: writes to S3, stores presigned URL, returns it', async () => {
    const res = await makeApp().request('/api/projects/proj-1/thumbnail', {
      method: 'POST',
      body: PNG,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.thumbnailUrl).toBe('https://s3.example/thumbnails/proj-1.png?sig=abc')

    expect(s3SendMock).toHaveBeenCalledTimes(1)
    const sentCmd = s3SendMock.mock.calls[0][0]
    expect(sentCmd).toBeInstanceOf(FakePutObjectCommand)
    expect(sentCmd.input.Bucket).toBe('artifacts-bucket')
    expect(sentCmd.input.Key).toBe('thumbnails/proj-1.png')
    expect(sentCmd.input.ContentType).toBe('image/png')
    expect(sentCmd.input.CacheControl).toBe('max-age=3600')
    expect(Buffer.isBuffer(sentCmd.input.Body)).toBe(true)

    expect(buildArtifactKeyMock).toHaveBeenCalledWith('thumbnails', 'proj-1.png')
    expect(getArtifactPresignedReadUrlMock).toHaveBeenCalledWith('thumbnails/proj-1.png', {
      expiresIn: 86400 * 7,
    })

    expect(updateProject).toHaveBeenCalledWith({
      where: { id: 'proj-1' },
      data: { thumbnailUrl: 'https://s3.example/thumbnails/proj-1.png?sig=abc' },
    })
  })

  test('falls back to base64 data URL when S3 send throws', async () => {
    s3SendMock.mockImplementation(async () => {
      throw new Error('s3 unreachable')
    })
    const res = await makeApp().request('/api/projects/proj-1/thumbnail', {
      method: 'POST',
      body: PNG,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.thumbnailUrl).toMatch(/^data:image\/png;base64,/)
    expect(updateProject).toHaveBeenCalledWith({
      where: { id: 'proj-1' },
      data: { thumbnailUrl: body.thumbnailUrl },
    })
  })

  test('500 with upload_failed when prisma.update throws', async () => {
    updateProject.mockImplementation(async () => {
      throw new Error('db down')
    })
    const res = await makeApp().request('/api/projects/proj-1/thumbnail', {
      method: 'POST',
      body: PNG,
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('upload_failed')
    expect(body.error.message).toBe('db down')
  })
})

// ─── POST /projects/:id/thumbnail/capture ─────────────────────────────────

describe('POST /projects/:projectId/thumbnail/capture', () => {
  test('404 when project not found', async () => {
    findUnique.mockImplementation(async () => null)
    const res = await makeApp().request('/api/projects/p404/thumbnail/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404)
  })

  test('400 when body.url fails SSRF validation', async () => {
    validateOutboundUrlMock.mockImplementation(() => 'private IP not allowed')
    const res = await makeApp().request('/api/projects/proj-1/thumbnail/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://10.0.0.5/' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('invalid_url')
    expect(body.error.message).toBe('private IP not allowed')
    expect(chromiumLaunch).not.toHaveBeenCalled()
  })

  test('uses body.url when provided and SSRF-clean', async () => {
    const res = await makeApp().request('/api/projects/proj-1/thumbnail/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://app.example.com' }),
    })
    expect(res.status).toBe(200)
    expect(pageGoto).toHaveBeenCalledTimes(1)
    expect(pageGoto.mock.calls[0][0]).toBe('https://app.example.com')
    expect(pageGoto.mock.calls[0][1]).toEqual({ waitUntil: 'networkidle', timeout: 30000 })
  })

  test('falls back to publishedSubdomain when no body.url', async () => {
    const saved = process.env.PUBLISH_DOMAIN
    delete process.env.PUBLISH_DOMAIN
    findUnique.mockImplementation(async () => ({
      id: 'proj-1',
      publishedSubdomain: 'my-app',
      type: 'app',
    }))
    try {
      const res = await makeApp().request('/api/projects/proj-1/thumbnail/capture', {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      expect(pageGoto.mock.calls[0][0]).toBe('https://my-app.shogo.one') // default PUBLISH_DOMAIN
    } finally {
      if (saved !== undefined) process.env.PUBLISH_DOMAIN = saved
    }
  })

  test('respects custom PUBLISH_DOMAIN env when falling back to publishedSubdomain', async () => {
    const saved = process.env.PUBLISH_DOMAIN
    process.env.PUBLISH_DOMAIN = 'shogo.dev'
    findUnique.mockImplementation(async () => ({
      id: 'proj-1',
      publishedSubdomain: 'my-app',
      type: 'app',
    }))
    try {
      const res = await makeApp().request('/api/projects/proj-1/thumbnail/capture', {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      expect(pageGoto.mock.calls[0][0]).toBe('https://my-app.shogo.dev')
    } finally {
      if (saved === undefined) delete process.env.PUBLISH_DOMAIN
      else process.env.PUBLISH_DOMAIN = saved
    }
  })

  test('falls back to knative preview URL when no body.url and no publishedSubdomain', async () => {
    getPreviewUrlMock.mockImplementation(() => 'http://preview-proj-1.local')
    const res = await makeApp().request('/api/projects/proj-1/thumbnail/capture', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(getPreviewUrlMock).toHaveBeenCalledWith('proj-1')
    expect(pageGoto.mock.calls[0][0]).toBe('http://preview-proj-1.local')
  })

  test('forwards request cookies into the Playwright browser context', async () => {
    await makeApp().request('/api/projects/proj-1/thumbnail/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'sid=abc; theme=dark',
      },
      body: JSON.stringify({ url: 'https://app.example.com/page' }),
    })
    expect(ctxAddCookies).toHaveBeenCalledTimes(1)
    const cookies = ctxAddCookies.mock.calls[0][0]
    expect(cookies).toEqual([
      { name: 'sid', value: 'abc', domain: 'app.example.com', path: '/' },
      { name: 'theme', value: 'dark', domain: 'app.example.com', path: '/' },
    ])
  })

  test('preserves cookie values containing "="', async () => {
    await makeApp().request('/api/projects/proj-1/thumbnail/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'token=a=b=c',
      },
      body: JSON.stringify({ url: 'https://app.example.com' }),
    })
    const cookies = ctxAddCookies.mock.calls[0][0]
    expect(cookies).toEqual([
      { name: 'token', value: 'a=b=c', domain: 'app.example.com', path: '/' },
    ])
  })

  test('does NOT call addCookies when no cookie header is sent', async () => {
    await makeApp().request('/api/projects/proj-1/thumbnail/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://app.example.com' }),
    })
    expect(ctxAddCookies).not.toHaveBeenCalled()
  })

  test('always closes the browser, even when screenshot fails', async () => {
    pageScreenshot.mockImplementation(async () => {
      throw new Error('screenshot crashed')
    })
    const res = await makeApp().request('/api/projects/proj-1/thumbnail/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://app.example.com' }),
    })
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('capture_failed')
    expect(browserClose).toHaveBeenCalledTimes(1)
  })

  test('viewport is set to 1280x800', async () => {
    await makeApp().request('/api/projects/proj-1/thumbnail/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://app.example.com' }),
    })
    expect(browserNewContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 800 },
    })
  })

  test('launches chromium with headless: true', async () => {
    await makeApp().request('/api/projects/proj-1/thumbnail/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://app.example.com' }),
    })
    expect(chromiumLaunch).toHaveBeenCalledWith({ headless: true })
  })

  test('uploads the captured PNG and writes thumbnailUrl back to the project', async () => {
    const res = await makeApp().request('/api/projects/proj-1/thumbnail/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://app.example.com' }),
    })
    expect(res.status).toBe(200)
    expect(s3SendMock).toHaveBeenCalledTimes(1)
    const cmd = s3SendMock.mock.calls[0][0]
    expect(cmd.input.Key).toBe('thumbnails/proj-1.png')
    expect(cmd.input.ContentType).toBe('image/png')
    expect(updateProject).toHaveBeenCalledWith({
      where: { id: 'proj-1' },
      data: { thumbnailUrl: 'https://s3.example/thumbnails/proj-1.png?sig=abc' },
    })
  })

  test('survives invalid JSON body (treats it as no body.url)', async () => {
    findUnique.mockImplementation(async () => ({
      id: 'proj-1',
      publishedSubdomain: 'my-app',
      type: 'app',
    }))
    const res = await makeApp().request('/api/projects/proj-1/thumbnail/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json{',
    })
    expect(res.status).toBe(200)
    // fell through to publishedSubdomain
    expect(pageGoto.mock.calls[0][0]).toContain('my-app')
  })

  test('returns 500 capture_failed when page.goto throws', async () => {
    pageGoto.mockImplementation(async () => {
      throw new Error('net::ERR_NAME_NOT_RESOLVED')
    })
    const res = await makeApp().request('/api/projects/proj-1/thumbnail/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://app.example.com' }),
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('capture_failed')
    expect(body.error.message).toContain('ERR_NAME_NOT_RESOLVED')
  })
})

// ─── GET /projects/:id/thumbnail ──────────────────────────────────────────

describe('GET /projects/:projectId/thumbnail', () => {
  test('returns the stored thumbnailUrl when present', async () => {
    findUnique.mockImplementation(async () => ({
      thumbnailUrl: 'https://s3.example/thumbnails/proj-1.png?sig=xyz',
    }))
    const res = await makeApp().request('/api/projects/proj-1/thumbnail')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      thumbnailUrl: 'https://s3.example/thumbnails/proj-1.png?sig=xyz',
    })
  })

  test('404 when the project row exists but thumbnailUrl is null', async () => {
    findUnique.mockImplementation(async () => ({ thumbnailUrl: null }))
    const res = await makeApp().request('/api/projects/proj-1/thumbnail')
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('not_found')
  })

  test('404 when the project row does not exist at all', async () => {
    findUnique.mockImplementation(async () => null)
    const res = await makeApp().request('/api/projects/proj-1/thumbnail')
    expect(res.status).toBe(404)
  })

  test('500 when prisma throws', async () => {
    findUnique.mockImplementation(async () => {
      throw new Error('db down')
    })
    const res = await makeApp().request('/api/projects/proj-1/thumbnail')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('failed')
    expect(body.error.message).toBe('db down')
  })

  test('selects ONLY thumbnailUrl from prisma (least-privilege read)', async () => {
    findUnique.mockImplementation(async () => ({ thumbnailUrl: 'x' }))
    await makeApp().request('/api/projects/proj-1/thumbnail')
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'proj-1' },
      select: { thumbnailUrl: true },
    })
  })
})
