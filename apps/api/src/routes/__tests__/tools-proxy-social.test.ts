// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the social media proxy route additions in SHO-465.
 *
 * Uses the real test DB (setupChannelsTestDb) so the Prisma client is real
 * and we exercise the actual `socialCapabilityDenied` path.
 *
 * Run: bun test apps/api/src/routes/__tests__/tools-proxy-social.test.ts
 */

import { beforeAll, afterAll, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const db = prisma as any

// ---------------------------------------------------------------------------
// Module-level mocks (must be before tools-proxy import)
// ---------------------------------------------------------------------------

import { mock } from 'bun:test'

mock.module('../../lib/ai-proxy-token', () => ({
  verifyProxyToken: mock((token: string) => {
    const map: Record<string, { projectId: string; workspaceId: string; userId: string }> = {}
    return Promise.resolve(map[token] ?? null)
  }),
}))

mock.module('../../lib/cloud-forwarding', () => ({
  isShogoCloudAuthed: () => false,
}))

mock.module('../../services/billing.service', () => ({
  checkUsageBalance: mock(() => Promise.resolve({ ok: true })),
  consumeUsage: mock(() => Promise.resolve({ success: true, remainingIncludedUsd: 10 })),
  usageLimitErrorPayload: mock((r: string) => ({ code: r, message: r })),
}))

mock.module('../../services/social-content', () => ({
  getSocialContentProvider: mock(() =>
    Promise.resolve({
      searchPosts: mock(() => Promise.resolve({ results: [], queryUsed: '#aiagents' })),
      getProfile: mock(() => Promise.resolve({ providerUserId: 'u1', bio: '', displayName: 'Test' })),
      listRecentPosts: mock(() => Promise.resolve([])),
      creatorBaseline: mock(() => Promise.resolve({ medianViews: null, sample: 0 })),
    }),
  ),
  SocialProviderError: class extends Error {
    constructor(public code: string, msg: string) { super(msg) }
  },
}))

mock.module('../../services/social-content/outlier', () => ({
  outlierScore: (v: number, m: number | null) => (m ? Math.round((v / m) * 100) / 100 : null),
  median: (values: number[]) => {
    if (!values.length) return null
    const s = [...values].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
  },
}))

const { toolsProxyRoutes } = await import('../tools-proxy')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let wsId = ''
let projId = ''
let wsNoSocial = ''

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const ws = await db.workspace.create({
    data: {
      name: `Social-Test-${suffix}`,
      slug: `social-test-${suffix}`,
      kind: 'team',
      settings: JSON.stringify({ socialMediaEnabled: true, socialTiktokEnabled: true, socialInstagramEnabled: true }),
    },
  })
  wsId = ws.id
  const proj = await db.project.create({
    data: {
      workspaceId: wsId,
      name: 'SocialProj',
      settings: JSON.stringify({ socialMediaEnabled: true, socialTiktokEnabled: true, socialInstagramEnabled: true }),
    },
  })
  projId = proj.id

  const wsNS = await db.workspace.create({ data: { name: `NoSocial-${suffix}`, slug: `no-social-${suffix}`, kind: 'team' } })
  wsNoSocial = wsNS.id
})

afterAll(async () => {
  if (projId) await db.project.delete({ where: { id: projId } }).catch(() => {})
  if (wsId) await db.workspace.delete({ where: { id: wsId } }).catch(() => {})
  if (wsNoSocial) await db.workspace.delete({ where: { id: wsNoSocial } }).catch(() => {})
})

function makeJwt(projectId: string, workspaceId: string): string {
  return `tok:${projectId}:${workspaceId}`
}

// Point mock verifyProxyToken to our synthetic tokens
const { verifyProxyToken } = await import('../../lib/ai-proxy-token') as any

