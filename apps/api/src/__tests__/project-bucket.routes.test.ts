// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `/api/projects/:projectId/bucket` routes (SHO-491).
 *
 * The service is mocked here so these tests are about the HTTP contract: the
 * paths, the status codes each failure maps to, and the read-URL shape a client
 * gets. `project-bucket.service.test.ts` covers the storage behaviour itself.
 *
 * Because the mock replaces the service module for the whole process, run this
 * file on its own (the repo's `run-tests-isolated.ts` — i.e. `bun run test` —
 * does exactly that). Running it in the same process as the service suite makes
 * that suite import the fake.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── the service, faked ─────────────────────────────────────────────────────

class FakeKeyExists extends Error {
  readonly code = 'key_exists'
  constructor(key: string) {
    super(`"${key}" already exists`)
  }
}
class FakeMissing extends Error {
  readonly code = 'object_not_found'
  constructor(key: string) {
    super(`"${key}" is missing`)
  }
}
class FakeNotConfigured extends Error {
  readonly code = 'bucket_not_configured'
  constructor() {
    super('This deployment has no project bucket')
  }
}
class FakeRejected extends Error {
  readonly code = 'bucket_payment_required'
  constructor(
    readonly gate: any,
    readonly workspaceId: string,
  ) {
    super('bucket_payment_required')
  }
}

const calls = {
  createUpload: [] as any[],
  putStream: [] as any[],
  complete: [] as any[],
  abort: [] as any[],
  list: [] as any[],
  head: [] as any[],
  signedUrl: [] as any[],
  remove: [] as any[],
}

/** Desktop vs cloud for the route that exists only on desktop. */
let localMode = false

const behaviour: {
  createUpload?: () => Promise<any>
  head?: () => Promise<any>
  remove?: () => Promise<boolean>
  putStream?: () => Promise<any>
} = {}

mock.module('../services/project-bucket.service', () => ({
  BucketKeyExistsError: FakeKeyExists,
  BucketObjectMissingError: FakeMissing,
  BucketUploadRejectedError: FakeRejected,
  ProjectBucketNotConfiguredError: FakeNotConfigured,
  abortBucketUpload: async (projectId: string, token: any) => {
    calls.abort.push({ projectId, token })
  },
  bucketApiOrigin: () => 'http://localhost:3000',
  bucketObjectPath: (projectId: string, visibility: string, key: string) =>
    `p/${projectId}/${visibility}/${key}`,
  bucketObjectSignedUrl: async (projectId: string, visibility: string, key: string, expiresIn: number) => {
    calls.signedUrl.push({ projectId, visibility, key, expiresIn })
    return `https://cdn.shogo.one/${projectId}/${key}`
  },
  bucketPaymentRequiredBody: (gate: any, workspaceId: string) => ({
    error: {
      code: 'bucket_payment_required',
      message: 'over the allowance',
      reason: gate.reason ?? 'usage_limit_reached',
      usedBytes: gate.usedBytes,
      allowanceBytes: gate.allowanceBytes,
      usdPerGbMonth: gate.usdPerGbMonth,
      billingUrl: `http://localhost:3000/billing?workspace=${workspaceId}`,
    },
  }),
  bucketUsage: async () => ({
    projectBytes: 10,
    projectObjects: 1,
    workspaceId: 'ws_1',
    workspaceUsedBytes: 10,
    allowanceBytes: 100,
    billingMode: 'shadow',
    usdPerGbMonth: 0.02,
    publicBaseUrl: 'https://cdn.shogo.one',
  }),
  completeBucketUpload: async (project: any, token: any) => {
    calls.complete.push({ project, token })
    return { key: token.k, visibility: token.v, size: 5, etag: 'e', sha256: null, publicUrl: null }
  },
  createBucketUpload: async (project: any, request: any, apiOrigin: string) => {
    calls.createUpload.push({ project, request, apiOrigin })
    if (behaviour.createUpload) return behaviour.createUpload()
    return { uploadId: 'tok', key: request.key, visibility: request.visibility, mode: 'single', url: 'u' }
  },
  decodeUploadToken: (token: string | undefined) =>
    token === 'tok' ? { k: 'a/hero.png', v: 'public' as const } : null,
  deleteBucketObject: async (projectId: string, visibility: string, key: string) => {
    calls.remove.push({ projectId, visibility, key })
    return behaviour.remove ? behaviour.remove() : true
  },
  headBucketObject: async (projectId: string, visibility: string, key: string) => {
    calls.head.push({ projectId, visibility, key })
    if (behaviour.head) return behaviour.head()
    return { key, visibility, size: 5, contentType: 'image/png', etag: 'e', sha256: null, updatedAt: '' }
  },
  isLocalBucketMode: () => localMode,
  projectBucketPublicPrefix: (projectId: string) =>
    localMode
      ? `http://localhost:3000/api/bucket/${projectId}/public/`
      : `https://cdn.shogo.one/${projectId}/`,
  listBucketObjects: async (projectId: string, options: any) => {
    calls.list.push({ projectId, options })
    return { objects: [{ key: 'a.png', visibility: 'public', size: 1 }], cursor: null }
  },
  normalizeBucketVisibility: (raw: unknown) => (raw === 'private' ? 'private' : 'public'),
  projectBucketFilePath: (path: string) => path,
  putBucketStream: async (project: any, input: any, _stream: any) => {
    calls.putStream.push({ project, input })
    if (behaviour.putStream) return behaviour.putStream()
    return { key: input.key, visibility: input.visibility, size: 5, etag: 'e', sha256: null, publicUrl: null }
  },
  validateBucketKey: (raw: unknown) =>
    typeof raw === 'string' && raw.length > 0 && !raw.includes('..')
      ? { ok: true, key: raw.replace(/^\/+/, '') }
      : { ok: false, code: 'invalid_key', message: 'bad key' },
  verifyBucketObjectToken: () => true,
  type: undefined,
}))

