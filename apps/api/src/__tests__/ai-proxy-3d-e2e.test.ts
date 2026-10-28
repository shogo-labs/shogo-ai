// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA e2e for SHO-13: the real `shogo 3d` CLI against the real `/ai/v1/3d`
 * route, with only Tripo itself stubbed at the fetch layer.
 *
 * The point is the *contract between the caller and the route*, which unit
 * tests on either side cannot see: `bin/three-d-cli.mjs` builds the bodies and
 * `routes/ai-proxy.ts` validates them per op. Round 1 of QA failed on exactly
 * three mismatches in that seam (upload field name, the retarget animation
 * shape, `format` on a generation op) while both sides' own tests were green.
 *
 * Acceptance criteria covered: 1 (per-op validation), 2 (one wallet row at
 * credits/100 × 1.2, free rig_check), 5 (`generate` then `edit --op convert`
 * both write files), 7 (nothing reaches openapi.tripo3d.ai for real).
 *
 *   bun test apps/api/src/__tests__/ai-proxy-3d-e2e.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { mkdtempSync, existsSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.SHOGO_API_KEY
process.env.TRIPO_API_KEY = 'tripo-test-key'

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'proj-1', name: 'Test' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    usageEvent: { create: async () => ({}) },
  },
}))

const consumeCalls: any[] = []
const billingStub = () => ({
  SYSTEM_WORKSPACE_ID: 'system',
  hasBalance: async () => true,
  checkUsageBalance: async () => ({ ok: true }),
  usageLimitErrorPayload: () => ({ code: 'usage_limit_reached', message: 'limit' }),
  hasAdvancedModelAccess: async () => true,
  consumeUsage: async (args: any) => {
    consumeCalls.push(args)
    return { success: true, remainingIncludedUsd: 100 }
  },
  getSubscription: async () => null,
  getUsageWallet: async () => null,
  getUsageWindows: async () => null,
  ensureSystemWorkspace: async () => ({}),
  hasPaidSubscription: async () => true,
  canRunTechStackOnInstanceSize: async () => ({ ok: true }),
  syncFromStripe: async () => ({}),
  allocateMonthlyIncluded: async () => ({}),
})
mock.module('../services/billing.service', billingStub)
mock.module('../services/billing-runtime', billingStub)

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
const originalFetch = globalThis.fetch
let routes: Array<{ match: (url: string) => boolean; handler: Handler }> = []
let vendorBodies: Array<{ path: string; body: any }> = []

function on(match: string, handler: Handler) {
  routes.push({ match: (url) => url.startsWith(match), handler })
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const TRIPO = 'https://openapi.tripo3d.ai/v3'
const TASK_ID = '11111111-1111-4111-8111-111111111111'
const FILE_TOKEN = 'file_qa123'
const PROXY_ORIGIN = 'http://proxy.test'

const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { runThreeDCommand } = await import('../../../../packages/sdk/bin/three-d-cli.mjs')

const app = new Hono()
app.route('/api', aiProxyRoutes())
let TOKEN: string
beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
})

let cwd: string
beforeEach(() => {
  routes = []
  vendorBodies = []
  consumeCalls.length = 0
  cwd = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'sho13-cli-')))
  // The route calls the vendor through `globalThis.fetch`; the CLI gets
  // `qaFetch` explicitly below. Both land in the same stub table.
  globalThis.fetch = qaFetch as any
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

/**
 * One fetch for both sides: `/api/…` goes into the Hono app (the proxy the CLI
 * talks to), everything else is the stubbed vendor or CDN.
 */
async function qaFetch(input: any, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input.url
  if (url.startsWith(PROXY_ORIGIN)) {
    const { pathname, search } = new URL(url)
    return app.fetch(new Request(`${PROXY_ORIGIN}${pathname}${search}`, init))
  }
  const route = routes.find((r) => r.match(url))
  if (!route) return json({ error: `unrouted ${url}` }, 599)
  return route.handler(url, init)
}

/** Tripo accepting a submit: record the body, answer with a task id. */
let taskResult: Record<string, unknown> = {}
function stubTripo(result: Record<string, unknown> = {}) {
  taskResult = result
  on(`${TRIPO}/`, (url, init) => {
    const path = url.slice(TRIPO.length)
    if (path === '/files') {
      return json({ code: 0, data: { file_token: FILE_TOKEN } })
    }
    if (path.startsWith('/tasks/')) {
      return json({ code: 0, data: { status: 'success', progress: 100, ...taskResult } })
    }
    vendorBodies.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return json({ code: 0, data: { task_id: TASK_ID } })
  })
  on('https://cdn.tripo/', () => new Response(new Uint8Array([103, 108, 84, 70, 1, 2, 3, 4])))
}

async function cli(args: string[]) {
  let out = ''
  let err = ''
  const code = await runThreeDCommand(args, parseFlags(args), {
    env: { AI_PROXY_URL: `${PROXY_ORIGIN}/api/ai/v1`, AI_PROXY_TOKEN: TOKEN },
    cwd,
    fetch: qaFetch,
    stdout: (s: string) => { out += s },
    stderr: (s: string) => { err += s },
    sleep: async () => {},
    pollIntervalMs: 0,
  })
  return { code, out, err }
}

/** Mirrors bin/shogo.ts's parseArgs closely enough for these flags. */
function parseFlags(args: string[]) {
  const flags: Record<string, unknown> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = args[i + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else {
      flags[key] = next
      i++
    }
  }
  return flags
}

const settle = () => new Promise((r) => setTimeout(r, 25))

