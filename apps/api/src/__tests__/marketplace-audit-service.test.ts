// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for `services/marketplace-audit.service.ts` (Phase 7).
 *
 * The service makes a single `fetch` call to Anthropic's `/v1/messages`
 * endpoint. We monkey-patch `globalThis.fetch` so each test owns the
 * exact JSON body the model "returned", and verify:
 *
 *   - happy path (passed/flagged/errored classification),
 *   - JSON-with-fences gets stripped,
 *   - malformed JSON → errored,
 *   - HTTP non-200 → errored with `raw` populated,
 *   - empty snapshot short-circuits without calling fetch,
 *   - findings get sanitized (bad category → 'other', bad severity → 'medium').
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// ─── prisma mock so recordVersionAudit doesn't blow up if reached ──

let updates: any[] = []
const versionFinds: Record<string, any> = {}
const prismaStub: any = {
  marketplaceListingVersion: {
    update: async (args: any) => {
      updates.push(args)
      return { id: args.where.id, ...args.data }
    },
    findUnique: async (args: any) => versionFinds[args.where.id] ?? null,
  },
}
mock.module('../lib/prisma', () => withPrismaExports({ prisma: prismaStub }))

// Mock the snapshot storage so the S3 fallback path is observable.
let loadSnapshotImpl: (key: string) => Promise<Record<string, unknown>> = async () => ({})
mock.module('../services/marketplace-snapshot-storage.service', () => ({
  loadSnapshotFiles: async (key: string, _checksum?: string | null) => loadSnapshotImpl(key),
}))

const audit = await import('../services/marketplace-audit.service')

// ─── fetch shim ────────────────────────────────────────────────────

let fetchResponse: { ok: boolean; status: number; body: string } = {
  ok: true,
  status: 200,
  body: '',
}
let fetchCallCount = 0

const originalFetch = globalThis.fetch
beforeEach(() => {
  updates = []
  fetchCallCount = 0
  fetchResponse = { ok: true, status: 200, body: '' }
  process.env.ANTHROPIC_API_KEY = 'test-key'
  globalThis.fetch = (async () => {
    fetchCallCount++
    return {
      ok: fetchResponse.ok,
      status: fetchResponse.status,
      text: async () => fetchResponse.body,
      json: async () => ({
        content: [{ type: 'text', text: fetchResponse.body }],
      }),
    }
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.ANTHROPIC_API_KEY
})

// ─── auditWorkspaceSnapshot ────────────────────────────────────────

describe('auditWorkspaceSnapshot', () => {
  test('returns passed when snapshot is empty (no fetch call)', async () => {
    const result = await audit.auditWorkspaceSnapshot({})
    expect(result.status).toBe('passed')
    expect(result.findings).toEqual([])
    expect(fetchCallCount).toBe(0)
  })

  test('passed when model returns empty findings', async () => {
    fetchResponse.body = JSON.stringify({ findings: [] })
    const result = await audit.auditWorkspaceSnapshot({
      files: { 'a.ts': 'export const x = 1' },
    })
    expect(result.status).toBe('passed')
    expect(result.findings).toEqual([])
    expect(fetchCallCount).toBe(1)
  })

  test('flagged when model returns findings', async () => {
    fetchResponse.body = JSON.stringify({
      findings: [
        {
          category: 'secret',
          severity: 'high',
          path: '.env',
          message: 'Looks like an API key',
          excerpt: 'sk-***',
        },
      ],
    })
    const result = await audit.auditWorkspaceSnapshot({
      files: { '.env': 'API_KEY=sk-1234' },
    })
    expect(result.status).toBe('flagged')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].category).toBe('secret')
  })

  test('strips ```json``` code fences before parsing', async () => {
    fetchResponse.body = '```json\n{"findings":[]}\n```'
    const result = await audit.auditWorkspaceSnapshot({
      files: { 'a.ts': 'x' },
    })
    expect(result.status).toBe('passed')
  })

  test('malformed JSON yields errored with raw kept', async () => {
    fetchResponse.body = 'not json at all'
    const result = await audit.auditWorkspaceSnapshot({
      files: { 'a.ts': 'x' },
    })
    expect(result.status).toBe('errored')
    expect(result.raw).toBe('not json at all')
  })

  test('HTTP non-200 yields errored', async () => {
    fetchResponse = { ok: false, status: 500, body: 'upstream down' }
    const result = await audit.auditWorkspaceSnapshot({
      files: { 'a.ts': 'x' },
    })
    expect(result.status).toBe('errored')
  })

  test('coerces invalid category/severity to defaults', async () => {
    fetchResponse.body = JSON.stringify({
      findings: [
        { category: 'made_up', severity: 'lol', message: 'still a finding' },
      ],
    })
    const result = await audit.auditWorkspaceSnapshot({
      files: { 'a.ts': 'x' },
    })
    expect(result.status).toBe('flagged')
    expect(result.findings[0].category).toBe('other')
    expect(result.findings[0].severity).toBe('medium')
  })

  test('drops findings with no message', async () => {
    fetchResponse.body = JSON.stringify({
      findings: [
        { category: 'secret', severity: 'high' },
        { category: 'secret', severity: 'high', message: 'kept' },
      ],
    })
    const result = await audit.auditWorkspaceSnapshot({
      files: { 'a.ts': 'x' },
    })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].message).toBe('kept')
  })

  test('throws clear error when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const result = await audit.auditWorkspaceSnapshot({
      files: { 'a.ts': 'x' },
    })
    expect(result.status).toBe('errored')
    expect(result.raw).toContain('ANTHROPIC_API_KEY')
  })
})

