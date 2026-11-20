// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-449 acceptance — the seam between the `generate_video` tool and the proxy.
 *
 * The tool and the proxy each have their own tests, and each one mocks the
 * other side: `media-tools.test.ts` asserts the body the tool posts, and
 * `ai-proxy-higgsfield-media.test.ts` asserts what the route does with a body
 * it is handed. Neither proves the two halves fit, so a rename on one side
 * (`reference_audio_urls`), or an upload content type the proxy's own
 * allow-list rejects, would pass both suites and fail in production.
 *
 * This file runs the real tool against a fake proxy, then feeds the body it
 * produced into the real request builder the route uses. No network, no spend.
 *
 *   bun test apps/api/src/__tests__/qa-sho449-reference-audio.acceptance.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createMediaTools, VIDEO_POLL } from '@shogo/agent-runtime/src/media-tools'
import {
  HIGGSFIELD_UPLOAD_CONTENT_TYPES,
  buildHiggsfieldVideoRequest,
  type HiggsfieldError,
} from '../lib/higgsfield-media'
import { VIDEO_MODEL_CATALOG } from '@shogo/model-catalog'

// Under the repo, not /tmp: the tool's path sandbox resolves real paths and on
// macOS /tmp is a symlink, which reads as "outside the workspace".
const WORKSPACE = join(import.meta.dir, '../../../../_tmp/qa-sho449-reference-audio')
const PROXY = 'http://proxy.test/api/ai/v1'

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
const realFetch = globalThis.fetch
let routes: Array<{ prefix: string; handler: Handler }> = []
let calls: Array<{ url: string; init?: RequestInit }> = []

