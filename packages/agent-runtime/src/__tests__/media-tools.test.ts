// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Media tools: generate_image references and output paths, image utilities,
 * list_media_models, generate_video polling / timeout / background jobs, and
 * capability gating.
 *
 * Run: bun test packages/agent-runtime/src/__tests__/media-tools.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { createTools, filterDisabledCapabilityTools, type ToolContext } from '../gateway-tools'
import { VIDEO_POLL, _testing } from '../media-tools'

const TEST_DIR = '/tmp/test-media-tools'
const PROXY = 'http://proxy.test/api/ai/v1'
const B64_PNG = Buffer.from([137, 80, 78, 71]).toString('base64')

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
const realFetch = globalThis.fetch
let routes: Array<{ prefix: string; handler: Handler }> = []
let calls: Array<{ url: string; init?: RequestInit }> = []

function on(prefix: string, handler: Handler) {
  routes.push({ prefix, handler })
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function ctx(config: Record<string, unknown> = {}): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: { channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' }, ...config } as any,
    projectId: 'test',
    aiProxyUrl: PROXY,
    aiProxyToken: 'pt',
  }
}

function tool(name: string, c = ctx()) {
  const t = createTools(c).find((x) => x.name === name)
  if (!t) throw new Error(`${name} not registered`)
  return t
}

async function run(name: string, params: Record<string, unknown>, c = ctx(), signal?: AbortSignal) {
  const result = await tool(name, c).execute('call-1', params as any, signal)
  return result.details as any
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(join(TEST_DIR, 'refs'), { recursive: true })
  writeFileSync(join(TEST_DIR, 'refs/a.png'), 'a')
  writeFileSync(join(TEST_DIR, 'refs/b.jpg'), 'b')
  routes = []
  calls = []
  _testing.trackedVideoJobs.clear()
  VIDEO_POLL.intervalMs = 5
  VIDEO_POLL.timeoutMs = 10_000
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, init })
    const route = routes.find((r) => url.startsWith(r.prefix))
    if (!route) return json({ error: { message: `unrouted ${url}` } }, 599)
    return route.handler(url, init)
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(TEST_DIR, { recursive: true, force: true })
})

// =========================================================================
// generate_image
// =========================================================================

describe('generate_image', () => {
  test('sends every reference image (and the alias) to the edits route', async () => {
    let form: FormData | undefined
    on(`${PROXY}/images/edits`, (_u, init) => {
      form = init?.body as FormData
      return json({ data: [{ b64_json: B64_PNG, content_type: 'image/png' }] })
    })
    const r = await run('generate_image', {
      prompt: 'same hero, new pose',
      model: 'nano-banana-pro',
      reference_images: ['refs/a.png'],
      reference_image: 'refs/b.jpg',
    })
    expect(r.error).toBeUndefined()
    const images = form!.getAll('image') as File[]
    expect(images).toHaveLength(2)
    expect(images[1].type).toBe('image/jpeg')
    expect(form!.get('model')).toBe('nano-banana-pro')
    expect(r.reference_images).toEqual(['refs/a.png', 'refs/b.jpg'])
  })

  test('saves to a path anywhere in the workspace and numbers multiple options', async () => {
    on(`${PROXY}/images/generations`, () => json({ data: [{ b64_json: B64_PNG }, { b64_json: B64_PNG }] }))
    const r = await run('generate_image', { prompt: 'p', path: 'public/assets/cab1/player.png', options: 2 })
    expect(r.paths).toEqual(['public/assets/cab1/player-1.png', 'public/assets/cab1/player-2.png'])
    expect(readFileSync(join(TEST_DIR, 'public/assets/cab1/player-1.png'))).toEqual(Buffer.from(B64_PNG, 'base64'))
  })

  test('picks the extension from the content type for auto-named files', async () => {
    on(`${PROXY}/images/generations`, () => json({ data: [{ b64_json: B64_PNG, content_type: 'image/jpeg' }] }))
    const r = await run('generate_image', { prompt: 'p', model: 'flux-pro-ultra' })
    expect(r.path).toMatch(/^images\/generated-.*\.jpg$/)
  })

  test('rejects an output path outside the workspace', async () => {
    const r = await run('generate_image', { prompt: 'p', path: '../escape.png' })
    expect(r.error).toMatch(/outside/i)
    expect(calls).toHaveLength(0)
  })

  test('rejects more than four references', async () => {
    const r = await run('generate_image', {
      prompt: 'p',
      reference_images: ['refs/a.png', 'refs/b.jpg', 'r3.png', 'r4.png'],
      reference_image: 'r5.png',
    })
    expect(r.error).toContain('At most 4')
  })
})

