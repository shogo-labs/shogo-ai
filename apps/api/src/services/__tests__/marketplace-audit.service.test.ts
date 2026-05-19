// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// ─── prisma mock ─────────────────────────────────────────────────────────────
type Version = {
  id: string
  workspaceSnapshot?: any
  workspaceSnapshotKey?: string | null
  workspaceSnapshotChecksum?: string | null
  auditStatus?: string
  auditedAt?: Date
  auditedBy?: string | null
  auditModel?: string
  auditFindings?: any
}
const versions = new Map<string, Version>()
const updateCalls: any[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    marketplaceListingVersion: {
      findUnique: async ({ where, select }: any) => {
        const v = versions.get(where.id)
        if (!v) return null
        if (!select) return v
        const out: any = {}
        for (const k of Object.keys(select)) if (select[k]) out[k] = (v as any)[k]
        return out
      },
      update: async ({ where, data }: any) => {
        updateCalls.push({ where, data })
        const v = versions.get(where.id)
        if (v) Object.assign(v, data)
        return v
      },
    },
  },
}))

// ─── snapshot-storage mock ───────────────────────────────────────────────────
let snapshotLoadImpl: (key: string, checksum: string | null | undefined) => Promise<any> =
  async () => ({ 'a.txt': 'from-s3' })
mock.module('../marketplace-snapshot-storage.service', () => ({
  loadSnapshotFiles: (key: string, checksum: string | null | undefined) => snapshotLoadImpl(key, checksum),
}))

const audit = await import('../marketplace-audit.service')

// ─── fetch stub for Anthropic ─────────────────────────────────────────────────
type FResp = { status?: number; ok?: boolean; jsonBody?: any; textBody?: string }
let fetchResponses: FResp[] = []
const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
const origFetch = globalThis.fetch
let fetchThrows: any = null

function installFetch() {
  ;(globalThis as any).fetch = (async (url: any, init?: any) => {
    fetchCalls.push({ url: String(url), init })
    if (fetchThrows) { const e = fetchThrows; fetchThrows = null; throw e }
    const r = fetchResponses.shift() ?? { ok: true, status: 200, jsonBody: {} }
    const status = r.status ?? 200
    const ok = r.ok ?? (status >= 200 && status < 300)
    return {
      ok, status,
      json: async () => r.jsonBody ?? {},
      text: async () => r.textBody ?? JSON.stringify(r.jsonBody ?? {}),
    } as any
  }) as any
}

beforeEach(() => {
  versions.clear()
  updateCalls.length = 0
  fetchResponses = []
  fetchCalls.length = 0
  fetchThrows = null
  snapshotLoadImpl = async () => ({ 'a.txt': 'from-s3' })
  installFetch()
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
})

afterEach(() => {
  ;(globalThis as any).fetch = origFetch
})