function on(prefix: string, handler: Handler) {
  routes.push({ prefix, handler })
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function ctx() {
  return {
    workspaceDir: WORKSPACE,
    channels: new Map(),
    config: { channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' } } as any,
    projectId: 'test',
    aiProxyUrl: PROXY,
    aiProxyToken: 'pt',
  } as any
}

async function runGenerateVideo(params: Record<string, unknown>) {
  const tool = createMediaTools(ctx()).find((t) => t.name === 'generate_video')
  if (!tool) throw new Error('generate_video not registered')
  const result = await tool.execute('call-1', params as any)
  return result.details as any
}

/** The body the tool posted to `/videos/generations`, as the route would read it. */
function submittedBody(): Record<string, any> {
  const call = calls.find((c) => c.url === `${PROXY}/videos/generations`)
  if (!call) throw new Error('the tool never submitted a generation')
  return JSON.parse(String(call.init?.body))
}

function entry(id: string) {
  const found = (VIDEO_MODEL_CATALOG as Record<string, any>)[id]
  if (!found) throw new Error(`${id} is not in the catalog`)
  return found
}

/** What the route does with a body: the same builder, the same field names. */
function route(body: Record<string, any>, modelId: string) {
  return buildHiggsfieldVideoRequest(entry(modelId), {
    prompt: body.prompt,
    duration: body.duration,
    aspectRatio: body.aspect_ratio,
    resolution: body.resolution,
    audio: body.audio,
    startImageUrl: body.start_image,
    endImageUrl: body.end_image,
    referenceUrls: body.reference_images,
    referenceAudioUrls: body.reference_audio_urls,
    sourceVideoUrl: body.source_video_url,
    presetId: body.preset_id,
    options: body.options,
  })
}

beforeEach(() => {
  rmSync(WORKSPACE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, 'cast'), { recursive: true })
  mkdirSync(join(WORKSPACE, 'vo'), { recursive: true })
  writeFileSync(join(WORKSPACE, 'cast/maya.png'), 'png')
  writeFileSync(join(WORKSPACE, 'vo/line1.wav'), 'RIFF-one')
  writeFileSync(join(WORKSPACE, 'vo/line2.wav'), 'RIFF-two')
  routes = []
  calls = []
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
  rmSync(WORKSPACE, { recursive: true, force: true })
})

/** Uploads answer with a public URL; the job completes on the first poll. */
function mockProxy() {
  let n = 0
  on(`${PROXY}/media/uploads`, () => {
    n += 1
    return json({ url: `https://cdn.test/up-${n}` })
  })
  on(`${PROXY}/videos/generations`, () =>
    json({ id: 'vid_1', status: 'queued', model: 'hf-seedance-2.5', duration: 5, audio: false, estimated_usd: 0.9 }))
  on(`${PROXY}/videos/vid_1`, () =>
    json({
      id: 'vid_1',
      status: 'completed',
      model: 'hf-seedance-2.5',
      duration: 5,
      video: { url: 'https://cdn.test/out.mp4', content_type: 'video/mp4' },
    }))
  on('https://cdn.test/out.mp4', () => new Response(new Uint8Array([0, 0, 0, 24]), { headers: { 'Content-Type': 'video/mp4' } }))
}

describe('SHO-449 AC1 — a lip-sync call survives the tool→proxy seam', () => {
  test('every upload uses a content type the proxy accepts, and the body routes to reference-to-video', async () => {
    mockProxy()

    const result = await runGenerateVideo({
      prompt: 'maya says her line',
      model: 'hf-seedance-2.5',
      reference_images: ['cast/maya.png'],
      reference_audio: ['vo/line1.wav', 'vo/line2.wav'],
      path: 'videos/maya.mp4',
    })
    expect(result.error).toBeUndefined()

    // The proxy's upload route 400s any content type outside this set, so the
    // tool's choice has to be one of them — the seam neither suite covered.
    // Only the voice tracks are uploaded here: the route turns a data-URI
    // reference image into a public URL itself, so the tool must not spend an
    // upload on it.
    const uploads = calls.filter((c) => c.url === `${PROXY}/media/uploads`)
    expect(uploads).toHaveLength(2)
    for (const upload of uploads) {
      const contentType = (upload.init?.headers as any)['Content-Type']
      expect(HIGGSFIELD_UPLOAD_CONTENT_TYPES.has(contentType)).toBe(true)
    }

    // The body the tool posted, read by the route's own builder.
    const body = submittedBody()
    expect(Object.keys(body)).toContain('reference_audio_urls')
    expect(body.reference_images).toEqual([`data:image/png;base64,${Buffer.from('png').toString('base64')}`])
    const request = route(body, 'hf-seedance-2.5')
    expect(request.endpoint).toBe('bytedance/seedance-2.5/reference-to-video')
    expect(request.input.image_urls).toEqual(body.reference_images)
    expect(request.input.audio_urls).toEqual(['https://cdn.test/up-1', 'https://cdn.test/up-2'])
    expect(request.input.prompt).toBe('maya says her line')
  })

  test('the same call with no references still routes to text-to-video', async () => {
    mockProxy()

    const result = await runGenerateVideo({
      prompt: 'a quiet street at dawn',
      model: 'hf-seedance-2.5',
      path: 'videos/street.mp4',
    })
    expect(result.error).toBeUndefined()

    const body = submittedBody()
    expect(body.reference_audio_urls).toBeUndefined()
    const request = route(body, 'hf-seedance-2.5')
    expect(request.endpoint).toBe('bytedance/seedance-2.5/text-to-video')
    expect(request.input.audio_urls).toBeUndefined()
    expect(request.input.image_urls).toBeUndefined()
  })
})

describe('SHO-449 AC3 — a model with no audio field is refused downstream, not silently dropped', () => {
  test('Happy Horse takes the images and refuses the voice track the tool uploaded', async () => {
    mockProxy()

    const result = await runGenerateVideo({
      prompt: 'the horse speaks',
      model: 'hf-happy-horse',
      reference_images: ['cast/maya.png'],
      reference_audio: ['vo/line1.wav'],
      path: 'videos/horse.mp4',
    })
    // The tool's job is the global 10-clip ceiling; the per-model cap is the
    // proxy's, so the call gets as far as the route and is refused there.
    expect(result.error).toBeUndefined()

    const body = submittedBody()
    expect(body.reference_audio_urls).toHaveLength(1)
    let thrown: HiggsfieldError | undefined
    try {
      route(body, 'hf-happy-horse')
    } catch (error) {
      thrown = error as HiggsfieldError
    }
    expect(thrown?.code).toBe('reference_audio_unsupported')
    expect(thrown?.message).toContain('takes no reference audio')
  })

  test('the images alone still reach Happy Horse’s reference endpoint', async () => {
    mockProxy()

    const result = await runGenerateVideo({
      prompt: 'the horse speaks',
      model: 'hf-happy-horse',
      reference_images: ['cast/maya.png'],
      path: 'videos/horse.mp4',
    })
    expect(result.error).toBeUndefined()

    const request = route(submittedBody(), 'hf-happy-horse')
    expect(request.endpoint).toBe('alibaba/happy-horse/reference-to-video')
    expect(request.input.image_urls).toHaveLength(1)
    expect(request.input.audio_urls).toBeUndefined()
  })
})

describe('SHO-449 AC4 — the tool’s ceiling and the model’s ceiling are different numbers', () => {
  test('the tool allows 10 clips, and Wan’s 5 is enforced by the route', async () => {
    mockProxy()
    for (let i = 3; i <= 6; i += 1) writeFileSync(join(WORKSPACE, `vo/line${i}.wav`), `RIFF-${i}`)

    const result = await runGenerateVideo({
      prompt: 'six voices',
      model: 'hf-wan-3.0',
      reference_audio: ['vo/line1.wav', 'vo/line2.wav', 'vo/line3.wav', 'vo/line4.wav', 'vo/line5.wav', 'vo/line6.wav'],
      path: 'videos/wan.mp4',
    })
    expect(result.error).toBeUndefined()

    const body = submittedBody()
    expect(body.reference_audio_urls).toHaveLength(6)
    let thrown: HiggsfieldError | undefined
    try {
      route(body, 'hf-wan-3.0')
    } catch (error) {
      thrown = error as HiggsfieldError
    }
    expect(thrown?.code).toBe('too_many_reference_audio')
    expect(thrown?.message).toContain('at most 5')
  })
})