// =========================================================================
// Image utilities and model listing
// =========================================================================

describe('upscale_image / remove_background', () => {
  test('upscale saves next to the original by default', async () => {
    let body: any
    on(`${PROXY}/images/process`, (_u, init) => {
      body = JSON.parse(String(init?.body))
      return json({ data: [{ b64_json: B64_PNG, content_type: 'image/png', width: 2048, height: 2048 }] })
    })
    const r = await run('upscale_image', { path: 'refs/b.jpg', scale: 4 })
    expect(body).toMatchObject({ operation: 'upscale', scale: 4 })
    expect(body.image).toStartWith('data:image/jpeg;base64,')
    expect(r.path).toBe('refs/b-upscaled.png')
    expect(existsSync(join(TEST_DIR, 'refs/b-upscaled.png'))).toBe(true)
  })

  test('remove_background honours output_path', async () => {
    on(`${PROXY}/images/process`, () => json({ data: [{ b64_json: B64_PNG, content_type: 'image/png' }] }))
    const r = await run('remove_background', { path: 'refs/a.png', output_path: 'sprites/hero.png' })
    expect(r.path).toBe('sprites/hero.png')
  })

  test('missing input image is reported', async () => {
    const r = await run('remove_background', { path: 'nope.png' })
    expect(r.error).toContain('Image not found')
  })
})

describe('list_media_models', () => {
  const payload = { images: [{ id: 'nano-banana-pro' }], videos: [{ id: 'kling-3-pro' }], utilities: [], currency: 'USD' }

  test('hides videos while video generation is off', async () => {
    on(`${PROXY}/media/models`, () => json(payload))
    const r = await run('list_media_models', {})
    expect(r.images).toHaveLength(1)
    expect(r.videos).toEqual([])
    expect(r.videos_note).toContain('off')
  })

  test('returns videos when video generation is on', async () => {
    on(`${PROXY}/media/models`, () => json(payload))
    const r = await run('list_media_models', { kind: 'video' }, ctx({ videoGenEnabled: true }))
    expect(r.videos).toHaveLength(1)
    expect(r.images).toBeUndefined()
  })
})

// =========================================================================
// generate_video
// =========================================================================

