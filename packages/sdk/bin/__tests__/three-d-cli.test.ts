// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo 3d` — argument mapping, uploads, polling, output files, exit codes,
 * and parity between the monorepo entry (bin/shogo.ts) and the published
 * wrapper (bin/cli.mjs).
 *
 * The proxy is a local stub: no test reaches the vendor.
 *
 * Run: bun test packages/sdk/bin/__tests__/three-d-cli.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { runThreeDCommand, threeDHelp, THREE_D_COMMANDS } from '../three-d-cli.mjs'

const BIN_DIR = resolve(import.meta.dir, '..')
const SDK_DIR = resolve(BIN_DIR, '..')

let work: string
let server: ReturnType<typeof Bun.serve> | null = null
let base = ''

type Captured = { path: string; body?: any }
let captured: Captured[] = []
let jobStatuses: string[] = ['success']
let jobResult: Record<string, unknown> = {}
let submitStatus = 200
let submitBody: Record<string, unknown> = {}
// Mirrors what GET /ai/v1/3d/models returns: price.usd per model,
// estimated_credits per operation (1 credit = $0.01).
let modelsResponse: Record<string, unknown> = {
  models: [{ id: 'tripo-v3.1', price: { usd: 0.24, untextured_usd: 0.12 } }],
  operations: [
    { op: 'rig_check', estimated_credits: 0 },
    { op: 'rig', estimated_credits: 25 },
  ],
}

function startStub() {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      captured.push({
        path: url.pathname,
        body: req.method === 'POST' ? await req.clone().json().catch(() => undefined) : undefined,
      })
      if (url.pathname === '/v1/3d/files') return Response.json({ file_token: 'file_uploaded' })
      if (url.pathname === '/v1/3d/models') return Response.json(modelsResponse)
      if (url.pathname === '/v1/3d/generations') {
        if (submitStatus !== 200) return Response.json(submitBody, { status: submitStatus })
        return Response.json({ id: 'gen3d_1', ...submitBody })
      }
      if (url.pathname === '/v1/3d/gen3d_1') {
        const status = jobStatuses.length > 1 ? jobStatuses.shift()! : jobStatuses[0]
        const progress = status === 'queued' ? 0 : status === 'running' ? 42 : 100
        return Response.json({ id: 'gen3d_1', status, progress, ...(status === 'success' ? jobResult : {}) })
      }
      if (url.pathname === '/model.glb') {
        return new Response(new Uint8Array([103, 108, 84, 70]))
      }
      return Response.json({ error: { message: `unrouted ${url.pathname}` } }, 404)
    },
  })
  base = `http://127.0.0.1:${server.port}`
}

function deps(overrides: Record<string, unknown> = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    deps: {
      env: { AI_PROXY_URL: base, AI_PROXY_TOKEN: 'pt' },
      cwd: work,
      sleep: async () => {},
      pollIntervalMs: 0,
      stdout: (s: string) => stdout.push(s),
      stderr: (s: string) => stderr.push(s),
      ...overrides,
    },
  }
}

function generationBody(): any {
  return captured.find((c) => c.path === '/v1/3d/generations')?.body
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'shogo-3d-cli-'))
  mkdirSync(join(work, 'refs'), { recursive: true })
  writeFileSync(join(work, 'refs/front.png'), 'front')
  writeFileSync(join(work, 'refs/left.png'), 'left')
  writeFileSync(join(work, 'refs/back.png'), 'back')
  writeFileSync(join(work, 'refs/right.png'), 'right')
  writeFileSync(join(work, 'models-src.glb'), 'glb')
  captured = []
  jobStatuses = ['success']
  submitStatus = 200
  submitBody = {}
  startStub()
  jobResult = { model_url: `${base}/model.glb`, credits_consumed: 20, billed_usd: 0.24, op: 'text_to_model' }
})

afterEach(() => {
  server?.stop(true)
  server = null
  rmSync(work, { recursive: true, force: true })
})

// =========================================================================
// Help and dispatch
// =========================================================================