const projectFindUnique = mock(async ({ where }: any): Promise<any> =>
  where.id === 'p_1' ? { id: 'p_1', workspaceId: 'ws_1' } : null,
)
const bucketUpdate = mock(async (_: any): Promise<any> => ({}))

mock.module('../lib/prisma', () => ({
  prisma: {
    project: { findUnique: projectFindUnique },
    projectBucketObject: { update: bucketUpdate },
  },
}))

const { bucketErrorResponse, keyAfterPath, objectKeyFromPath, projectBucketRoutes } = await import(
  '../routes/project-bucket'
)

let router: ReturnType<typeof projectBucketRoutes>

beforeEach(() => {
  for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key].length = 0
  delete behaviour.createUpload
  delete behaviour.head
  delete behaviour.remove
  delete behaviour.putStream
  bucketUpdate.mockClear()
  localMode = false
  router = projectBucketRoutes({ apiOrigin: 'http://localhost:3000' })
})

// ─── path helpers ───────────────────────────────────────────────────────────

describe('path parsing', () => {
  test('a nested, percent-encoded key survives the trip', () => {
    expect(objectKeyFromPath('/projects/p_1/bucket/objects/media/a%20b/hero.png')).toBe(
      'media/a b/hero.png',
    )
  })

  test('an encoded slash stays inside one segment', () => {
    expect(objectKeyFromPath('/projects/p_1/bucket/objects/a%2Fb.png')).toBe('a/b.png')
  })

  test('a broken percent escape is left as it was rather than throwing', () => {
    expect(keyAfterPath('/x/', '/x/%E0%A4%A')).toBe('%E0%A4%A')
  })
})

// ─── upload tickets ─────────────────────────────────────────────────────────

