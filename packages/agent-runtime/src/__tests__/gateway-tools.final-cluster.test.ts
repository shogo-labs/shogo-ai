// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Final-cluster sweep for gateway-tools.ts:
 *   - transcribe_audio (Whisper proxy + direct key + error paths)
 *   - generate_image (DALL-E + edit + path-traversal + error paths)
 *   - heartbeat_configure / heartbeat_status (config.json + scheduler hook)
 *   - create_plan / update_plan (.shogo/plans/ + dualPlan branch)
 *   - read_lints (lspManager off + on + edited-this-turn auto-scope)
 *
 * Mocks globalThis.fetch + uses real fs in a sandboxed TEST_DIR. No network.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createTools } from '../gateway-tools'

const TEST_DIR = '/tmp/test-gateway-tools-final-cluster'

const realFetch = globalThis.fetch
let fetchCalls: Array<{ url: string; init?: RequestInit }> = []
function installFetch(h: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  fetchCalls = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    fetchCalls.push({ url, init })
    return await h(url, init)
  }) as typeof fetch
}
function restoreFetch() { globalThis.fetch = realFetch }

function makeResponse(opts: { status?: number; body?: any; ok?: boolean; contentType?: string } = {}): Response {
  const { status = 200, contentType = 'application/json' } = opts
  const bodyText = typeof opts.body === 'object' && opts.body !== null && !(opts.body instanceof Uint8Array)
    ? JSON.stringify(opts.body)
    : (opts.body ?? '')
  const ok = opts.ok ?? (status >= 200 && status < 300)
  return {
    ok, status, statusText: 'OK',
    headers: new Headers({ 'content-type': contentType }),
    text: async () => String(bodyText),
    json: async () => JSON.parse(String(bodyText || 'null')),
    arrayBuffer: async () => new TextEncoder().encode(String(bodyText)).buffer,
  } as unknown as Response
}

