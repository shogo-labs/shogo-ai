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
import { VIDEO_POLL, _testing, readMp4DurationSeconds } from '../media-tools'

const TEST_DIR = '/tmp/test-media-tools'
const PROXY = 'http://proxy.test/api/ai/v1'
const B64_PNG = Buffer.from([137, 80, 78, 71]).toString('base64')

/**
 * A minimal but real MP4: `ftyp` + `moov`/`mvhd` with the given duration, which
 * is all `readMp4DurationSeconds` needs and all the provider checks before a
 * Genjutsu edit.
 */
function mp4Fixture(seconds: number): Buffer {
  const mvhd = Buffer.alloc(108)
  mvhd.writeUInt32BE(108, 0)
  mvhd.write('mvhd', 4, 'ascii')
  mvhd[8] = 0 // version 0
  mvhd.writeUInt32BE(1000, 20) // timescale (payload starts at 8 + 4 version/flags + 4 + 4)
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 24) // duration

  const ftyp = Buffer.alloc(24)
  ftyp.writeUInt32BE(24, 0)
  ftyp.write('ftyp', 4, 'ascii')
  ftyp.write('isom', 8, 'ascii')

  const moov = Buffer.alloc(8 + mvhd.length)
  moov.writeUInt32BE(8 + mvhd.length, 0)
  moov.write('moov', 4, 'ascii')
  mvhd.copy(moov, 8)

  return Buffer.concat([ftyp, moov])
}

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

  test('kind "presets" lists the restyle styles instead of models', async () => {
    on(`${PROXY}/media/presets`, () => json({ presets: [{ id: 'preset-1', name: 'Anime' }] }))
    const r = await run('list_media_models', { kind: 'presets' })
    expect(r.presets).toEqual([{ id: 'preset-1', name: 'Anime' }])
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

  test('passes no model when the caller did not pick one, so the proxy default applies', async () => {
    const flow = mockVideoFlow(['completed'])
    await run('generate_video', { prompt: 'a fox runs' })
    // Hardcoding a Higgsfield id here would 503 on an install without its key.
    expect(flow.submitBody().model).toBeUndefined()
  })

  test('a Genjutsu edit uploads the source clip, measures it, and submits both', async () => {
    writeFileSync(join(TEST_DIR, 'refs/clip.mp4'), mp4Fixture(8))
    on(`${PROXY}/media/uploads`, () => json({ url: 'https://cdn.hf/in.mp4' }))
    const flow = mockVideoFlow(['completed'])

    const r = await run('generate_video', {
      source_video: 'refs/clip.mp4',
      genjutsu: 'restyle',
      preset_id: 'preset-1',
      prompt: 'make it anime',
      path: 'videos/restyled.mp4',
    })
    expect(r.error).toBeUndefined()

    const upload = calls.find((c) => c.url === `${PROXY}/media/uploads`)
    expect(upload).toBeDefined()
    expect((upload!.init?.headers as any)['Content-Type']).toBe('video/mp4')

    expect(flow.submitBody()).toMatchObject({
      model: 'hf-genjutsu-restyle',
      source_video_url: 'https://cdn.hf/in.mp4',
      source_duration_seconds: 8,
      preset_id: 'preset-1',
      prompt: 'make it anime',
    })
  })

  test('readMp4DurationSeconds reads the mvhd box', () => {
    expect(readMp4DurationSeconds(mp4Fixture(8))).toBeCloseTo(8, 3)
    expect(readMp4DurationSeconds(mp4Fixture(12.5))).toBeCloseTo(12.5, 3)
    expect(readMp4DurationSeconds(Buffer.from([1, 2, 3]))).toBeNull()
  })

  test('a source clip shorter than 4 s is refused before upload', async () => {
    writeFileSync(join(TEST_DIR, 'refs/short.mp4'), mp4Fixture(2))
    const r = await run('generate_video', { source_video: 'refs/short.mp4', genjutsu: 'object_swap', prompt: 'x' })
    expect(r.error).toContain('at least 4 s')
    expect(calls.some((c) => c.url.includes('/media/uploads'))).toBe(false)
  })

  test('genjutsu without a source clip is refused before anything is uploaded', async () => {
    const r = await run('generate_video', { genjutsu: 'motion_transfer', prompt: 'x' })
    expect(r.error).toContain('source_video')
    expect(calls.some((c) => c.url.includes('/media/uploads'))).toBe(false)
  })

  test('a non-MP4 source clip is refused with the reason', async () => {
    writeFileSync(join(TEST_DIR, 'refs/clip.mov'), 'mov')
    const r = await run('generate_video', { source_video: 'refs/clip.mov', genjutsu: 'object_swap', prompt: 'x' })
    expect(r.error).toContain('must be an .mp4')
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