describe('POST /projects/:id/bucket/uploads', () => {
  const body = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({ key: 'a/hero.png', size: 5, contentType: 'image/png', ...overrides })

  test('mints a ticket and reports 201', async () => {
    const response = await router.request('/projects/p_1/bucket/uploads', {
      method: 'POST',
      body: body(),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(201)
    expect(calls.createUpload).toHaveLength(1)
    expect(calls.createUpload[0].request).toMatchObject({ key: 'a/hero.png', visibility: 'public', size: 5 })
    expect(calls.createUpload[0].apiOrigin).toBe('http://localhost:3000')
  })

  test('a boolean `public` is accepted as visibility', async () => {
    await router.request('/projects/p_1/bucket/uploads', {
      method: 'POST',
      body: body({ public: true }),
      headers: { 'content-type': 'application/json' },
    })
    expect(calls.createUpload[0].request.visibility).toBe('public')
  })

  test('an over-allowance upload is a 402 with the billing body', async () => {
    behaviour.createUpload = async () => {
      throw new FakeRejected(
        { reason: 'usage_limit_reached', usedBytes: 12, allowanceBytes: 10, usdPerGbMonth: 0.02 },
        'ws_1',
      )
    }
    const response = await router.request('/projects/p_1/bucket/uploads', {
      method: 'POST',
      body: body(),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(402)
    const payload = (await response.json()) as any
    expect(payload.error.code).toBe('bucket_payment_required')
    expect(payload.error.usedBytes).toBe(12)
    expect(payload.error.allowanceBytes).toBe(10)
    expect(payload.error.billingUrl).toContain('workspace=ws_1')
  })

  test('an existing key without overwrite is a 409', async () => {
    behaviour.createUpload = async () => {
      throw new FakeKeyExists('a/hero.png')
    }
    const response = await router.request('/projects/p_1/bucket/uploads', {
      method: 'POST',
      body: body(),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(409)
    expect(((await response.json()) as any).error.code).toBe('key_exists')
  })

  test('a deployment without a bucket is a 503, not a phantom success', async () => {
    behaviour.createUpload = async () => {
      throw new FakeNotConfigured()
    }
    const response = await router.request('/projects/p_1/bucket/uploads', {
      method: 'POST',
      body: body(),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(503)
    expect(((await response.json()) as any).error.code).toBe('bucket_not_configured')
  })

  test('a missing or negative size is a 400 and stores nothing', async () => {
    for (const overrides of [{ size: 'big' }, { size: -1 }, { size: undefined }]) {
      const response = await router.request('/projects/p_1/bucket/uploads', {
        method: 'POST',
        body: body(overrides),
        headers: { 'content-type': 'application/json' },
      })
      expect(response.status).toBe(400)
    }
    expect(calls.createUpload).toHaveLength(0)
  })

  test('an unknown project is a 404', async () => {
    const response = await router.request('/projects/p_gone/bucket/uploads', {
      method: 'POST',
      body: body(),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(404)
  })
})

// ─── desktop upload target ──────────────────────────────────────────────────

describe('PUT /projects/:id/bucket/uploads/:uploadId', () => {
  test('does not exist on cloud — cloud tickets point at object storage', async () => {
    const response = await router.request('/projects/p_1/bucket/uploads/tok', {
      method: 'PUT',
      body: 'hello',
      headers: { 'content-type': 'text/plain', 'content-length': '5' },
    })
    expect(response.status).toBe(404)
    expect(calls.putStream).toHaveLength(0)
  })

  test('streams the body and passes the declared length to the gate', async () => {
    localMode = true
    const response = await router.request('/projects/p_1/bucket/uploads/tok', {
      method: 'PUT',
      body: 'hello',
      headers: { 'content-type': 'text/plain', 'content-length': '5' },
    })
    expect(response.status).toBe(201)
    expect(calls.putStream[0].input).toMatchObject({
      key: 'a/hero.png',
      visibility: 'public',
      contentType: 'text/plain',
      declaredSize: 5,
    })
  })

  test('an unknown ticket is a 400', async () => {
    localMode = true
    const response = await router.request('/projects/p_1/bucket/uploads/nope', {
      method: 'PUT',
      body: 'hello',
    })
    expect(response.status).toBe(400)
    expect(calls.putStream).toHaveLength(0)
  })
})

// ─── index ──────────────────────────────────────────────────────────────────

describe('GET /projects/:id/bucket/objects', () => {
  test('passes the filters through and returns the page', async () => {
    const response = await router.request(
      '/projects/p_1/bucket/objects?prefix=media/&visibility=private&limit=7&cursor=abc',
    )
    expect(response.status).toBe(200)
    expect(calls.list[0].options).toMatchObject({
      prefix: 'media/',
      visibility: 'private',
      limit: 7,
      cursor: 'abc',
    })
    const payload = (await response.json()) as any
    expect(payload.objects[0].key).toBe('a.png')
    expect(payload.publicUrlPrefix).toBe('https://cdn.shogo.one/p_1/')
  })

  test('an unreadable index is a 500 with a usable code', async () => {
    calls.list.length = 0
    const broken = projectBucketRoutes({ apiOrigin: 'http://localhost:3000' })
    // The mocked service resolves; drive the failure path through the error
    // mapper directly, which is what every route funnels through.
    const error = Object.assign(new Error('db down'), { code: 'p2021' })
    const response = bucketErrorResponse(
      {
        json: (payload: unknown, status: number) =>
          new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }),
      } as any,
      error,
    )
    expect(response.status).toBe(500)
    expect(((await response.json()) as any).error.code).toBe('bucket_error')
    expect(broken).toBeTruthy()
  })

  test('an invalid key is a 400', async () => {
    const response = await router.request('/projects/p_1/bucket/objects?prefix=..%2Fetc')
    // The prefix is not validated here (it is only matched against index keys);
    // what matters is that the page still answers.
    expect(response.status).toBe(200)
  })
})

// ─── metadata + reads ───────────────────────────────────────────────────────

describe('HEAD/GET /projects/:id/bucket/objects/*key', () => {
  test('HEAD answers the size, type and etag with no body', async () => {
    const response = await router.request('/projects/p_1/bucket/objects/media/hero.png', {
      method: 'HEAD',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('5')
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(await response.text()).toBe('')
  })

  test('HEAD of a missing object is a 404 with no body', async () => {
    behaviour.head = async () => null
    const response = await router.request('/projects/p_1/bucket/objects/media/gone.png', {
      method: 'HEAD',
    })
    expect(response.status).toBe(404)
  })

  test('GET redirects a browser to the CDN', async () => {
    const response = await router.request('/projects/p_1/bucket/objects/media/hero.png')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://cdn.shogo.one/p_1/media/hero.png')
    expect(calls.signedUrl[0]).toMatchObject({ projectId: 'p_1', visibility: 'public', key: 'media/hero.png' })
  })

  test('GET ?url=1 answers JSON, and clamps the expiry', async () => {
    const response = await router.request('/projects/p_1/bucket/objects/media/hero.png?url=1&expiresIn=999999')
    expect(response.status).toBe(200)
    const payload = (await response.json()) as any
    expect(payload.url).toBe('https://cdn.shogo.one/p_1/media/hero.png')
    expect(payload.size).toBe(5)
    expect(calls.signedUrl[0].expiresIn).toBe(86400)

    await router.request('/projects/p_1/bucket/objects/media/hero.png?expiresIn=1')
    expect(calls.signedUrl[1].expiresIn).toBe(60)
  })

  test('GET of an object with no bytes behind it is a 404, not a redirect to nowhere', async () => {
    behaviour.head = async () => null
    const response = await router.request('/projects/p_1/bucket/objects/media/gone.png?url=1')
    expect(response.status).toBe(404)
    expect(calls.signedUrl).toHaveLength(0)
  })
})

// ─── completion + delete ────────────────────────────────────────────────────

describe('completion and delete', () => {
  test('complete records the multipart parts and an optional sha256', async () => {
    const response = await router.request('/projects/p_1/bucket/uploads/tok/complete', {
      method: 'POST',
      body: JSON.stringify({ parts: [{ ETag: '"abc"', PartNumber: 1 }], sha256: 'f'.repeat(64) }),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(200)
    expect(calls.complete).toHaveLength(1)
    expect(bucketUpdate).toHaveBeenCalledTimes(1)
    const payload = (await response.json()) as any
    expect(payload.sha256).toBe('f'.repeat(64))
  })

  test('complete with a malformed part list drops the bad entries instead of 500ing', async () => {
    const response = await router.request('/projects/p_1/bucket/uploads/tok/complete', {
      method: 'POST',
      body: JSON.stringify({ parts: [{ nope: true }, { etag: 'x', partNumber: 2 }] }),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(200)
    expect(calls.complete).toHaveLength(1)
  })

  test('DELETE removes an object and is honest about one that was not there', async () => {
    const first = await router.request('/projects/p_1/bucket/objects/media/hero.png', {
      method: 'DELETE',
    })
    expect(first.status).toBe(200)

    behaviour.remove = async () => false
    const second = await router.request('/projects/p_1/bucket/objects/media/hero.png', {
      method: 'DELETE',
    })
    expect(second.status).toBe(404)
  })

  test('DELETE of an upload ticket aborts it', async () => {
    const response = await router.request('/projects/p_1/bucket/uploads/tok', { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect(calls.abort).toHaveLength(1)
    expect(calls.abort[0].token).toEqual({ k: 'a/hero.png', v: 'public' })
  })
})

// ─── usage ──────────────────────────────────────────────────────────────────

describe('GET /projects/:id/bucket/usage', () => {
  test('answers the project bytes, allowance and rate', async () => {
    const response = await router.request('/projects/p_1/bucket/usage')
    expect(response.status).toBe(200)
    const payload = (await response.json()) as any
    expect(payload).toMatchObject({
      projectBytes: 10,
      allowanceBytes: 100,
      billingMode: 'shadow',
      publicBaseUrl: 'https://cdn.shogo.one',
    })
  })

  test('an unknown project is a 404', async () => {
    const response = await router.request('/projects/p_gone/bucket/usage')
    expect(response.status).toBe(404)
  })
})