describe('command surface', () => {
  test('`shogo --help` lists the 3d command', async () => {
    const proc = Bun.spawnSync(['bun', '--conditions=development', join(BIN_DIR, 'shogo.ts'), '--help'], {
      env: { ...process.env, LINKED_FOLDERS: '' },
      cwd: SDK_DIR,
    })
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString()).toContain('3d <subcommand>')
  })

  test('`shogo 3d --help` prints every subcommand', async () => {
    const { deps: d, stdout } = deps()
    expect(await runThreeDCommand(['help'], {}, d)).toBe(0)
    const text = stdout.join('')
    for (const command of THREE_D_COMMANDS) expect(text).toContain(`shogo 3d ${command}`)
  })

  test('an unknown subcommand exits non-zero', async () => {
    const { deps: d, stderr } = deps()
    expect(await runThreeDCommand(['stylize'], {}, d)).toBe(1)
    expect(stderr.join('')).toContain('Unknown 3d subcommand')
    expect(captured).toHaveLength(0)
  })

  test('missing proxy env exits 2 and makes no request', async () => {
    const { deps: d, stderr } = deps({ env: {} })
    expect(await runThreeDCommand(['generate', '--prompt', 'x'], { prompt: 'x' }, d)).toBe(2)
    expect(stderr.join('')).toContain('AI_PROXY_URL / AI_PROXY_TOKEN are unset')
    expect(captured).toHaveLength(0)
  })

  test('the published wrapper and the monorepo entry share the implementation', () => {
    for (const file of ['shogo.ts', 'cli.mjs']) {
      const source = readFileSync(join(BIN_DIR, file), 'utf-8')
      expect(source).toContain("from './three-d-cli.mjs'")
      expect(source).toContain("command === '3d'")
    }
    const help = threeDHelp()
    for (const command of THREE_D_COMMANDS) expect(help).toContain(command)
  })
})

// =========================================================================
// generate
// =========================================================================

describe('shogo 3d generate', () => {
  test('maps prompt, model, texture quality and face limit into the POST body', async () => {
    const { deps: d } = deps()
    const code = await runThreeDCommand(
      ['generate'],
      { prompt: 'a wooden chest', model: 'tripo-p1', 'texture-quality': 'detailed', 'face-limit': '5000', texture: true },
      d,
    )
    expect(code).toBe(0)
    expect(generationBody()).toMatchObject({
      op: 'text_to_model',
      prompt: 'a wooden chest',
      model: 'tripo-p1',
      texture_quality: 'detailed',
      face_limit: 5000,
      texture: true,
    })
  })

  test('--image uploads the file and sends its file token', async () => {
    const { deps: d } = deps()
    await runThreeDCommand(['generate'], { image: 'refs/front.png' }, d)
    expect(captured.find((c) => c.path === '/v1/3d/files')).toBeTruthy()
    expect(generationBody()).toMatchObject({ op: 'image_to_model', image: 'file_uploaded' })
  })

  test('--images uploads all four views in order', async () => {
    const { deps: d } = deps()
    await runThreeDCommand(['generate'], { images: 'refs/front.png,refs/left.png,refs/back.png,refs/right.png' }, d)
    expect(captured.filter((c) => c.path === '/v1/3d/files')).toHaveLength(4)
    expect(generationBody()).toMatchObject({ op: 'multiview_to_model', images: Array(4).fill('file_uploaded') })
  })

  test('rejects a three-view multiview upload before submitting', async () => {
    const { deps: d, stderr } = deps()
    const code = await runThreeDCommand(['generate'], { images: 'a.png,b.png,c.png' }, d)
    expect(code).toBe(1)
    expect(stderr.join('')).toContain('exactly 4')
    expect(captured).toHaveLength(0)
  })

  test('polls queued → running → success and writes the file to --out', async () => {
    jobStatuses = ['queued', 'running', 'success']
    const { deps: d, stderr } = deps()
    const code = await runThreeDCommand(['generate'], { prompt: 'chest', out: 'models/chest.glb' }, d)
    expect(code).toBe(0)
    const saved = join(work, 'models/chest.glb')
    expect(existsSync(saved)).toBe(true)
    expect(readFileSync(saved)).toEqual(Buffer.from([103, 108, 84, 70]))
    expect(stderr.join('')).toContain('running')
  })

  test('defaults the output to models/<op>-<id>.glb', async () => {
    const { deps: d, stdout } = deps()
    await runThreeDCommand(['generate'], { prompt: 'chest' }, d)
    expect(existsSync(join(work, 'models/text_to_model-1.glb'))).toBe(true)
    expect(stdout.join('')).toContain('20 credits')
  })

  test('--json prints a single JSON object', async () => {
    const { deps: d, stdout } = deps()
    const code = await runThreeDCommand(['generate'], { prompt: 'chest', json: true }, d)
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.join(''))
    expect(parsed).toMatchObject({ id: 'gen3d_1', status: 'success', credits_consumed: 20 })
  })
})

// =========================================================================
// edit / status / upload / models
// =========================================================================

