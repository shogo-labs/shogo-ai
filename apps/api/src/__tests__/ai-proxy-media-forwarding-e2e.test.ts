// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-74 acceptance criteria, over a real socket.
 *
 * The unit tests next door stub `globalThis.fetch`, which proves the forwarder
 * is *called* but not that a request survives a network hop. This file boots
 * the AI proxy on a real port and points `SHOGO_CLOUD_URL` at a second, real
 * server standing in for Shogo Cloud. Everything below therefore exercises the
 * path a cloud-authed desktop actually takes: inbound socket → Hono → outbound
 * `fetch` (streamed body) → cloud → streamed response → caller.
 *
 * What that buys beyond the mocked tests:
 *   - a multipart body keeps its boundary and its bytes across an actual
 *     chunked upload (the thing that silently breaks when a body is buffered
 *     and re-encoded, or when `content-type` is dropped),
 *   - a job created in cloud is polled in cloud, so it cannot be orphaned,
 *   - cloud's own status codes and error bodies reach the caller instead of
 *     being flattened into a local 500.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.AI_PROXY_SECRET = 'media-forward-e2e-secret'
process.env.SHOGO_API_KEY = 'shogo_sk_cloud'
process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.AI_MODE

let billingCalls: string[] = []
let captureCalls: any[] = []

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    workspaceModelVisibility: { findMany: async () => [] },
    usageWallet: {
      findUnique: async () => null,
      create: async (args: any) => args.data,
      upsert: async (args: any) => args.create,
    },
    usageEvent: { create: async () => ({}) },
  },
}))

mock.module('../services/billing.service', () => ({
  hasBalance: async () => { billingCalls.push('hasBalance'); return true },
  hasAdvancedModelAccess: async () => { billingCalls.push('hasAdvancedModelAccess'); return true },
  checkUsageBalance: async () => { billingCalls.push('checkUsageBalance'); return { ok: true, remainingIncludedUsd: 100 } },
  consumeUsage: async () => { billingCalls.push('consumeUsage'); return { success: true, remainingIncludedUsd: 100 } },
}))

mock.module('../lib/proxy-capture', () => ({
  beginCapture: async (args: any) => { captureCalls.push(args); return null },
  updateTurnFeedback: async () => {},
  markProjectTurnsReverted: async () => {},
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  hasSession: () => false,
  hasActiveSession: () => false,
  accumulateUsage: () => {},
  accumulateImageUsage: () => {},
  setQualitySignals: () => false,
  closeSession: async () => null,
}))

mock.module('../lib/project-user-context', () => ({
  getProjectUser: () => 'user-1',
}))

mock.module('../lib/cloud-key-wipe', () => ({
  wipeCloudKey: async () => {},
  wipeCloudKeyIfRejected: async () => ({ wiped: false }),
}))

interface CapturedRequest {
  method: string
  pathname: string
  search: string
  headers: Headers
  body: Uint8Array
}

const cloudRequests: CapturedRequest[] = []
let cloudHandler: (req: Request, body: Uint8Array) => Response | Promise<Response>

let cloudServer: ReturnType<typeof Bun.serve>
let localServer: ReturnType<typeof Bun.serve>
let localBase = ''
let cloudBase = ''
let TOKEN = ''

beforeAll(async () => {
  cloudServer = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const body = new Uint8Array(await req.arrayBuffer())
      const url = new URL(req.url)
      cloudRequests.push({
        method: req.method,
        pathname: url.pathname,
        search: url.search,
        headers: new Headers(req.headers),
        body,
      })
      return cloudHandler(req, body)
    },
  })
  cloudBase = `http://127.0.0.1:${cloudServer.port}`
  process.env.SHOGO_CLOUD_URL = cloudBase

  const { Hono } = await import('hono')
  const { aiProxyRoutes } = await import('../routes/ai-proxy')
  const { generateProxyToken } = await import('../lib/ai-proxy-token')
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')

  const app = new Hono()
  app.route('/api', aiProxyRoutes())
  localServer = Bun.serve({ port: 0, idleTimeout: 0, fetch: (req) => app.fetch(req) })
  localBase = `http://127.0.0.1:${localServer.port}`
})

afterAll(() => {
  cloudServer?.stop(true)
  localServer?.stop(true)
})

