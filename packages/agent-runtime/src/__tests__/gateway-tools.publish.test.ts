// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the agent-facing `publish` tool (createPublishTool in
 * gateway-tools.ts). Covers:
 *   - first-publish gating: no subdomain → needs_subdomain (no deploy)
 *   - first publish with a subdomain (normalised) → deploys + verifies
 *   - republish: omit subdomain → reuses the live one (republished: true)
 *   - structured failure mapping (subdomain_taken / invalid_subdomain / generic)
 *   - live-URL verification (2xx → verified, 5xx → verified:false note)
 *
 * The internal-api publish wrappers and global fetch are faked so no network /
 * build pipeline runs.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync } from 'fs'
import * as realInternalApi from '../internal-api'
import type { ToolContext } from '../gateway-tools'

const TEST_DIR = '/tmp/test-gateway-tools-publish'
mkdirSync(TEST_DIR, { recursive: true })

let getPublishStateImpl: (projectId: string) => Promise<any>
let publishProjectImpl: (projectId: string, opts: any) => Promise<any>
let publishCalls: Array<{ projectId: string; opts: any }> = []

mock.module('../internal-api', () => ({
  ...realInternalApi,
  getPublishState: (projectId: string) => getPublishStateImpl(projectId),
  publishProject: (projectId: string, opts: any) => {
    publishCalls.push({ projectId, opts })
    return publishProjectImpl(projectId, opts)
  },
}))

const { createTools } = await import('../gateway-tools')

function baseCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'p1',
    ...over,
  } as ToolContext
}

function publishTool(ctx: ToolContext) {
  const t = createTools(ctx).find((x) => x.name === 'publish')
  if (!t) throw new Error('publish tool not found')
  return t
}

async function run(ctx: ToolContext, params: Record<string, any> = {}) {
  const r = await publishTool(ctx).execute('cid', params)
  return r.details as any
}

const STATE_UNPUBLISHED = {
  ok: true,
  status: 200,
  data: {
    published: false,
    subdomain: null,
    publishedAt: null,
    accessLevel: null,
    hasPassword: false,
    publishStatus: null,
  },
}

let fetchStatus = 200
let fetchThrows = false
const origFetch = globalThis.fetch

beforeEach(() => {
  publishCalls = []
  getPublishStateImpl = async () => STATE_UNPUBLISHED
  publishProjectImpl = async (_p, o) => ({
    ok: true,
    status: 200,
    data: { url: `https://${o.subdomain}.shogo.one`, subdomain: o.subdomain },
  })
  fetchStatus = 200
  fetchThrows = false
  globalThis.fetch = (async () => {
    if (fetchThrows) throw new Error('net')
    return new Response('ok', { status: fetchStatus })
  }) as any
})

afterEach(() => {
  globalThis.fetch = origFetch
})

describe('publish tool', () => {
  test('returns an error when there is no project context', async () => {
    const details = await run(baseCtx({ projectId: undefined as any }))
    expect(details.error).toMatch(/no project context/i)
    expect(publishCalls).toHaveLength(0)
  })

  test('first publish without a subdomain asks for confirmation (no deploy)', async () => {
    const details = await run(baseCtx(), {})
    expect(details.needs_subdomain).toBe(true)
    expect(details.hint).toMatch(/confirm the subdomain/i)
    expect(publishCalls).toHaveLength(0)
  })

  test('first publish normalises the subdomain, deploys, verifies, and returns the live URL', async () => {
    const details = await run(baseCtx(), {
      subdomain: '  My-Site  ',
      access_level: 'password',
      password: 'hunter2',
      site_title: 'My Site',
      site_description: 'desc',
    })
    expect(publishCalls).toHaveLength(1)
    expect(publishCalls[0]).toEqual({
      projectId: 'p1',
      opts: {
        subdomain: 'my-site',
        accessLevel: 'password',
        password: 'hunter2',
        siteTitle: 'My Site',
        siteDescription: 'desc',
      },
    })
    expect(details).toMatchObject({
      ok: true,
      published: true,
      url: 'https://my-site.shogo.one',
      subdomain: 'my-site',
      republished: false,
      verified: true,
    })
    expect(details.note).toMatch(/live at https:\/\/my-site\.shogo\.one/i)
  })

  test('republish reuses the existing subdomain when none is supplied', async () => {
    getPublishStateImpl = async () => ({
      ...STATE_UNPUBLISHED,
      data: { ...STATE_UNPUBLISHED.data, published: true, subdomain: 'existing-site' },
    })
    const details = await run(baseCtx(), {})
    expect(publishCalls).toHaveLength(1)
    expect(publishCalls[0].opts.subdomain).toBe('existing-site')
    expect(details.republished).toBe(true)
    expect(details.url).toBe('https://existing-site.shogo.one')
  })

  test('maps subdomain_taken to an actionable error and does not claim success', async () => {
    publishProjectImpl = async () => ({ ok: false, status: 409, code: 'subdomain_taken' })
    const details = await run(baseCtx(), { subdomain: 'taken' })
    expect(details.ok).toBeUndefined()
    expect(details.code).toBe('subdomain_taken')
    expect(details.error).toMatch(/already in use/i)
  })

  test('maps invalid_subdomain to an actionable error', async () => {
    publishProjectImpl = async () => ({
      ok: false,
      status: 400,
      code: 'invalid_subdomain',
      error: 'too short',
    })
    const details = await run(baseCtx(), { subdomain: 'x' })
    expect(details.code).toBe('invalid_subdomain')
    expect(details.error).toMatch(/not a valid subdomain/i)
  })

  test('passes through a generic failure (code + status)', async () => {
    publishProjectImpl = async () => ({
      ok: false,
      status: 402,
      code: 'plan_required',
      error: 'Upgrade required',
    })
    const details = await run(baseCtx(), { subdomain: 'foo' })
    expect(details).toMatchObject({ error: 'Upgrade required', code: 'plan_required', status: 402 })
  })

  test('reports verified:false (with a propagation note) when the live URL is not yet serving', async () => {
    fetchStatus = 503
    const details = await run(baseCtx(), { subdomain: 'cold' })
    expect(details.ok).toBe(true)
    expect(details.verified).toBe(false)
    expect(details.note).toMatch(/did not respond to a verification fetch/i)
  }, 15000)

  test('treats a gated (401/403) live site as verified — published but access-controlled', async () => {
    fetchStatus = 401
    const details = await run(baseCtx(), { subdomain: 'private-site' })
    expect(details.verified).toBe(true)
  })
})