// ─── auditListingVersion ──────────────────────────────────────────

describe('auditListingVersion', () => {
  test('throws version_not_found when row missing', async () => {
    await expect(audit.auditListingVersion('vid_x', null)).rejects.toThrow(
      'version_not_found',
    )
  })

  test('persists audit result onto the version row (legacy JSON path)', async () => {
    versionFinds['vid_1'] = {
      workspaceSnapshot: { files: { 'a.ts': 'export const x = 1' } },
      workspaceSnapshotKey: null,
    }
    fetchResponse.body = JSON.stringify({ findings: [] })
    const result = await audit.auditListingVersion('vid_1', 'admin_user')
    expect(result.status).toBe('passed')
    expect(updates).toHaveLength(1)
    expect(updates[0].where.id).toBe('vid_1')
    expect(updates[0].data.auditStatus).toBe('passed')
    expect(updates[0].data.auditedBy).toBe('admin_user')
    expect(updates[0].data.auditModel).toBe('claude-haiku-4-5')
  })

  test('S3 path: pulls files via loadSnapshotFiles when workspaceSnapshotKey is set', async () => {
    versionFinds['vid_s3'] = {
      workspaceSnapshot: null,
      workspaceSnapshotKey: 'marketplace/listings/lst/1.0.0.tar.gz',
      workspaceSnapshotChecksum: 'sha256-abc',
    }
    let observedKey = ''
    loadSnapshotImpl = async (key) => {
      observedKey = key
      return { 'a.ts': 'export const x = 1' }
    }
    fetchResponse.body = JSON.stringify({ findings: [] })
    const result = await audit.auditListingVersion('vid_s3', null)
    expect(observedKey).toBe('marketplace/listings/lst/1.0.0.tar.gz')
    expect(result.status).toBe('passed')
  })

  test('S3 fetch failure surfaces as auditStatus=errored, persists to row', async () => {
    versionFinds['vid_s3_err'] = {
      workspaceSnapshot: null,
      workspaceSnapshotKey: 'marketplace/listings/lst/1.0.0.tar.gz',
    }
    loadSnapshotImpl = async () => {
      throw new Error('s3 down')
    }
    const result = await audit.auditListingVersion('vid_s3_err', null)
    expect(result.status).toBe('errored')
    expect(result.raw).toContain('s3 down')
    expect(updates[0].data.auditStatus).toBe('errored')
  })
})