beforeEach(() => {
  cloudRequests.length = 0
  billingCalls = []
  captureCalls = []
  process.env.SHOGO_LOCAL_MODE = 'true'
  process.env.SHOGO_API_KEY = 'shogo_sk_cloud'
  process.env.SHOGO_CLOUD_URL = cloudBase
  delete process.env.AI_MODE
  cloudHandler = () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
})

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...extra }
}

describe('SHO-74: cloud-authed desktop media / 3D / audio over a real socket', () => {
  test('AC1: the 3D catalogue comes from cloud with no local Tripo key', async () => {
    cloudHandler = () => Response.json({
      models: [
        { id: 'tripo-v2', provider: 'tripo', capabilities: ['text-to-3d'] },
        { id: 'higgsfield-3d', provider: 'higgsfield' },
      ],
      operations: [],
    })

    const res = await fetch(`${localBase}/api/ai/v1/3d/models`, { headers: authHeaders() })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-proxy-provider')).toBe('shogo-cloud')
    const body = await res.json() as any
    expect(body.models.map((m: any) => m.provider)).toEqual(['tripo', 'higgsfield'])

    expect(cloudRequests).toHaveLength(1)
    expect(cloudRequests[0].pathname).toBe('/api/ai/v1/3d/models')
    expect(cloudRequests[0].headers.get('authorization')).toBe('Bearer shogo_sk_cloud')
    expect(cloudRequests[0].headers.get('x-shogo-client')).toBe('desktop')
    expect(billingCalls).toEqual([])
    expect(captureCalls).toEqual([])
  })

  test('AC1: a Tripo job is created in cloud and polled in cloud to completion', async () => {
    cloudHandler = (req, body) => {
      if (req.method === 'POST') {
        return Response.json({ id: 'job-42', status: 'queued' }, { status: 202 })
      }
      return Response.json({ id: 'job-42', status: 'completed', output_url: 'https://cdn.example/chair.glb' })
    }

    const created = await fetch(`${localBase}/api/ai/v1/3d/generations`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'tripo-v2', prompt: 'a wooden chair' }),
    })
    expect(created.status).toBe(202)
    expect((await created.json() as any).id).toBe('job-42')

    const polled = await fetch(`${localBase}/api/ai/v1/3d/job-42`, { headers: authHeaders() })
    expect(polled.status).toBe(200)
    expect((await polled.json() as any).status).toBe('completed')

    expect(cloudRequests.map((r) => `${r.method} ${r.pathname}`)).toEqual([
      'POST /api/ai/v1/3d/generations',
      'GET /api/ai/v1/3d/job-42',
    ])
    expect(JSON.parse(new TextDecoder().decode(cloudRequests[0].body))).toEqual({
      model: 'tripo-v2',
      prompt: 'a wooden chair',
    })
    expect(billingCalls).toEqual([])
    expect(captureCalls).toEqual([])
  })

  test('AC1: gpt-image-1 generates through cloud and the JSON body arrives intact', async () => {
    cloudHandler = () => Response.json({ created: 1, data: [{ b64_json: 'aW1n' }] })

    const payload = { model: 'gpt-image-1', prompt: 'a red cube', size: '1024x1024', n: 1 }
    const res = await fetch(`${localBase}/api/ai/v1/images/generations`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    })

    expect(res.status).toBe(200)
    expect((await res.json() as any).data[0].b64_json).toBe('aW1n')
    expect(JSON.parse(new TextDecoder().decode(cloudRequests[0].body))).toEqual(payload)
    expect(billingCalls).toEqual([])
    expect(captureCalls).toEqual([])
  })

  test('AC1: a multipart media upload keeps its boundary and bytes across the hop', async () => {
    // 256 KB of incompressible-ish bytes so the body is definitely chunked and
    // spans several frames rather than fitting one packet.
    const bytes = new Uint8Array(256 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff

    let seen: { name: string; type: string; size: number; bytes: Uint8Array } | null = null
    cloudHandler = async (req, body) => {
      const form = await new Response(body, {
        headers: { 'content-type': req.headers.get('content-type') ?? '' },
      }).formData()
      const file = form.get('file') as File
      seen = {
        name: file.name,
        type: file.type,
        size: file.size,
        bytes: new Uint8Array(await file.arrayBuffer()),
      }
      return Response.json({ url: 'https://cdn.example/uploaded.png', id: 'upload-1' })
    }

    const form = new FormData()
    form.set('provider', 'openai')
    form.set('file', new File([bytes], 'photo.png', { type: 'image/png' }))

    const res = await fetch(`${localBase}/api/ai/v1/media/uploads`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    })

    expect(res.status).toBe(200)
    expect((await res.json() as any).id).toBe('upload-1')
    expect(cloudRequests[0].headers.get('content-type')).toContain('multipart/form-data; boundary=')
    expect(seen).not.toBeNull()
    expect(seen!.name).toBe('photo.png')
    expect(seen!.type).toBe('image/png')
    expect(seen!.size).toBe(bytes.length)
    expect(Buffer.from(seen!.bytes).equals(Buffer.from(bytes))).toBe(true)
    expect(billingCalls).toEqual([])
    expect(captureCalls).toEqual([])
  })

  test('AC1: audio transcription is answered by cloud, not a local 503', async () => {
    cloudHandler = async (req, body) => {
      const form = await new Response(body, {
        headers: { 'content-type': req.headers.get('content-type') ?? '' },
      }).formData()
      return Response.json({ text: `cloud heard ${(form.get('file') as File).name}` })
    }

    const form = new FormData()
    form.set('model', 'gpt-4o-transcribe')
    form.set('file', new File([new Uint8Array([1, 2, 3, 4])], 'note.webm', { type: 'audio/webm' }))

    const res = await fetch(`${localBase}/api/ai/v1/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    })

    expect(res.status).toBe(200)
    expect((await res.json() as any).text).toBe('cloud heard note.webm')
    expect(cloudRequests[0].pathname).toBe('/api/ai/v1/audio/transcriptions')
    expect(captureCalls).toEqual([])
  })

  test("cloud's own 4xx reaches the caller untouched", async () => {
    cloudHandler = () => Response.json(
      { error: { message: 'Model not allowed on this plan', code: 'plan_required' } },
      { status: 403 },
    )

    const res = await fetch(`${localBase}/api/ai/v1/videos/generations`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'higgsfield-2', prompt: 'waves' }),
    })

    expect(res.status).toBe(403)
    expect((await res.json() as any).error.code).toBe('plan_required')
  })

  test('an unreachable cloud is a 502 with a named error, not a hang', async () => {
    // A port nothing listens on: connection refused.
    const dead = Bun.serve({ port: 0, fetch: () => new Response('') })
    const deadPort = dead.port
    dead.stop(true)
    process.env.SHOGO_CLOUD_URL = `http://127.0.0.1:${deadPort}`

    const res = await fetch(`${localBase}/api/ai/v1/3d/models`, { headers: authHeaders() })

    expect(res.status).toBe(502)
    const body = await res.json() as any
    expect(body.error.code).toBe('cloud_proxy_error')
    expect(cloudRequests).toEqual([])
  })

  test('AC2: AI_MODE=api-keys never forwards, and local behaviour is unchanged', async () => {
    process.env.AI_MODE = 'api-keys'

    const models = await fetch(`${localBase}/api/ai/v1/3d/models`, { headers: authHeaders() })
    expect(models.status).toBe(200)
    expect((await models.json() as any).models).toEqual([])

    const image = await fetch(`${localBase}/api/ai/v1/images/generations`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-image-1', prompt: 'a red cube' }),
    })
    expect(image.status).toBe(503)
    expect((await image.json() as any).error.code).toBe('provider_not_configured')

    expect(cloudRequests).toEqual([])
  })

  test('AC3: no forwarded call opens a local billing capture or balance gate', async () => {
    cloudHandler = () => Response.json({ ok: true })

    await fetch(`${localBase}/api/ai/v1/3d/models`, { headers: authHeaders() })
    await fetch(`${localBase}/api/ai/v1/media/models`, { headers: authHeaders() })
    await fetch(`${localBase}/api/ai/v1/images/generations`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-image-1', prompt: 'x' }),
    })

    expect(cloudRequests).toHaveLength(3)
    expect(billingCalls).toEqual([])
    expect(captureCalls).toEqual([])
  })
})
