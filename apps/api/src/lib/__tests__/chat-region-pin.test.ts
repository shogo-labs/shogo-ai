// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for chat-session region pinning.
 *
 *   bun test apps/api/src/lib/__tests__/chat-region-pin.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

// --- mocks -----------------------------------------------------------------
// project id → workspace id
const projects: Record<string, { workspaceId: string } | null> = {
  p_eu: { workspaceId: 'ws_eu' },
  p_us: { workspaceId: 'ws_us' },
  p_legacy: { workspaceId: 'ws_legacy' },
  p_nopeer: { workspaceId: 'ws_nopeer' },
  p_missing: null,
}

// workspace id → home region
const workspaces: Record<string, { homeRegion: string | null } | null> = {
  ws_eu: { homeRegion: 'eu-frankfurt-1' }, // this region (local)
  ws_us: { homeRegion: 'us-ashburn-1' }, // a configured peer
  ws_legacy: { homeRegion: null }, // legacy / unknown → local
  ws_nopeer: { homeRegion: 'unknown-region-9' }, // known home, no peer configured
}

mock.module('../prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) =>
        id in projects ? projects[id] : null,
    },
    workspace: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) =>
        id in workspaces ? workspaces[id] : null,
    },
  },
}))

const PEERS: Record<string, { id: string; label: string; url: string }> = {
  'us-ashburn-1': { id: 'us-ashburn-1', label: 'US', url: 'https://us.studio.shogo.ai' },
  'ap-mumbai-1': { id: 'ap-mumbai-1', label: 'India', url: 'https://india.studio.shogo.ai' },
}

mock.module('../region', () => ({
  RAW_REGION_ID: 'eu-frankfurt-1',
  getPeer: (id: string) => PEERS[id],
}))

const proxyCalls: Array<{ region: string }> = []
let proxyResponse: Response = new Response('proxied', { status: 200 })
mock.module('../region-peer-proxy', () => ({
  proxyToPeer: async (_c: any, region: string) => {
    proxyCalls.push({ region })
    return proxyResponse
  },
  isProxiedRequest: (c: any) => c.req.header('x-shogo-home-region-proxy') === '1',
}))

const { pinChatToHomeRegion } = await import('../chat-region-pin')

// --- context double --------------------------------------------------------
function makeCtx(opts: { method?: string; path?: string; headers?: Record<string, string> } = {}) {
  const headers = opts.headers ?? {}
  return {
    json: (body: unknown, status?: number) => ({ __json: body, status: status ?? 200 }),
    req: {
      method: opts.method ?? 'GET',
      url: `https://eu.studio.shogo.ai${opts.path ?? '/api/projects/p_us/chat/s1/stream'}`,
      header: (name: string) => headers[name.toLowerCase()],
    },
  } as any
}

const SAVED_PIN = process.env.CHAT_REGION_PIN

beforeEach(() => {
  proxyCalls.length = 0
  proxyResponse = new Response('proxied', { status: 200 })
  delete process.env.CHAT_REGION_PIN
})
afterEach(() => {
  if (SAVED_PIN === undefined) delete process.env.CHAT_REGION_PIN
  else process.env.CHAT_REGION_PIN = SAVED_PIN
})

describe('pinChatToHomeRegion', () => {
  test('handles locally when this region IS the session home region', async () => {
    const res = await pinChatToHomeRegion(makeCtx(), 'p_eu')
    expect(res).toBeNull()
    expect(proxyCalls).toHaveLength(0)
  })

  test('proxies to the peer when the session lives in another region', async () => {
    const res = await pinChatToHomeRegion(makeCtx(), 'p_us')
    expect(proxyCalls).toEqual([{ region: 'us-ashburn-1' }])
    expect(res).toBe(proxyResponse)
  })

  test('does not re-proxy a request already carrying the loop-guard header', async () => {
    const res = await pinChatToHomeRegion(
      makeCtx({ headers: { 'x-shogo-home-region-proxy': '1' } }),
      'p_us',
    )
    expect(res).toBeNull()
    expect(proxyCalls).toHaveLength(0)
  })

  test('handles locally when the project (and thus home region) is unknown', async () => {
    const res = await pinChatToHomeRegion(makeCtx(), 'p_missing')
    expect(res).toBeNull()
    expect(proxyCalls).toHaveLength(0)
  })

  test('handles locally when the workspace homeRegion is null (legacy row)', async () => {
    const res = await pinChatToHomeRegion(makeCtx(), 'p_legacy')
    expect(res).toBeNull()
    expect(proxyCalls).toHaveLength(0)
  })

  test('fails closed (503 retryable) when the home region has no peer configured', async () => {
    const res = (await pinChatToHomeRegion(makeCtx(), 'p_nopeer')) as any
    expect(proxyCalls).toHaveLength(0)
    expect(res.status).toBe(503)
    expect(res.__json?.error?.code).toBe('home_region_unavailable')
    expect(res.__json?.error?.retryable).toBe(true)
  })

  test('maps a proxyToPeer 502 (peer unreachable) to a retryable 503', async () => {
    proxyResponse = new Response('bad gateway', { status: 502 })
    const res = (await pinChatToHomeRegion(makeCtx(), 'p_us')) as any
    expect(proxyCalls).toEqual([{ region: 'us-ashburn-1' }])
    expect(res.status).toBe(503)
    expect(res.__json?.error?.retryable).toBe(true)
  })

  test('kill switch CHAT_REGION_PIN=off disables pinning (serve locally)', async () => {
    process.env.CHAT_REGION_PIN = 'off'
    const res = await pinChatToHomeRegion(makeCtx(), 'p_us')
    expect(res).toBeNull()
    expect(proxyCalls).toHaveLength(0)
  })
})
