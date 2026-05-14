// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

interface PrismaState {
  project: any | null
  findThrow: Error | null
  updateCalls: Array<{ where: any; data: any }>
  updateThrow: Error | null
}

const ps: PrismaState = {
  project: null,
  findThrow: null,
  updateCalls: [],
  updateThrow: null,
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async (_args: any) => {
        if (ps.findThrow) throw ps.findThrow
        return ps.project
      },
      update: async (args: any) => {
        ps.updateCalls.push(args)
        if (ps.updateThrow) throw ps.updateThrow
        return { ...args.data, id: args.where.id }
      },
    },
  },
}))

let validateImpl: (url: string) => string | null = () => null

mock.module('../../lib/url-validation', () => ({
  validateOutboundUrl: (u: string) => validateImpl(u),
}))

interface S3State {
  presignedUrl: string
  sendCalls: Array<any>
  sendThrow: Error | null
}

const s3: S3State = {
  presignedUrl: 'https://artifacts.example.com/thumbnails/p.png?sig=abc',
  sendCalls: [],
  sendThrow: null,
}

mock.module('../../lib/s3', () => ({
  getArtifactS3Client: () => ({
    send: async (cmd: any) => {
      s3.sendCalls.push(cmd)
      if (s3.sendThrow) throw s3.sendThrow
    },
  }),
  getArtifactBucket: () => 'cloud-agent-artifacts',
  buildArtifactKey: (folder: string, name: string) => `${folder}/${name}`,
  getArtifactPresignedReadUrl: async (_key: string, _opts: any) => s3.presignedUrl,
}))

mock.module('@aws-sdk/client-s3', () => ({
  PutObjectCommand: class PutObjectCommand {
    input: any
    constructor(input: any) {
      this.input = input
    }
  },
}))

const { thumbnailRoutes } = await import('../thumbnail')

let logSpy: any
let errorSpy: any

beforeEach(() => {
  ps.project = null
  ps.findThrow = null
  ps.updateCalls = []
  ps.updateThrow = null
  validateImpl = () => null
  s3.presignedUrl = 'https://artifacts.example.com/thumbnails/p.png?sig=abc'
  s3.sendCalls = []
  s3.sendThrow = null
  logSpy = mock(() => {})
  errorSpy = mock(() => {})
  console.log = logSpy as any
  console.error = errorSpy as any
})

afterEach(() => {})

function makeApp() {
  return thumbnailRoutes()
}

