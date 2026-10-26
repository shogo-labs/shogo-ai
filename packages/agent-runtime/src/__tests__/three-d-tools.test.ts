// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * 3D tools: generate_3d_model (text / image / multiview), edit_3d_model (every
 * post-process op), output paths, background jobs, part-only results, the free
 * rig check, and the opt-in capability gate.
 *
 * No test here reaches the vendor: the AI proxy is stubbed at the fetch layer.
 *
 * Run: bun test packages/agent-runtime/src/__tests__/three-d-tools.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import {
  createTools,
  filterDisabledCapabilityTools,
  type ToolContext,
} from '../gateway-tools'
import { getBuiltinSubagentConfig } from '../subagent'
import { MEDIA_TOOL_NAMES, THREE_D_TOOL_NAMES } from '../media-tool-names'
import { THREE_D_POLL, _testing } from '../three-d-tools'

// Inside the repo, not /tmp: macOS realpaths /tmp → /private/tmp, so
// assertWithinWorkspace rejects every path under the fixture directory.
const TEST_DIR = join(import.meta.dir, '.three-d-tmp')
const PROXY = 'http://proxy.test/api/ai/v1'
const BASE = 'http://proxy.test/api/ai'
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

function submitBodies() {
  return calls
    .filter((c) => c.url === `${BASE}/v1/3d/generations`)
    .map((c) => JSON.parse(String(c.init?.body)))
}