describe('shogo 3d → /ai/v1/3d end to end', () => {
  test('generate --prompt writes the GLB and bills one wallet row at credits/100 × 1.2', async () => {
    stubTripo({ output: { model_url: 'https://cdn.tripo/qa.glb' }, credits_consumed: 20 })

    const { code, out } = await cli([
      'generate', '--prompt', 'a wooden treasure chest', '--out', 'models/chest.glb', '--json',
    ])
    expect(code).toBe(0)

    // The generation body carries no `convert`-only field.
    expect(vendorBodies).toHaveLength(1)
    expect(vendorBodies[0].path).toBe('/generation/text-to-model')
    expect(vendorBodies[0].body).toMatchObject({ prompt: 'a wooden treasure chest' })
    // `op` is the proxy's own field and `format` belongs to convert only.
    expect(vendorBodies[0].body).not.toHaveProperty('op')
    expect(vendorBodies[0].body).not.toHaveProperty('format')

    expect(existsSync(join(cwd, 'models/chest.glb'))).toBe(true)
    expect(JSON.parse(out)).toMatchObject({ status: 'success', path: 'models/chest.glb', credits_consumed: 20 })

    await settle()
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0]).toMatchObject({ actionType: 'ai_3d_generation' })
    expect(Number(consumeCalls[0].rawCostUsd ?? consumeCalls[0].rawUsd)).toBeCloseTo(0.2, 5)
  })

  test('edit --op convert on a local model uploads it, forwards the format and writes the new extension', async () => {
    stubTripo({ output: { model_url: 'https://cdn.tripo/qa.usdz' }, credits_consumed: 10 })
    writeFileSync(join(cwd, 'chest.glb'), Buffer.from([103, 108, 84, 70, 0, 0, 0, 0]))

    const { code, out } = await cli([
      'edit', '--op', 'convert', '--input', 'chest.glb', '--format', 'USDZ',
      '--out', 'models/chest.usdz', '--json',
    ])
    expect(code).toBe(0)
    expect(existsSync(join(cwd, 'models/chest.usdz'))).toBe(true)

    const convert = vendorBodies.find((b) => b.path === '/models/convert')
    expect(convert?.body).toEqual({ input: FILE_TOKEN, format: 'USDZ' })
    expect(JSON.parse(out)).toMatchObject({ status: 'success', path: 'models/chest.usdz' })

    await settle()
    expect(consumeCalls).toHaveLength(1)
  })

  test('edit --op retarget accepts an animation list and saves the animated model', async () => {
    stubTripo({ output: { model_url: 'https://cdn.tripo/qa-rigged.glb' }, credits_consumed: 20 })

    const { code, out } = await cli([
      'edit', '--op', 'retarget', '--input', TASK_ID,
      '--animations', 'preset:walk,preset:run', '--out', 'models/walk.glb', '--json',
    ])
    expect(code).toBe(0)

    const retarget = vendorBodies.find((b) => b.path === '/animations/retarget')
    expect(retarget?.body).toEqual({
      input: TASK_ID,
      animations: ['preset:walk', 'preset:run'],
    })
    expect(JSON.parse(out)).toMatchObject({ status: 'success', path: 'models/walk.glb' })
  })

  test('edit --op rig-check is free: no wallet row and no file', async () => {
    // Tripo answers a rig check at the envelope level: no output file.
    stubTripo({ riggable: true, rig_type: 'biped', credits_consumed: 0 })

    const { code, out, err } = await cli(['edit', '--op', 'rig-check', '--input', TASK_ID, '--json'])
    expect(code, `out=${out} err=${err}`).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ status: 'success', riggable: true, credits_consumed: 0 })

    await settle()
    expect(consumeCalls).toHaveLength(0)
  })

  test('upload prints the file token the post-process ops need', async () => {
    stubTripo()
    writeFileSync(join(cwd, 'sample.glb'), Buffer.from([103, 108, 84, 70]))
    const { code, out } = await cli(['upload', 'sample.glb', '--json'])
    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual({ file_token: FILE_TOKEN })
  })

  test('models reports per-op credit estimates the agent can budget from', async () => {
    stubTripo()
    // The default output is a price table for humans; --json is the machine form.
    const human = await cli(['models'])
    expect(human.code).toBe(0)
    expect(human.out).toContain('rig_check')
    expect(human.out).toMatch(/rig_check\s+free/)

    const { code, out } = await cli(['models', '--json'])
    expect(code).toBe(0)
    const catalog = JSON.parse(out)
    expect(catalog.models.length).toBeGreaterThan(0)
    expect(catalog.operations).toContainEqual(expect.objectContaining({ op: 'text_to_model', input: 'text' }))
    expect(catalog.operations.find((o: any) => o.op === 'rig_check')).toMatchObject({ estimated_credits: 0 })
    expect(catalog.operations.find((o: any) => o.op === 'convert')).toMatchObject({ estimated_credits: 10 })
  })

  test('a route-level rejection surfaces the message and exits non-zero', async () => {
    stubTripo({ output: { model_url: 'https://cdn.tripo/qa.glb' }, credits_consumed: 20 })
    // `rig` does not accept part_names: the route rejects the op's field
    // allowlist before it submits anything to the vendor.
    const { code, err } = await cli([
      'edit', '--op', 'rig', '--input', TASK_ID, '--part-names', 'torso,head', '--out', 'models/rig.glb',
    ])
    expect(code).toBe(1)
    expect(err.toLowerCase()).toContain('part_names')
    expect(vendorBodies).toHaveLength(0)
  })

  test('without the runtime env the CLI exits 2 before any network call', async () => {
    let called = false
    const code = await runThreeDCommand(['generate', '--prompt', 'x'], { prompt: 'x' }, {
      env: {},
      cwd,
      fetch: (async () => { called = true; return json({}) }) as any,
      stdout: () => {},
      stderr: () => {},
      sleep: async () => {},
    })
    expect(code).toBe(2)
    expect(called).toBe(false)
  })
})
