// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// A server-backed publish without a per-commit image must ship the editing
// runtime's CURRENT source. It used to hydrate from the runtime's last backup,
// which a metal runtime only refreshes when it stops, so republishing the KIF
// CRM four times kept serving the same days-old server.tsx (2026-11-16).

import { describe, expect, test } from 'bun:test'
import { pinPublishedSource, publishedSourceKey, type PinPublishedSourceDeps } from '../published-source.service'

function deps(over: Partial<PinPublishedSourceDeps> & { response?: Response | Error } = {}) {
  const puts: Array<{ bucket: string; key: string; body: Uint8Array }> = []
  const calls: Array<{ url: string; token: string | null }> = []
  const d: PinPublishedSourceDeps = {
    bucket: 'shogo-published-data-test',
    podUrl: async () => 'http://runtime.test',
    runtimeToken: async (id) => `token-${id}`,
    fetch: async (url, init) => {
      calls.push({ url, token: new Headers(init.headers).get('x-runtime-token') })
      if (over.response instanceof Error) throw over.response
      return over.response ?? new Response(new Uint8Array([31, 139, 8, 0, 1, 2, 3]), { status: 200 })
    },
    put: async (bucket, key, body) => {
      puts.push({ bucket, key, body })
    },
    ...over,
  }
  return { d, puts, calls }
}

describe('pinPublishedSource', () => {
  test('pulls the source from the editing runtime and stores it under the subdomain', async () => {
    const { d, puts, calls } = deps()
    const res = await pinPublishedSource({ projectId: 'p1', subdomain: 'kif-crm' }, d)

    expect(res).toEqual({ ok: true, key: 'kif-crm/source.tar.gz', bytes: 7 })
    expect(calls).toEqual([{ url: 'http://runtime.test/agent/publish-source?projectId=p1', token: 'token-p1' }])
    expect(puts).toHaveLength(1)
    expect(puts[0].bucket).toBe('shogo-published-data-test')
    expect(puts[0].key).toBe(publishedSourceKey('kif-crm'))
    expect(Array.from(puts[0].body)).toEqual([31, 139, 8, 0, 1, 2, 3])
  })

  test('fails the publish when the runtime cannot produce the source', async () => {
    const { d, puts } = deps({ response: new Response('{"error":"source_pack_failed"}', { status: 500 }) })
    const res = await pinPublishedSource({ projectId: 'p1', subdomain: 'kif-crm' }, d)

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('source_snapshot_failed')
    expect(res.message).toContain('500')
    expect(puts).toHaveLength(0)
  })

  test('fails the publish when the runtime is unreachable', async () => {
    const { d } = deps({ response: new Error('connect ECONNREFUSED') })
    const res = await pinPublishedSource({ projectId: 'p1', subdomain: 'kif-crm' }, d)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.message).toContain('ECONNREFUSED')
  })

  test('refuses an empty archive rather than pinning nothing', async () => {
    const { d, puts } = deps({ response: new Response(new Uint8Array(), { status: 200 }) })
    const res = await pinPublishedSource({ projectId: 'p1', subdomain: 'kif-crm' }, d)
    expect(res.ok).toBe(false)
    expect(puts).toHaveLength(0)
  })

  test('fails the publish when the upload fails', async () => {
    const { d } = deps({
      put: async () => {
        throw new Error('AccessDenied')
      },
    })
    const res = await pinPublishedSource({ projectId: 'p1', subdomain: 'kif-crm' }, d)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.message).toContain('AccessDenied')
  })

  test('a cluster without a published-data bucket skips the pin instead of failing', async () => {
    const { d, calls } = deps({ bucket: '' })
    const res = await pinPublishedSource({ projectId: 'p1', subdomain: 'kif-crm' }, d)
    expect(res).toEqual({ ok: true, skipped: 'no_data_bucket' })
    expect(calls).toHaveLength(0)
  })
})