function makeAnthropicReply(jsonStr: string): FResp {
  return {
    ok: true, status: 200,
    jsonBody: { content: [{ type: 'text', text: jsonStr }] },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
describe('auditWorkspaceSnapshot — empty inputs', () => {
  it('returns passed with no findings for null', async () => {
    const r = await audit.auditWorkspaceSnapshot(null)
    expect(r).toEqual({ status: 'passed', model: 'claude-haiku-4-5', findings: [] })
    expect(fetchCalls).toHaveLength(0)
  })
  it('returns passed for non-object inputs', async () => {
    expect((await audit.auditWorkspaceSnapshot('foo')).status).toBe('passed')
    expect((await audit.auditWorkspaceSnapshot([1, 2])).status).toBe('passed')
  })
  it('returns passed for an empty file map', async () => {
    const r = await audit.auditWorkspaceSnapshot({})
    expect(r.status).toBe('passed')
    expect(fetchCalls).toHaveLength(0)
  })
})

describe('auditWorkspaceSnapshot — snapshot rendering', () => {
  it('wraps each file with "=== <path> ===" header', async () => {
    fetchResponses = [makeAnthropicReply('{"findings":[]}')]
    await audit.auditWorkspaceSnapshot({ 'a.txt': 'hello', 'src/b.ts': 'world' })
    const body = JSON.parse(String(fetchCalls[0].init?.body))
    const user = body.messages[0].content
    expect(user).toContain('=== a.txt ===')
    expect(user).toContain('hello')
    expect(user).toContain('=== src/b.ts ===')
    expect(user).toContain('world')
  })

  it('unwraps a { files: ... } envelope', async () => {
    fetchResponses = [makeAnthropicReply('{"findings":[]}')]
    await audit.auditWorkspaceSnapshot({ files: { 'a.txt': 'hi' } })
    const user = JSON.parse(String(fetchCalls[0].init?.body)).messages[0].content
    expect(user).toContain('=== a.txt ===')
    expect(user).toContain('hi')
  })

  it('replaces binary files with a placeholder', async () => {
    fetchResponses = [makeAnthropicReply('{"findings":[]}')]
    await audit.auditWorkspaceSnapshot({
      'img.png': { encoding: 'base64', data: 'AAAA' },
    })
    const user = JSON.parse(String(fetchCalls[0].init?.body)).messages[0].content
    expect(user).toContain('binary file')
    expect(user).toContain('base64 chars')
  })

  it('passes through { encoding!=base64, data:string } as-is', async () => {
    fetchResponses = [makeAnthropicReply('{"findings":[]}')]
    await audit.auditWorkspaceSnapshot({
      'a.txt': { encoding: 'utf8', data: 'plain-text-body' },
    })
    const user = JSON.parse(String(fetchCalls[0].init?.body)).messages[0].content
    expect(user).toContain('plain-text-body')
  })

  it('skips wrapped entries with non-string data', async () => {
    fetchResponses = [makeAnthropicReply('{"findings":[]}')]
    await audit.auditWorkspaceSnapshot({ 'weird.txt': { something: 'else' } })
    // user content is empty → never sent to Anthropic
    expect(fetchCalls).toHaveLength(0)
  })

  it('skips entries with non-string non-object values', async () => {
    fetchResponses = [makeAnthropicReply('{"findings":[]}')]
    await audit.auditWorkspaceSnapshot({ 'bad': 42 })
    expect(fetchCalls).toHaveLength(0)
  })

  it('truncates content above the 80KB hard cap', async () => {
    fetchResponses = [makeAnthropicReply('{"findings":[]}')]
    const big = 'x'.repeat(100_000)
    await audit.auditWorkspaceSnapshot({ 'big.txt': big })
    const user = JSON.parse(String(fetchCalls[0].init?.body)).messages[0].content
    expect(user.length).toBeLessThan(100_000)
    expect(user).toContain('…(truncated)')
  })

  it('hits the outer truncation marker when many files accumulate', async () => {
    fetchResponses = [makeAnthropicReply('{"findings":[]}')]
    const files: Record<string, string> = {}
    for (let i = 0; i < 100; i++) files[`f${i}.txt`] = 'x'.repeat(2000)
    await audit.auditWorkspaceSnapshot(files)
    const user = JSON.parse(String(fetchCalls[0].init?.body)).messages[0].content
    expect(user).toContain('TRUNCATED (snapshot too large')
  })

  it('skips the literal "files" key when scanning a flat object', async () => {
    fetchResponses = [makeAnthropicReply('{"findings":[]}')]
    await audit.auditWorkspaceSnapshot({ files: { 'a.txt': 'kept' } })
    const user = JSON.parse(String(fetchCalls[0].init?.body)).messages[0].content
    expect(user).not.toContain('=== files ===')
  })
})

describe('auditWorkspaceSnapshot — Anthropic failure paths', () => {
  it('returns errored when ANTHROPIC_API_KEY is missing', async () => {
    delete (process.env as any).ANTHROPIC_API_KEY
    const r = await audit.auditWorkspaceSnapshot({ 'a.txt': 'hi' })
    expect(r.status).toBe('errored')
    expect(r.raw).toContain('ANTHROPIC_API_KEY')
  })
  it('returns errored on non-2xx HTTP', async () => {
    fetchResponses = [{ ok: false, status: 503, textBody: 'down for maintenance' }]
    const r = await audit.auditWorkspaceSnapshot({ 'a.txt': 'hi' })
    expect(r.status).toBe('errored')
    expect(r.raw).toMatch(/503/)
  })
  it('returns errored when fetch throws', async () => {
    fetchThrows = new Error('econnreset')
    const r = await audit.auditWorkspaceSnapshot({ 'a.txt': 'hi' })
    expect(r.status).toBe('errored')
    expect(r.raw).toMatch(/econnreset/)
  })
  it('returns errored when fetch throws a non-Error value', async () => {
    fetchThrows = 'string error'
    const r = await audit.auditWorkspaceSnapshot({ 'a.txt': 'hi' })
    expect(r.status).toBe('errored')
    expect(r.raw).toBe('string error')
  })
  it('returns errored when Anthropic returns no text block', async () => {
    fetchResponses = [{ ok: true, status: 200, jsonBody: { content: [] } }]
    const r = await audit.auditWorkspaceSnapshot({ 'a.txt': 'hi' })
    // empty raw text leads to JSON.parse('') throwing → errored
    expect(r.status).toBe('errored')
  })
  it('returns errored on un-parseable JSON', async () => {
    fetchResponses = [makeAnthropicReply('not json at all')]
    const r = await audit.auditWorkspaceSnapshot({ 'a.txt': 'hi' })
    expect(r.status).toBe('errored')
  })
  it('returns errored when findings is not an array', async () => {
    fetchResponses = [makeAnthropicReply('{"findings":"oops"}')]
    const r = await audit.auditWorkspaceSnapshot({ 'a.txt': 'hi' })
    expect(r.status).toBe('errored')
  })
})

describe('auditWorkspaceSnapshot — Anthropic success paths', () => {
  it('returns passed for empty findings', async () => {
    fetchResponses = [makeAnthropicReply('{"findings":[]}')]
    const r = await audit.auditWorkspaceSnapshot({ 'a.txt': 'hi' })
    expect(r.status).toBe('passed')
    expect(r.findings).toEqual([])
  })

  it('strips ```json fence before parsing', async () => {
    fetchResponses = [makeAnthropicReply('```json\n{"findings":[]}\n```')]
    const r = await audit.auditWorkspaceSnapshot({ 'a.txt': 'hi' })
    expect(r.status).toBe('passed')
  })

  it('strips ``` fence (no language tag) before parsing', async () => {
    fetchResponses = [makeAnthropicReply('```\n{"findings":[]}\n```')]
    const r = await audit.auditWorkspaceSnapshot({ 'a.txt': 'hi' })
    expect(r.status).toBe('passed')
  })

  it('returns flagged when at least one finding parses', async () => {
    fetchResponses = [makeAnthropicReply(JSON.stringify({
      findings: [
        { category: 'secret', severity: 'high', path: 'env', message: 'AWS key' },
      ],
    }))]
    const r = await audit.auditWorkspaceSnapshot({ 'a.txt': 'hi' })
    expect(r.status).toBe('flagged')
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].category).toBe('secret')
    expect(r.findings[0].severity).toBe('high')
  })

  it('coerces unknown category to "other" and unknown severity to "medium"', async () => {
    fetchResponses = [makeAnthropicReply(JSON.stringify({
      findings: [{ category: 'wat', severity: 'critical', message: 'hmm' }],
    }))]
    const r = await audit.auditWorkspaceSnapshot({ 'a.txt': 'hi' })
    expect(r.findings[0].category).toBe('other')
    expect(r.findings[0].severity).toBe('medium')
  })

  it('drops findings with missing/empty message', async () => {
    fetchResponses = [makeAnthropicReply(JSON.stringify({
      findings: [
        { category: 'secret', message: '' },
        null,
        'not-an-object',
        { category: 'secret', message: 'ok' },
      ],
    }))]
    const r = await audit.auditWorkspaceSnapshot({ 'a.txt': 'hi' })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].message).toBe('ok')
  })

  it('truncates excerpt to 400 chars', async () => {
    fetchResponses = [makeAnthropicReply(JSON.stringify({
      findings: [{ category: 'secret', message: 'big', excerpt: 'x'.repeat(1000) }],
    }))]
    const r = await audit.auditWorkspaceSnapshot({ 'a.txt': 'hi' })
    expect(r.findings[0].excerpt?.length).toBe(400)
  })

  it('omits non-string path/excerpt fields', async () => {
    fetchResponses = [makeAnthropicReply(JSON.stringify({
      findings: [{ category: 'secret', message: 'm', path: 42, excerpt: { wat: 1 } }],
    }))]
    const r = await audit.auditWorkspaceSnapshot({ 'a.txt': 'hi' })
    expect(r.findings[0].path).toBeUndefined()
    expect(r.findings[0].excerpt).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('recordVersionAudit', () => {
  it('persists status, findings, model, audited-by + auditedAt', async () => {
    versions.set('v1', { id: 'v1' })
    await audit.recordVersionAudit('v1', {
      status: 'flagged',
      model: 'claude-haiku-4-5',
      findings: [{ category: 'secret', severity: 'high', message: 'AWS key' }],
    }, 'admin-1')
    expect(updateCalls).toHaveLength(1)
    const data = updateCalls[0].data
    expect(data.auditStatus).toBe('flagged')
    expect(data.auditedBy).toBe('admin-1')
    expect(data.auditModel).toBe('claude-haiku-4-5')
    expect(data.auditedAt).toBeInstanceOf(Date)
    expect(Array.isArray(data.auditFindings)).toBe(true)
  })
  it('writes auditedBy as null when not supplied', async () => {
    versions.set('v1', { id: 'v1' })
    await audit.recordVersionAudit('v1', { status: 'passed', model: 'claude-haiku-4-5', findings: [] }, null)
    expect(updateCalls[0].data.auditedBy).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('auditListingVersion', () => {
  it('throws version_not_found when row is missing', async () => {
    await expect(audit.auditListingVersion('missing', null)).rejects.toThrow(/version_not_found/)
  })

  it('audits the inline JSON snapshot when no S3 key', async () => {
    versions.set('v1', { id: 'v1', workspaceSnapshot: { 'a.txt': 'hi' }, workspaceSnapshotKey: null })
    fetchResponses = [makeAnthropicReply('{"findings":[]}')]
    const r = await audit.auditListingVersion('v1', null)
    expect(r.status).toBe('passed')
    expect(updateCalls).toHaveLength(1)
  })

  it('loads from S3 when workspaceSnapshotKey is set', async () => {
    versions.set('v1', { id: 'v1', workspaceSnapshotKey: 's3://k', workspaceSnapshotChecksum: 'abc' })
    let receivedKey = ''
    let receivedChecksum: any
    snapshotLoadImpl = async (key, checksum) => {
      receivedKey = key
      receivedChecksum = checksum
      return { 'a.txt': 'from-s3' }
    }
    fetchResponses = [makeAnthropicReply('{"findings":[]}')]
    const r = await audit.auditListingVersion('v1', 'admin')
    expect(r.status).toBe('passed')
    expect(receivedKey).toBe('s3://k')
    expect(receivedChecksum).toBe('abc')
  })

  it('records errored audit when S3 fetch throws', async () => {
    versions.set('v1', { id: 'v1', workspaceSnapshotKey: 's3://broken' })
    snapshotLoadImpl = async () => { throw new Error('s3 timeout') }
    const r = await audit.auditListingVersion('v1', null)
    expect(r.status).toBe('errored')
    expect(r.raw).toMatch(/s3 timeout/)
    // still persists the errored result
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].data.auditStatus).toBe('errored')
  })

  it('records errored audit when S3 fetch throws a non-Error', async () => {
    versions.set('v1', { id: 'v1', workspaceSnapshotKey: 's3://broken' })
    snapshotLoadImpl = async () => { throw 'string error' as any }
    const r = await audit.auditListingVersion('v1', null)
    expect(r.status).toBe('errored')
    expect(r.raw).toBe('string error')
  })

  it('runs audit and persists flagged result with findings', async () => {
    versions.set('v1', { id: 'v1', workspaceSnapshot: { 'a.txt': 'API_KEY=sk_real_aaa' } })
    fetchResponses = [makeAnthropicReply(JSON.stringify({
      findings: [{ category: 'secret', severity: 'high', message: 'Stripe key' }],
    }))]
    const r = await audit.auditListingVersion('v1', 'admin')
    expect(r.status).toBe('flagged')
    expect(updateCalls[0].data.auditStatus).toBe('flagged')
  })
})