/** Submit → success on the first poll, with the file served from `model_url`. */
function mockJob(result: Record<string, unknown>, statuses: string[] = ['success']) {
  let polls = 0
  on(`${BASE}/v1/3d/generations`, () => json({ id: 'gen3d_1', status: 'queued', model: 'tripo-v3.1', estimated_usd: 0.24 }))
  on(`${BASE}/v1/3d/gen3d_1`, () => {
    const status = statuses[Math.min(polls++, statuses.length - 1)]
    return json({ id: 'gen3d_1', status, ...(status === 'success' ? result : {}) })
  })
  on('https://cdn.tripo/model.glb', () => new Response(new Uint8Array([103, 108, 84, 70])))
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(join(TEST_DIR, 'refs'), { recursive: true })
  mkdirSync(join(TEST_DIR, 'models'), { recursive: true })
  writeFileSync(join(TEST_DIR, 'refs/a.png'), 'a')
  writeFileSync(join(TEST_DIR, 'refs/b.png'), 'b')
  writeFileSync(join(TEST_DIR, 'refs/c.png'), 'c')
  writeFileSync(join(TEST_DIR, 'refs/d.png'), 'd')
  writeFileSync(join(TEST_DIR, 'models/source.glb'), 'glb-bytes')
  routes = []
  calls = []
  _testing.trackedThreeDJobs.clear()
  THREE_D_POLL.intervalMs = 5
  THREE_D_POLL.timeoutMs = 10_000
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
// generate_3d_model
// =========================================================================

describe('generate_3d_model', () => {
  test('text-to-3D submits op, prompt and model, then saves the GLB', async () => {
    mockJob({ status: 'success', progress: 100, model_url: 'https://cdn.tripo/model.glb', credits_consumed: 20, billed_usd: 0.24 })
    const r = await run('generate_3d_model', { prompt: 'a wooden treasure chest', model: 'tripo-v3.1' })

    expect(r.error).toBeUndefined()
    expect(submitBodies()[0]).toMatchObject({ op: 'text_to_model', prompt: 'a wooden treasure chest', model: 'tripo-v3.1' })
    expect(r.status).toBe('success')
    expect(r.path).toMatch(/^models\/a-wooden-treasure-chest-.*\.glb$/)
    expect(readFileSync(join(TEST_DIR, r.path))).toEqual(Buffer.from([103, 108, 84, 70]))
    expect(r.credits_consumed).toBe(20)
    expect(r.cost).toContain('$0.24')
  })

  test('image-to-3D sends the workspace image as a data URI', async () => {
    mockJob({ status: 'success', model_url: 'https://cdn.tripo/model.glb', credits_consumed: 30, billed_usd: 0.36 })
    const r = await run('generate_3d_model', { image: 'refs/a.png' })

    expect(submitBodies()[0].op).toBe('image_to_model')
    expect(submitBodies()[0].image).toStartWith('data:image/png;base64,')
    expect(r.error).toBeUndefined()
  })

  test('multiview sends exactly four views in front, left, back, right order', async () => {
    mockJob({ status: 'success', model_url: 'https://cdn.tripo/model.glb', credits_consumed: 30, billed_usd: 0.36 })
    const r = await run('generate_3d_model', {
      mode: 'multiview',
      images: ['refs/a.png', 'refs/b.png', 'refs/c.png', 'refs/d.png'],
    })

    expect(r.error).toBeUndefined()
    const body = submitBodies()[0]
    expect(body.op).toBe('multiview_to_model')
    expect(body.images).toHaveLength(4)
    expect(body.images[0]).toStartWith('data:image/png;base64,')
    expect(r.input).toBe('multiview')
  })

  test('rejects a multiview request with the wrong number of images without submitting', async () => {
    const r = await run('generate_3d_model', { images: ['refs/a.png', 'refs/b.png', 'refs/c.png'] })
    expect(r.error).toContain('exactly 4')
    expect(calls).toHaveLength(0)
  })

  test('honours an explicit output path and keeps the GLB extension', async () => {
    mockJob({ status: 'success', model_url: 'https://cdn.tripo/model.glb', credits_consumed: 20, billed_usd: 0.24 })
    const r = await run('generate_3d_model', { prompt: 'p', path: 'public/assets/chest' })
    expect(r.path).toBe('public/assets/chest.glb')
    expect(existsSync(join(TEST_DIR, 'public/assets/chest.glb'))).toBe(true)
  })

  test('wait: false returns a job id and the file still lands in the background', async () => {
    mockJob({ status: 'success', model_url: 'https://cdn.tripo/model.glb', credits_consumed: 20, billed_usd: 0.24 })
    const r = await run('generate_3d_model', { prompt: 'p', path: 'shots/one.glb', wait: false })
    expect(r).toMatchObject({ status: 'queued', job_id: 'gen3d_1', planned_path: 'shots/one.glb' })
    await _testing.trackedThreeDJobs.get('gen3d_1')!.done
    expect(existsSync(join(TEST_DIR, 'shots/one.glb'))).toBe(true)
  })

  test('a proxy rejection surfaces its message and writes no file', async () => {
    on(`${BASE}/v1/3d/generations`, () =>
      json({ error: { message: "3D model 'tripo-nope' is not supported.", code: 'model_not_found' } }, 400))
    const r = await run('generate_3d_model', { prompt: 'p', model: 'tripo-nope' })
    expect(r.error).toContain('is not supported')
    expect(readdirSync(join(TEST_DIR, 'models'))).toEqual(['source.glb'])
  })
})

// =========================================================================
// edit_3d_model
// =========================================================================

describe('edit_3d_model', () => {
  test('convert uploads a workspace model, forwards format and writes the new extension', async () => {
    let uploadBody: any
    on(`${BASE}/v1/3d/files`, (_u, init) => {
      uploadBody = JSON.parse(String(init?.body))
      return json({ file_token: 'file_abc' })
    })
    mockJob({ status: 'success', model_url: 'https://cdn.tripo/model.glb', credits_consumed: 10, billed_usd: 0.12 })

    const r = await run('edit_3d_model', { op: 'convert', input: 'models/source.glb', format: 'USDZ' })

    expect(r.error).toBeUndefined()
    // The route reads `data_base64`; a `content_base64` body is a 400.
    expect(uploadBody).toMatchObject({
      filename: 'source.glb',
      contentType: 'model/gltf-binary',
      data_base64: expect.any(String),
    })
    expect(uploadBody).not.toHaveProperty('content_base64')
    const body = submitBodies()[0]
    expect(body).toMatchObject({ op: 'convert', input: 'file_abc', format: 'USDZ' })
    expect(r.path).toMatch(/^models\/convert-.*\.usdz$/)
    expect(readFileSync(join(TEST_DIR, r.path))).toEqual(Buffer.from([103, 108, 84, 70]))
  })

  test('a job id input is forwarded untouched', async () => {
    mockJob({ status: 'success', model_url: 'https://cdn.tripo/model.glb', credits_consumed: 35, billed_usd: 0.42 })
    await run('edit_3d_model', { op: 'retopology', input: 'gen3d_9f1c', face_limit: 5000 })
    expect(calls.some((c) => c.url === `${BASE}/v1/3d/files`)).toBe(false)
    expect(submitBodies()[0]).toMatchObject({ op: 'retopology', input: 'gen3d_9f1c', face_limit: 5000 })
  })

  test('a workspace style image is uploaded into texture_prompt', async () => {
    on(`${BASE}/v1/3d/files`, () => json({ file_token: 'file_style' }))
    mockJob({ status: 'success', model_url: 'https://cdn.tripo/model.glb', credits_consumed: 20, billed_usd: 0.24 })
    await run('edit_3d_model', {
      op: 'texture',
      input: 'https://cdn.example/model.glb',
      texture_prompt: 'weathered oak',
      style_image: 'refs/a.png',
      texture_quality: 'detailed',
    })
    expect(submitBodies()[0]).toMatchObject({
      op: 'texture',
      input: 'https://cdn.example/model.glb',
      texture_prompt: { text: 'weathered oak', style_image: 'file_style' },
      texture_quality: 'detailed',
    })
  })

  test('segment returns the part names the next op needs', async () => {
    mockJob({ status: 'success', parts: ['body', 'lid', 'lock'], credits_consumed: 40, billed_usd: 0.48 })
    const r = await run('edit_3d_model', { op: 'segment', input: 'gen3d_1' })
    expect(r.status).toBe('success')
    expect(r.parts).toEqual(['body', 'lid', 'lock'])
    expect(r.path).toBeUndefined()
  })

  test('complete requires the part names from segment', async () => {
    const r = await run('edit_3d_model', { op: 'complete', input: 'gen3d_1' })
    expect(r.error).toContain('part_names is required')
    expect(calls).toHaveLength(0)

    mockJob({ status: 'success', model_url: 'https://cdn.tripo/model.glb', credits_consumed: 50, billed_usd: 0.60 })
    const ok = await run('edit_3d_model', { op: 'complete', input: 'gen3d_1', part_names: ['lid'] })
    expect(ok.error).toBeUndefined()
    expect(submitBodies()[0]).toMatchObject({ op: 'complete', part_names: ['lid'] })
    // 50 credits of mesh: it has to land on disk, not just report success.
    expect(ok.path).toBeString()
    expect(ok.path.endsWith('.glb')).toBe(true)
    expect(readFileSync(join(TEST_DIR, ok.path))).toEqual(Buffer.from([103, 108, 84, 70]))
  })

  test('rig_check reports free and writes no file', async () => {
    mockJob({ status: 'success', riggable: true, parts: ['body'], credits_consumed: 0, billed_usd: 0 })
    const r = await run('edit_3d_model', { op: 'rig_check', input: 'gen3d_1' })
    expect(r.status).toBe('success')
    expect(r.free).toBe(true)
    expect(r.credits_consumed).toBe(0)
    expect(r.cost).toContain('free')
    expect(r.path).toBeUndefined()
    expect(readdirSync(join(TEST_DIR, 'models'))).toEqual(['source.glb'])
  })

  test('rig defaults rig_type to biped', async () => {
    mockJob({ status: 'success', model_url: 'https://cdn.tripo/model.glb', credits_consumed: 25, billed_usd: 0.30 })
    await run('edit_3d_model', { op: 'rig', input: 'gen3d_1' })
    expect(submitBodies()[0]).toMatchObject({ op: 'rig', rig_type: 'biped' })
  })

  test('retarget forwards an animation list and rejects both shapes at once', async () => {
    mockJob({ status: 'success', model_url: 'https://cdn.tripo/model.glb', credits_consumed: 20, billed_usd: 0.24 })
    await run('edit_3d_model', { op: 'retarget', input: 'gen3d_1', animations: ['preset:walk', 'preset:run'] })
    expect(submitBodies()[0]).toMatchObject({ op: 'retarget', animations: ['preset:walk', 'preset:run'] })

    const r = await run('edit_3d_model', { op: 'retarget', input: 'gen3d_1', animation: 'preset:walk', animations: ['preset:run'] })
    expect(r.error).toContain('not both')
  })

  test('rejects an unknown op and a convert without a format', async () => {
    expect((await run('edit_3d_model', { op: 'stylize', input: 'gen3d_1' })).error).toContain('op is required')
    expect((await run('edit_3d_model', { op: 'convert', input: 'gen3d_1' })).error).toContain('format is required')
    expect(calls).toHaveLength(0)
  })

  test('a failed task reports the vendor error and writes no file', async () => {
    mockJob({ status: 'failed', error: 'mesh has no UVs' })
    const r = await run('edit_3d_model', { op: 'texture', input: 'gen3d_1', texture_prompt: 'oak' })
    expect(r.status).toBe('failed')
    expect(r.error).toBe('mesh has no UVs')
    expect(r.path).toBeUndefined()
  })
})

// =========================================================================
// Capability gating
// =========================================================================

describe('threeDGenEnabled gating', () => {
  const visible = (config: Record<string, unknown>) => {
    const c = ctx(config)
    return new Set(filterDisabledCapabilityTools(createTools(c), c.config as any).map((t) => t.name))
  }

  test('both 3D tools are opt-in and absent by default', () => {
    const names = visible({})
    for (const n of THREE_D_TOOL_NAMES) expect(names.has(n)).toBe(false)
    expect(THREE_D_TOOL_NAMES).toEqual(['generate_3d_model', 'edit_3d_model'])
  })

  test('turning the capability on exposes both tools', () => {
    const names = visible({ threeDGenEnabled: true })
    for (const n of THREE_D_TOOL_NAMES) expect(names.has(n)).toBe(true)
  })

  test('the media subagent cannot reach them while the flag is off', () => {
    const config = ctx({})
    const tools = filterDisabledCapabilityTools(createTools(config), config.config as any)
    const media = getBuiltinSubagentConfig('media', config, tools)!
    const subagentNames = tools.filter((t) => media.toolNames!.includes(t.name)).map((t) => t.name)
    for (const n of THREE_D_TOOL_NAMES) {
      expect(MEDIA_TOOL_NAMES).toContain(n)
      expect(subagentNames).not.toContain(n)
    }
    expect(subagentNames).toContain('generate_image')

    const on = ctx({ threeDGenEnabled: true })
    const onTools = filterDisabledCapabilityTools(createTools(on), on.config as any)
    const onSubagent = onTools.filter((t) => media.toolNames!.includes(t.name)).map((t) => t.name)
    for (const n of THREE_D_TOOL_NAMES) expect(onSubagent).toContain(n)
  })

  test('list_media_models stays available while any generation capability is on', () => {
    expect(visible({}).has('list_media_models')).toBe(true) // image gen defaults on
    expect(visible({ imageGenEnabled: false }).has('list_media_models')).toBe(false)
    expect(visible({ imageGenEnabled: false, threeDGenEnabled: true }).has('list_media_models')).toBe(true)
    expect(visible({ imageGenEnabled: false, videoGenEnabled: true }).has('list_media_models')).toBe(true)
  })
})