function request(platform: string, op: string, body: Record<string, unknown>, projectId: string, workspaceId: string) {
  const tokenStr = makeJwt(projectId, workspaceId)
  verifyProxyToken.mockImplementation((token: string) => {
    if (token === tokenStr) return Promise.resolve({ projectId, workspaceId, userId: 'user-1' })
    return Promise.resolve(null)
  })
  const router = toolsProxyRoutes()
  return router.fetch(new Request(`http://localhost/tools/social/${platform}/${op}`, {
    method: 'POST',
    headers: { 'x-api-key': tokenStr, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

// ---------------------------------------------------------------------------
// Validation tests (do not need real DB)
// ---------------------------------------------------------------------------

describe('tools-proxy social — validation', () => {
  test('400 when query is missing for search', async () => {
    const res = await request('tiktok', 'search', { limit: 10 }, projId || 'p', wsId || 'w')
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toContain('query')
  })

  test('400 on unknown platform', async () => {
    const res = await request('youtube', 'search', { query: 'test' }, projId || 'p', wsId || 'w')
    expect(res.status).toBe(400)
  })

  test('400 on unknown op', async () => {
    const res = await request('tiktok', 'viral', { query: 'test' }, projId || 'p', wsId || 'w')
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Sentinel + missing-project regression tests (need real DB)
// ---------------------------------------------------------------------------

describe('tools-proxy social — sentinel + missing-project regression (SHO-465)', () => {
  test("workspace sentinel projectId succeeds when workspace has social on", async () => {
    const res = await request('tiktok', 'search', { query: '#aiagents' }, 'workspace', wsId)
    // Should not 403 "Project not found"
    expect(res.status).not.toBe(403)
    expect(res.status).toBe(200)
  })

  test("workspace sentinel projectId 403 when workspace has social disabled", async () => {
    const res = await request('tiktok', 'search', { query: '#aiagents' }, 'workspace', wsNoSocial)
    expect(res.status).toBe(403)
    const body = await res.json() as any
    // Error message must reference workspace, NOT "Project not found"
    expect(body.error).not.toBe('Project not found')
    expect(body.error).toContain('workspace')
  })

  test("stale projectId (project deleted) falls back to workspace and succeeds", async () => {
    const res = await request('tiktok', 'search', { query: '#aiagents' }, 'deleted-proj-xyz', wsId)
    expect(res.status).toBe(200)
  })

  test("api-key sentinel succeeds when workspace has social on", async () => {
    const res = await request('tiktok', 'search', { query: '#aiagents' }, 'api-key', wsId)
    expect(res.status).toBe(200)
  })

  test("recent_posts with workspace sentinel returns 200 (not 'Project not found')", async () => {
    const res = await request('tiktok', 'posts', { handle: 'creator', limit: 5 }, 'workspace', wsId)
    expect(res.status).toBe(200)
  })
})

describe('tools-proxy social — search response shape', () => {
  test('returns correct top-level shape', async () => {
    const { getSocialContentProvider } = await import('../../services/social-content') as any
    getSocialContentProvider.mockImplementation(() =>
      Promise.resolve({
        searchPosts: mock(() =>
          Promise.resolve({
            results: [{
              providerPostId: 'v1', url: 'https://www.tiktok.com/@creator/video/v1',
              caption: 'Tutorial', postedAt: new Date(1700000000 * 1000),
              views: 50000, likes: 1000, comments: 50, shares: 20,
              creator: { handle: 'creator', userId: 'u1', followers: 100000 },
              durationSec: 30,
            }],
            queryUsed: 'ai agents',
          }),
        ),
        creatorBaseline: mock(() => Promise.resolve({ medianViews: null, sample: 0 })),
      })
    )
    const res = await request('tiktok', 'search', { query: 'ai agents' }, projId, wsId)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.platform).toBe('tiktok')
    expect(Array.isArray(body.results)).toBe(true)
    expect(body.results[0].creator_handle).toBe('creator')
    expect(body.results[0].followers).toBe(100000)
    expect(body.results[0].duration_sec).toBe(30)
    expect(typeof body.query_used).toBe('string')
  })
})