describe('generate_video', () => {
  function mockVideoFlow(statuses: string[]) {
    let submitBody: any
    let polls = 0
    on(`${PROXY}/videos/generations`, (_u, init) => {
      submitBody = JSON.parse(String(init?.body))
      return json({ id: 'vid_1', status: 'queued', model: 'kling-3-pro', duration: 5, audio: false, estimated_usd: 0.67 })
    })
    on(`${PROXY}/videos/vid_1`, () => {
      const status = statuses[Math.min(polls++, statuses.length - 1)]
      return json({
        id: 'vid_1',
        status,
        model: 'kling-3-pro',
        duration: 5,
        ...(status === 'completed' ? { video: { url: 'https://cdn.fal/v.mp4', content_type: 'video/mp4' } } : {}),
        ...(status === 'failed' ? { error: 'content policy' } : {}),
      })
    })
    on('https://cdn.fal/v.mp4', () => new Response(new Uint8Array([0, 0, 0, 24]), { headers: { 'Content-Type': 'video/mp4' } }))
    return { submitBody: () => submitBody, polls: () => polls }
  }

  test('submits, polls until complete and saves the MP4 under videos/', async () => {
    const flow = mockVideoFlow(['queued', 'in_progress', 'completed'])
    const r = await run('generate_video', { prompt: 'a fox runs', model: 'kling-3-pro', start_image: 'refs/a.png' })
    expect(r.error).toBeUndefined()
    expect(r.status).toBe('completed')
    expect(r.path).toMatch(/^videos\/video-.*\.mp4$/)
    expect(readFileSync(join(TEST_DIR, r.path))).toEqual(Buffer.from([0, 0, 0, 24]))
    expect(flow.polls()).toBe(3)
    expect(flow.submitBody().start_image).toStartWith('data:image/png;base64,')
  })

  test('reports a failed job', async () => {
    mockVideoFlow(['in_progress', 'failed'])
    const r = await run('generate_video', { prompt: 'x', filename: 'clip.mp4' })
    expect(r.status).toBe('failed')
    expect(r.error).toBe('content policy')
  })

  test('hands off to the background after the timeout and the file still lands', async () => {
    VIDEO_POLL.timeoutMs = 12
    const statuses = ['in_progress', 'in_progress', 'in_progress', 'in_progress', 'in_progress', 'completed']
    mockVideoFlow(statuses)
    const r = await run('generate_video', { prompt: 'x', path: 'media/intro.mp4' })
    expect(r.status).toBe('in_progress')
    expect(r.job_id).toBe('vid_1')
    expect(r.message).toContain('media/intro.mp4')
    await _testing.trackedVideoJobs.get('vid_1')!.done
    expect(existsSync(join(TEST_DIR, 'media/intro.mp4'))).toBe(true)
    const checked = await run('generate_video', { job_id: 'vid_1' })
    expect(checked).toMatchObject({ status: 'completed', path: 'media/intro.mp4' })
  })

  test('wait: false returns immediately with the planned path', async () => {
    mockVideoFlow(['completed'])
    const r = await run('generate_video', { prompt: 'x', path: 'shots/one.mp4', wait: false })
    expect(r).toMatchObject({ status: 'queued', job_id: 'vid_1', planned_path: 'shots/one.mp4', estimated_usd: 0.67 })
    await _testing.trackedVideoJobs.get('vid_1')!.done
    expect(existsSync(join(TEST_DIR, 'shots/one.mp4'))).toBe(true)
  })

  test('stops waiting on abort but keeps following the job', async () => {
    mockVideoFlow(['in_progress', 'in_progress', 'completed'])
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 2)
    VIDEO_POLL.intervalMs = 20
    const r = await run('generate_video', { prompt: 'x', path: 'a/b.mp4' }, ctx(), controller.signal)
    expect(r.message).toContain('Stopped waiting')
    await _testing.trackedVideoJobs.get('vid_1')!.done
    expect(existsSync(join(TEST_DIR, 'a/b.mp4'))).toBe(true)
  })

  test('surfaces a rejected submission', async () => {
    on(`${PROXY}/videos/generations`, () =>
      json({ error: { message: 'Veo 3.1 Fast supports durations 4, 6, 8 seconds; got 5.' } }, 400))
    const r = await run('generate_video', { prompt: 'x', model: 'veo-3.1-fast', duration: 5 })
    expect(r.error).toContain('durations 4, 6, 8')
  })
})

// =========================================================================
// Gating
// =========================================================================

describe('capability gating', () => {
  const names = (config: Record<string, unknown>) =>
    filterDisabledCapabilityTools(createTools(ctx(config)), ctx(config).config).map((t) => t.name)

  test('generate_video is opt-in', () => {
    expect(names({})).not.toContain('generate_video')
    expect(names({ videoGenEnabled: true })).toContain('generate_video')
  })

  test('imageGenEnabled: false removes the image tools but keeps the listing for video', () => {
    const off = names({ imageGenEnabled: false, videoGenEnabled: true })
    for (const n of ['generate_image', 'upscale_image', 'remove_background']) expect(off).not.toContain(n)
    expect(off).toContain('list_media_models')
    expect(names({ imageGenEnabled: false })).not.toContain('list_media_models')
  })
})