describe('POST /projects/:id/thumbnail (upload)', () => {
  it('returns 404 when project does not exist', async () => {
    ps.project = null
    const res = await makeApp().fetch(
      new Request('http://x/projects/p-1/thumbnail', {
        method: 'POST',
        body: new Uint8Array([1, 2, 3]),
      }),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('not_found')
  })

  it('returns 400 when body is empty', async () => {
    ps.project = { id: 'p-1' }
    const res = await makeApp().fetch(
      new Request('http://x/projects/p-1/thumbnail', {
        method: 'POST',
        body: new Uint8Array(0),
      }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('empty_body')
  })

  it('uploads to S3 and persists the presigned URL on the project', async () => {
    ps.project = { id: 'p-1' }
    const res = await makeApp().fetch(
      new Request('http://x/projects/p-1/thumbnail', {
        method: 'POST',
        body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.thumbnailUrl).toBe(s3.presignedUrl)
    expect(s3.sendCalls).toHaveLength(1)
    expect(s3.sendCalls[0].input.Bucket).toBe('cloud-agent-artifacts')
    expect(s3.sendCalls[0].input.Key).toBe('thumbnails/p-1.png')
    expect(s3.sendCalls[0].input.ContentType).toBe('image/png')
    expect(ps.updateCalls).toEqual([
      { where: { id: 'p-1' }, data: { thumbnailUrl: s3.presignedUrl } },
    ])
  })

  it('falls back to a base64 data URL when S3 PUT throws', async () => {
    ps.project = { id: 'p-1' }
    s3.sendThrow = new Error('S3 unreachable')
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const res = await makeApp().fetch(
      new Request('http://x/projects/p-1/thumbnail', {
        method: 'POST',
        body: png,
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.thumbnailUrl).toMatch(/^data:image\/png;base64,/)
    expect(body.thumbnailUrl).toContain(Buffer.from(png).toString('base64'))
    expect(ps.updateCalls).toHaveLength(1)
    expect(ps.updateCalls[0].data.thumbnailUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('returns 500 when prisma.update throws', async () => {
    ps.project = { id: 'p-1' }
    ps.updateThrow = new Error('write conflict')
    const res = await makeApp().fetch(
      new Request('http://x/projects/p-1/thumbnail', {
        method: 'POST',
        body: new Uint8Array([1]),
      }),
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('upload_failed')
    expect(body.error.message).toBe('write conflict')
  })

  it('returns 500 when prisma.findUnique throws', async () => {
    ps.findThrow = new Error('db down')
    const res = await makeApp().fetch(
      new Request('http://x/projects/p-1/thumbnail', {
        method: 'POST',
        body: new Uint8Array([1]),
      }),
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('upload_failed')
  })
})

describe('GET /projects/:id/thumbnail (read)', () => {
  it('returns the stored thumbnailUrl', async () => {
    ps.project = { thumbnailUrl: 'https://cdn/x.png' }
    const res = await makeApp().fetch(new Request('http://x/projects/p-1/thumbnail'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, thumbnailUrl: 'https://cdn/x.png' })
  })

  it('returns 404 when project has no thumbnail', async () => {
    ps.project = { thumbnailUrl: null }
    const res = await makeApp().fetch(new Request('http://x/projects/p-1/thumbnail'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('not_found')
  })

  it('returns 404 when project itself is missing', async () => {
    ps.project = null
    const res = await makeApp().fetch(new Request('http://x/projects/p-1/thumbnail'))
    expect(res.status).toBe(404)
  })

  it('returns 500 when findUnique throws', async () => {
    ps.findThrow = new Error('db down')
    const res = await makeApp().fetch(new Request('http://x/projects/p-1/thumbnail'))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('failed')
  })
})

describe('POST /projects/:id/thumbnail/capture (Playwright)', () => {
  function captureReq(body: any = {}) {
    return new Request('http://x/projects/p-1/thumbnail/capture', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('returns 404 when project is missing', async () => {
    ps.project = null
    const res = await makeApp().fetch(captureReq())
    expect(res.status).toBe(404)
  })

  it('returns 400 when the provided URL fails validateOutboundUrl', async () => {
    ps.project = { id: 'p-1' }
    validateImpl = () => 'private IP not allowed'
    const res = await makeApp().fetch(captureReq({ url: 'http://10.0.0.1/' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('invalid_url')
    expect(body.error.message).toBe('private IP not allowed')
  })

  it('falls back to the publish URL when no URL is in the body (and returns non-2xx when no browser can screenshot it)', async () => {
    ps.project = { id: 'p-1', publishedSubdomain: 'demo', type: 'app' }
    const res = await makeApp().fetch(captureReq())
    // Two acceptable outcomes:
    //  - 501 'playwright_missing' when playwright-core / @playwright/test
    //    aren't installed in the test runtime
    //  - 500 'capture_failed' when playwright IS installed but cannot
    //    actually navigate to https://demo.shogo.one in the sandbox
    // The contract under test is: the route consults publishedSubdomain
    // when body.url is absent, and never returns 2xx without a real
    // screenshot.
    expect([500, 501]).toContain(res.status)
    const body = await res.json()
    expect(['playwright_missing', 'capture_failed']).toContain(body.error.code)
  })

  it('returns 400 (no_url) when no body URL, no publishedSubdomain, and no preview-URL', async () => {
    ps.project = { id: 'p-1', publishedSubdomain: null, type: 'agent' }
    // The dynamic import of knative-project-manager will fail in the test
    // runtime (it pulls in @kubernetes/client-node, not mocked here), and
    // the route catches and returns 400 no_url.
    const res = await makeApp().fetch(captureReq())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('no_url')
  })

  it('returns 500 when capture throws unexpectedly', async () => {
    ps.findThrow = new Error('db meltdown')
    const res = await makeApp().fetch(captureReq())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('capture_failed')
  })
})

describe('routes factory', () => {
  it('returns a fresh Hono router per call', () => {
    const a = makeApp()
    const b = makeApp()
    expect(a).not.toBe(b)
  })
})