describe('shogo 3d edit', () => {
  test('convert forwards the format and writes the matching extension', async () => {
    jobResult = { model_url: `${base}/model.glb`, credits_consumed: 10, billed_usd: 0.12, op: 'convert' }
    const { deps: d } = deps()
    const code = await runThreeDCommand(['edit'], { op: 'convert', input: 'models-src.glb', format: 'USDZ' }, d)
    expect(code).toBe(0)
    expect(generationBody()).toMatchObject({ op: 'convert', input: 'file_uploaded', format: 'USDZ' })
    expect(existsSync(join(work, 'models/convert-1.usdz'))).toBe(true)
  })

  test('a job id input is forwarded without an upload', async () => {
    jobResult = { model_url: `${base}/model.glb`, credits_consumed: 10, billed_usd: 0.12, op: 'retarget' }
    const { deps: d } = deps()
    await runThreeDCommand(['edit'], { op: 'retarget', input: 'gen3d_abc', animations: 'preset:walk,preset:run' }, d)
    expect(captured.some((c) => c.path === '/v1/3d/files')).toBe(false)
    expect(generationBody()).toMatchObject({ op: 'retarget', animations: ['preset:walk', 'preset:run'] })
  })

  test('rig-check maps to rig_check and rig defaults to biped', async () => {
    jobResult = { credits_consumed: 0, billed_usd: 0, op: 'rig_check' }
    const check = deps()
    expect(await runThreeDCommand(['edit'], { op: 'rig-check', input: 'gen3d_abc' }, check.deps)).toBe(0)
    expect(generationBody()).toMatchObject({ op: 'rig_check' })

    captured = []
    jobResult = { model_url: `${base}/model.glb`, credits_consumed: 25, billed_usd: 0.3, op: 'rig' }
    await runThreeDCommand(['edit'], { op: 'rig', input: 'gen3d_abc' }, deps().deps)
    expect(generationBody()).toMatchObject({ op: 'rig', rig_type: 'biped' })
  })

  test('texture sends the prompt and uploads a style image', async () => {
    jobResult = { model_url: `${base}/model.glb`, credits_consumed: 20, billed_usd: 0.24, op: 'texture' }
    await runThreeDCommand(
      ['edit'],
      { op: 'texture', input: 'gen3d_abc', 'texture-prompt': 'oak', 'style-image': 'refs/front.png' },
      deps().deps,
    )
    expect(generationBody()).toMatchObject({
      op: 'texture',
      texture_prompt: { text: 'oak', style_image: 'file_uploaded' },
    })
  })

  test('convert without a supported format exits non-zero', async () => {
    const { deps: d, stderr } = deps()
    expect(await runThreeDCommand(['edit'], { op: 'convert', input: 'gen3d_abc', format: 'STEP' }, d)).toBe(1)
    expect(stderr.join('')).toContain('--format')
    expect(captured).toHaveLength(0)
  })

  test('a failed task exits non-zero and writes no file', async () => {
    jobStatuses = ['running', 'failed']
    jobResult = {}
    const { deps: d, stderr } = deps()
    const code = await runThreeDCommand(['generate'], { prompt: 'chest', out: 'models/chest.glb' }, d)
    expect(code).toBe(1)
    expect(existsSync(join(work, 'models/chest.glb'))).toBe(false)
    expect(stderr.join('')).toContain('failed')
  })
})

describe('shogo 3d status / upload / models', () => {
  test('status downloads the model when one is available', async () => {
    const { deps: d } = deps()
    const code = await runThreeDCommand(['status', 'gen3d_1'], { out: 'out/status.glb' }, d)
    expect(code).toBe(0)
    expect(existsSync(join(work, 'out/status.glb'))).toBe(true)
  })

  test('upload prints the file token', async () => {
    const { deps: d, stdout } = deps()
    expect(await runThreeDCommand(['upload', 'models-src.glb'], {}, d)).toBe(0)
    expect(stdout.join('').trim()).toBe('file_uploaded')
  })

  test('models prints a price table by default, prices read from the route', async () => {
    const { deps: d, stdout } = deps()
    expect(await runThreeDCommand(['models'], {}, d)).toBe(0)
    const text = stdout.join('')
    expect(text).toContain('tripo-v3.1')
    expect(text).toContain('$0.24')
    expect(text).toContain('$0.12')
    expect(text).toMatch(/rig_check\s+free/)
    expect(text).toMatch(/rig\s+25 credits/)
  })

  test('models lists the catalog as JSON', async () => {
    const { deps: d, stdout } = deps()
    expect(await runThreeDCommand(['models'], { json: true }, d)).toBe(0)
    expect(JSON.parse(stdout.join('')).models[0].id).toBe('tripo-v3.1')
  })

  test('a proxy error is surfaced as a non-zero exit', async () => {
    submitStatus = 402
    submitBody = { error: { message: 'Out of usage credit.', code: 'usage_limit' } }
    const { deps: d, stderr } = deps()
    expect(await runThreeDCommand(['generate'], { prompt: 'chest' }, d)).toBe(1)
    expect(stderr.join('')).toContain('Out of usage credit')
  })
})