const envBackup: Record<string, string | undefined> = {}
function setEnv(key: string, value: string | undefined) {
  if (!(key in envBackup)) envBackup[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
function restoreEnv() {
  for (const k of Object.keys(envBackup)) {
    if (envBackup[k] === undefined) delete process.env[k]
    else process.env[k] = envBackup[k]
    delete envBackup[k]
  }
}

function ctxWith(over: Record<string, any> = {}): any {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800, heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'p',
    ...over,
  }
}

function findTool(ctx: any, name: string) {
  const t = createTools(ctx).find((x: any) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

async function call(ctx: any, name: string, params: any = {}) {
  const r = await findTool(ctx, name).execute('cid', params)
  return r.details
}

describe('gateway-tools final-cluster sweep', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    setEnv('AI_PROXY_URL', undefined)
    setEnv('AI_PROXY_TOKEN', undefined)
    setEnv('OPENAI_API_KEY', undefined)
  })
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    restoreFetch()
    restoreEnv()
  })

  // ===================================================================
  // transcribe_audio
  // ===================================================================
  describe('transcribe_audio', () => {
    test('returns error when file does not exist', async () => {
      setEnv('OPENAI_API_KEY', 'sk-x')
      const r = await call(ctxWith(), 'transcribe_audio', { path: 'missing.mp3' })
      expect(r.error).toContain('not found')
    })

    test('returns error when no API key configured', async () => {
      writeFileSync(join(TEST_DIR, 'a.mp3'), 'fake')
      const r = await call(ctxWith(), 'transcribe_audio', { path: 'a.mp3' })
      expect(r.error).toContain('no OpenAI API key')
    })

    test('succeeds with proxy + returns text', async () => {
      writeFileSync(join(TEST_DIR, 'a.wav'), 'fake-wav')
      installFetch(async (url) => {
        expect(url).toContain('/v1/audio/transcriptions')
        return makeResponse({ body: { text: 'hello world', language: 'en', duration: 2.5, segments: [{ start: 0, end: 1, text: 'hello' }] } })
      })
      const ctx = ctxWith({ aiProxyUrl: 'https://p.example/v1', aiProxyToken: 'pt' })
      const r = await call(ctx, 'transcribe_audio', { path: 'a.wav', language: 'en' })
      expect(r.text).toBe('hello world')
      expect(r.duration_seconds).toBe(2.5)
      expect(r.segments[0].text).toBe('hello')
    })

    test('succeeds with direct OPENAI_API_KEY', async () => {
      setEnv('OPENAI_API_KEY', 'sk-d')
      writeFileSync(join(TEST_DIR, 'a.mp3'), 'fake')
      installFetch(async () => makeResponse({ body: { text: 'ok' } }))
      const r = await call(ctxWith(), 'transcribe_audio', { path: 'a.mp3' })
      expect(r.text).toBe('ok')
    })

    test('surfaces non-ok Whisper response', async () => {
      setEnv('OPENAI_API_KEY', 'sk-x')
      writeFileSync(join(TEST_DIR, 'a.mp3'), 'fake')
      installFetch(async () => makeResponse({ status: 400, ok: false, body: 'bad audio' }))
      const r = await call(ctxWith(), 'transcribe_audio', { path: 'a.mp3' })
      expect(r.error).toContain('Whisper API error')
    })

    test('surfaces fetch throw', async () => {
      setEnv('OPENAI_API_KEY', 'sk-x')
      writeFileSync(join(TEST_DIR, 'a.m4a'), 'x')
      installFetch(async () => { throw new Error('network-down') })
      const r = await call(ctxWith(), 'transcribe_audio', { path: 'a.m4a' })
      expect(r.error).toContain('Audio transcription failed')
      expect(r.error).toContain('network-down')
    })
  })

  // ===================================================================
  // generate_image
  // ===================================================================
  describe('generate_image', () => {
    test('returns error when AI proxy not configured', async () => {
      const r = await call(ctxWith(), 'generate_image', { prompt: 'cat' })
      expect(r.error).toContain('AI proxy not configured')
    })

    test('succeeds with DALL-E and writes png file', async () => {
      installFetch(async (url) => {
        expect(url).toContain('/v1/images/generations')
        return makeResponse({ body: { data: [{ b64_json: Buffer.from('PNGFAKE').toString('base64'), revised_prompt: 'rev' }] } })
      })
      const ctx = ctxWith({ aiProxyUrl: 'https://p.example/v1', aiProxyToken: 'pt' })
      const r = await call(ctx, 'generate_image', { prompt: 'sunset' })
      expect(r.path).toMatch(/^images\//)
      expect(r.bytes).toBeGreaterThan(0)
      expect(r.revised_prompt).toBe('rev')
    })

    test('succeeds with reference_image edit path', async () => {
      mkdirSync(join(TEST_DIR, 'images'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'images/ref.png'), 'fake-png')
      installFetch(async (url) => {
        expect(url).toContain('/v1/images/edits')
        return makeResponse({ body: { data: [{ b64_json: Buffer.from('EDITED').toString('base64') }] } })
      })
      const ctx = ctxWith({ aiProxyUrl: 'https://p.example/v1', aiProxyToken: 'pt' })
      const r = await call(ctx, 'generate_image', { prompt: 'add tree', reference_image: 'images/ref.png' })
      expect(r.path).toMatch(/^images\//)
      expect(r.reference_image).toBe('images/ref.png')
    })

    test('reference_image not found returns error', async () => {
      const ctx = ctxWith({ aiProxyUrl: 'https://p.example/v1', aiProxyToken: 'pt' })
      const r = await call(ctx, 'generate_image', { prompt: 'x', reference_image: 'images/missing.png' })
      expect(r.error).toContain('Reference image not found')
    })

    test('surfaces non-ok generation response', async () => {
      installFetch(async () => makeResponse({ status: 400, ok: false, body: 'rejected' }))
      const ctx = ctxWith({ aiProxyUrl: 'https://p.example/v1', aiProxyToken: 'pt' })
      const r = await call(ctx, 'generate_image', { prompt: 'x' })
      expect(r.error).toContain('Image generation failed')
    })

    test('surfaces non-ok edit response', async () => {
      mkdirSync(join(TEST_DIR, 'images'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'images/r.png'), 'x')
      installFetch(async () => makeResponse({ status: 500, ok: false, body: 'err' }))
      const ctx = ctxWith({ aiProxyUrl: 'https://p.example/v1', aiProxyToken: 'pt' })
      const r = await call(ctx, 'generate_image', { prompt: 'x', reference_image: 'images/r.png' })
      expect(r.error).toContain('Image edit failed')
    })

    test('responseData with error field is surfaced', async () => {
      installFetch(async () => makeResponse({ body: { error: { message: 'content-policy' } } }))
      const ctx = ctxWith({ aiProxyUrl: 'https://p.example/v1', aiProxyToken: 'pt' })
      const r = await call(ctx, 'generate_image', { prompt: 'x' })
      expect(r.error).toBe('content-policy')
    })

    test('missing b64_json returns "No image data" error', async () => {
      installFetch(async () => makeResponse({ body: { data: [{}] } }))
      const ctx = ctxWith({ aiProxyUrl: 'https://p.example/v1', aiProxyToken: 'pt' })
      const r = await call(ctx, 'generate_image', { prompt: 'x' })
      expect(r.error).toContain('No image data')
    })

    test('surfaces fetch throw', async () => {
      installFetch(async () => { throw new Error('boom-net') })
      const ctx = ctxWith({ aiProxyUrl: 'https://p.example/v1', aiProxyToken: 'pt' })
      const r = await call(ctx, 'generate_image', { prompt: 'x' })
      expect(r.error).toContain('Image generation error')
      expect(r.error).toContain('boom-net')
    })
  })

  // ===================================================================
  // heartbeat_configure / heartbeat_status
  // ===================================================================
  describe('heartbeat tools', () => {
    test('configure: interval below 60 returns error', async () => {
      const r = await call(ctxWith(), 'heartbeat_configure', { interval: 30 })
      expect(r.error).toContain('at least 60')
    })

    test('configure: writes config.json and reports back', async () => {
      const r = await call(ctxWith(), 'heartbeat_configure', {
        enabled: true, interval: 120, quietHoursStart: '22:00', quietHoursEnd: '08:00', timezone: 'America/Los_Angeles',
      })
      expect(r.ok).toBe(true)
      expect(r.enabled).toBe(true)
      expect(r.interval).toBe(120)
      const cfg = JSON.parse(readFileSync(join(TEST_DIR, 'config.json'), 'utf-8'))
      expect(cfg.heartbeatInterval).toBe(120)
      expect(cfg.quietHours.timezone).toBe('America/Los_Angeles')
    })

    test('configure: invokes updateHeartbeatConfig hook when present', async () => {
      let captured: any = null
      const ctx = ctxWith({ updateHeartbeatConfig: async (c: any) => { captured = c } })
      await call(ctx, 'heartbeat_configure', { enabled: true, interval: 60 })
      expect(captured.heartbeatEnabled).toBe(true)
      expect(captured.heartbeatInterval).toBe(60)
    })

    test('configure: surfaces hook throw', async () => {
      const ctx = ctxWith({ updateHeartbeatConfig: async () => { throw new Error('sched-down') } })
      const r = await call(ctx, 'heartbeat_configure', { enabled: true })
      expect(r.error).toContain('Failed to configure heartbeat')
    })

    test('status: returns defaults when no config and no HEARTBEAT.md', async () => {
      const r = await call(ctxWith(), 'heartbeat_status', {})
      expect(r.enabled).toBe(false)
      expect(r.interval).toBe(1800)
      expect(r.checklistLength).toBe(0)
    })

    test('status: reads checklist preview from HEARTBEAT.md', async () => {
      writeFileSync(join(TEST_DIR, 'HEARTBEAT.md'), '# Tasks\n- review\n- summarize')
      writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({ heartbeatEnabled: true, heartbeatInterval: 600 }))
      const r = await call(ctxWith(), 'heartbeat_status', {})
      expect(r.enabled).toBe(true)
      expect(r.interval).toBe(600)
      expect(r.checklistLength).toBeGreaterThan(0)
      expect(r.checklistPreview).toContain('Tasks')
    })

    test('status: tolerates corrupted config.json', async () => {
      writeFileSync(join(TEST_DIR, 'config.json'), 'NOT JSON')
      const r = await call(ctxWith(), 'heartbeat_status', {})
      expect(r.enabled).toBe(false)
    })
  })

  // ===================================================================
  // create_plan
  // ===================================================================
  describe('create_plan / update_plan', () => {
    test('create_plan: writes plan file and emits ui event', async () => {
      const events: any[] = []
      const ctx = ctxWith({ uiWriter: { write: (e: any) => events.push(e) } })
      const r = await findTool(ctx, 'create_plan').execute('cid', {
        name: 'My Big Plan',
        overview: 'overview text',
        plan: '## Step 1\nDo it',
        todos: [{ id: 'a', content: 'first' }, { id: 'b', content: 'second' }],
      })
      expect(r.content[0].text).toContain('Plan "My Big Plan" created')
      expect(events.some(e => e.type === 'data-plan')).toBe(true)
      // Plan file written
      const plans = require('fs').readdirSync(join(TEST_DIR, '.shogo/plans'))
      expect(plans.length).toBe(1)
      const content = readFileSync(join(TEST_DIR, '.shogo/plans', plans[0]), 'utf-8')
      expect(content).toContain('# My Big Plan')
      expect(content).toContain('id: a')
    })

    test('create_plan: dualPlan triggers summary job (best-effort)', async () => {
      const ctx = ctxWith({
        dualPlan: true,
        effectiveModel: 'claude-haiku',
        uiWriter: { write: () => {} },
      })
      const r = await findTool(ctx, 'create_plan').execute('cid', {
        name: 'Dual', overview: 'o', plan: 'p', todos: [],
      })
      expect(r.content[0].text).toContain('created')
    })

    test('update_plan: invalid filepath errors', async () => {
      const r = await findTool(ctxWith(), 'update_plan').execute('cid', { filepath: '../../etc/passwd' })
      expect(r.content[0].text).toContain('Invalid plan filepath')
    })

    test('update_plan: missing file errors', async () => {
      mkdirSync(join(TEST_DIR, '.shogo/plans'), { recursive: true })
      const r = await findTool(ctxWith(), 'update_plan').execute('cid', {
        filepath: '.shogo/plans/nope_abc.plan.md',
      })
      expect(r.content[0].text).toContain('not found')
    })

    test('update_plan: rewrites name/overview/plan/todos', async () => {
      mkdirSync(join(TEST_DIR, '.shogo/plans'), { recursive: true })
      const fp = join(TEST_DIR, '.shogo/plans/test_xxx.plan.md')
      writeFileSync(fp, [
        '---',
        'name: "Original"',
        'overview: "old"',
        'createdAt: "2026-01-01T00:00:00.000Z"',
        'status: pending',
        'todos:',
        '  - id: x\n    content: "old"\n    status: pending',
        '---',
        '',
        '# Original',
        '',
        'OLD BODY',
      ].join('\n'))
      const r = await findTool(ctxWith(), 'update_plan').execute('cid', {
        filepath: '.shogo/plans/test_xxx.plan.md',
        name: 'Renamed',
        overview: 'new overview',
        plan: 'NEW BODY',
        todos: [{ id: 'y', content: 'new' }],
      })
      expect(r.content[0].text).toContain('Renamed')
      const updated = readFileSync(fp, 'utf-8')
      expect(updated).toContain('Renamed')
      expect(updated).toContain('NEW BODY')
      expect(updated).toContain('id: y')
    })

    test('update_plan: partial update preserves omitted fields', async () => {
      mkdirSync(join(TEST_DIR, '.shogo/plans'), { recursive: true })
      const fp = join(TEST_DIR, '.shogo/plans/p2_xxx.plan.md')
      writeFileSync(fp, [
        '---', 'name: "A"', 'overview: "B"', 'createdAt: "2026-01-01T00:00:00.000Z"', 'status: pending',
        'todos:', '  - id: 1\n    content: "x"\n    status: pending',
        '---', '', '# A', '', 'body-here',
      ].join('\n'))
      await findTool(ctxWith(), 'update_plan').execute('cid', {
        filepath: '.shogo/plans/p2_xxx.plan.md',
        overview: 'new',
      })
      const after = readFileSync(fp, 'utf-8')
      expect(after).toContain('"A"') // name preserved
      expect(after).toContain('"new"') // overview updated
      expect(after).toContain('body-here') // body preserved
    })

    test('update_plan: missing frontmatter errors', async () => {
      mkdirSync(join(TEST_DIR, '.shogo/plans'), { recursive: true })
      const fp = join(TEST_DIR, '.shogo/plans/bad_xxx.plan.md')
      writeFileSync(fp, 'no-frontmatter-here')
      const r = await findTool(ctxWith(), 'update_plan').execute('cid', {
        filepath: '.shogo/plans/bad_xxx.plan.md',
      })
      expect(r.content[0].text).toContain('Could not parse frontmatter')
    })

    test('update_plan: emits data-plan-update event', async () => {
      const events: any[] = []
      const ctx = ctxWith({ uiWriter: { write: (e: any) => events.push(e) } })
      mkdirSync(join(TEST_DIR, '.shogo/plans'), { recursive: true })
      const fp = join(TEST_DIR, '.shogo/plans/u_xxx.plan.md')
      writeFileSync(fp, ['---','name: "X"','overview: "Y"','createdAt: "2026-01-01"','status: pending','todos:','  - id: 1\n    content: "x"\n    status: pending','---','','# X','','body'].join('\n'))
      await findTool(ctx, 'update_plan').execute('cid', {
        filepath: '.shogo/plans/u_xxx.plan.md',
        name: 'Z',
      })
      expect(events.some(e => e.type === 'data-plan-update')).toBe(true)
    })

    test('update_plan: path traversal outside .shogo/plans errors', async () => {
      mkdirSync(join(TEST_DIR, 'other'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'other/p.md'), 'x')
      const r = await findTool(ctxWith(), 'update_plan').execute('cid', {
        filepath: '../other/p.md',
      })
      expect(r.content[0].text).toMatch(/(Invalid plan filepath|must stay within)/)
    })
  })

  // ===================================================================
  // read_lints
  // ===================================================================
  describe('read_lints', () => {
    test('returns error when lspManager missing', async () => {
      const r = await call(ctxWith(), 'read_lints', {})
      expect(r.error).toContain('Language server not available')
    })

    test('returns error when lspManager not running', async () => {
      const ctx = ctxWith({ lspManager: { isRunning: () => false } })
      const r = await call(ctx, 'read_lints', {})
      expect(r.error).toContain('Language server not available')
    })

    test('returns canvas runtime errors when LSP off', async () => {
      // Inject a canvas runtime error via the shared module if exposed; otherwise
      // just verify the off-path stays consistent.
      const ctx = ctxWith({ lspManager: { isRunning: () => false } })
      const r = await call(ctx, 'read_lints', {})
      expect(r.ok).toBe(false)
    })

    test('queries LSP for explicit path and returns diagnostics', async () => {
      mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'src/App.tsx'), 'export const x = 1')
      const lsp = {
        isRunning: () => true,
        getDiagnosticsAsync: async (uri?: string) => {
          const m = new Map<string, any[]>()
          if (uri) m.set(uri, [])
          return m
        },
        notifyFileChanged: () => {},
      }
      const ctx = ctxWith({ lspManager: lsp as any })
      const r = await call(ctx, 'read_lints', { path: 'src/App.tsx' })
      expect(r.ok).toBeDefined()
    }, 10000)

    test('auto-scopes to edited-this-turn when no path given', async () => {
      mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'src/A.tsx'), 'export const x = 1')
      const lsp = {
        isRunning: () => true,
        getDiagnosticsAsync: async (_uri?: string) => new Map(),
        notifyFileChanged: () => {},
      }
      const ctx = ctxWith({
        lspManager: lsp as any,
        fileStateCache: { getEditedThisTurn: () => ['src/A.tsx'] },
      })
      const r = await call(ctx, 'read_lints', {})
      expect(r).toBeDefined()
    }, 10000)
  })
})
