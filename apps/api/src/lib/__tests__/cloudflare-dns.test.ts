// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the Cloudflare DNS helper used to maintain
 * per-preview A records. The helper must:
 *   - be a complete no-op when env vars are missing (so local dev is unaffected)
 *   - create a record when one doesn't exist
 *   - skip writes when an existing record already matches
 *   - PATCH an existing record when IP or proxied state has drifted
 *   - delete a matching record; 404-equivalent (missing) is benign
 *   - swallow API failures (never throw) so they can't break pod lifecycle
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  upsertPreviewDnsRecord,
  deletePreviewDnsRecord,
  getCloudflareDnsConfig,
  _resetCloudflareDnsConfigForTest,
} from '../cloudflare-dns'

interface FetchCall {
  url: string
  method: string
  body: any
}

function installFakeFetch(
  responder: (url: string, init: RequestInit) => { status?: number; body: any },
) {
  const calls: FetchCall[] = []
  const fake = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    const method = (init?.method || 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    calls.push({ url, method, body })
    const r = responder(url, init ?? {})
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  }
  const original = globalThis.fetch
  globalThis.fetch = fake as any
  return {
    calls,
    restore: () => { globalThis.fetch = original },
  }
}

function setEnv() {
  process.env.CF_API_TOKEN = 'test-token'
  process.env.CF_ZONE_ID = 'zone-abc'
  process.env.KOURIER_LB_IP = '10.1.2.3'
  _resetCloudflareDnsConfigForTest()
}

function clearEnv() {
  delete process.env.CF_API_TOKEN
  delete process.env.CF_ZONE_ID
  delete process.env.KOURIER_LB_IP
  delete process.env.CF_DNS_COMMENT
  _resetCloudflareDnsConfigForTest()
}

describe('cloudflare-dns configuration', () => {
  beforeEach(() => clearEnv())
  afterEach(() => clearEnv())

  test('returns null when any var is missing', () => {
    expect(getCloudflareDnsConfig()).toBeNull()
    process.env.CF_API_TOKEN = 't'
    _resetCloudflareDnsConfigForTest()
    expect(getCloudflareDnsConfig()).toBeNull()
    process.env.CF_ZONE_ID = 'z'
    _resetCloudflareDnsConfigForTest()
    expect(getCloudflareDnsConfig()).toBeNull()
    process.env.KOURIER_LB_IP = '1.1.1.1'
    _resetCloudflareDnsConfigForTest()
    expect(getCloudflareDnsConfig()).not.toBeNull()
  })

  test('upsert is a no-op without config', async () => {
    const fetched = installFakeFetch(() => ({ body: {} }))
    try {
      await upsertPreviewDnsRecord('preview--x.shogo.ai')
      expect(fetched.calls).toHaveLength(0)
    } finally {
      fetched.restore()
    }
  })

  test('delete is a no-op without config', async () => {
    const fetched = installFakeFetch(() => ({ body: {} }))
    try {
      await deletePreviewDnsRecord('preview--x.shogo.ai')
      expect(fetched.calls).toHaveLength(0)
    } finally {
      fetched.restore()
    }
  })
})

describe('upsertPreviewDnsRecord', () => {
  beforeEach(() => setEnv())
  afterEach(() => clearEnv())

  test('creates a record when none exists', async () => {
    const fetched = installFakeFetch((url, init) => {
      if (init.method === 'POST') {
        return { body: { success: true, errors: [], result: { id: 'new' } } }
      }
      return { body: { success: true, errors: [], result: [] } }
    })
    try {
      await upsertPreviewDnsRecord('preview--a.shogo.ai')
      const posts = fetched.calls.filter(c => c.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(posts[0].body).toMatchObject({
        type: 'A',
        name: 'preview--a.shogo.ai',
        content: '10.1.2.3',
        proxied: true,
      })
    } finally {
      fetched.restore()
    }
  })

  test('skips write when existing record already matches', async () => {
    const fetched = installFakeFetch(() => ({
      body: {
        success: true,
        errors: [],
        result: [
          { id: 'rec-1', name: 'preview--a.shogo.ai', type: 'A', content: '10.1.2.3', proxied: true },
        ],
      },
    }))
    try {
      await upsertPreviewDnsRecord('preview--a.shogo.ai')
      const writes = fetched.calls.filter(c => c.method !== 'GET')
      expect(writes).toHaveLength(0)
    } finally {
      fetched.restore()
    }
  })

  test('PATCHes when existing record drifted (different IP)', async () => {
    const fetched = installFakeFetch((url, init) => {
      if (init.method === 'PATCH') {
        return { body: { success: true, errors: [], result: { id: 'rec-1' } } }
      }
      return {
        body: {
          success: true,
          errors: [],
          result: [
            { id: 'rec-1', name: 'preview--a.shogo.ai', type: 'A', content: '9.9.9.9', proxied: true },
          ],
        },
      }
    })
    try {
      await upsertPreviewDnsRecord('preview--a.shogo.ai')
      const patches = fetched.calls.filter(c => c.method === 'PATCH')
      expect(patches).toHaveLength(1)
      expect(patches[0].url).toContain('/dns_records/rec-1')
      expect(patches[0].body).toEqual({ content: '10.1.2.3', proxied: true })
    } finally {
      fetched.restore()
    }
  })

  test('PATCHes when existing record is unproxied', async () => {
    const fetched = installFakeFetch((url, init) => {
      if (init.method === 'PATCH') {
        return { body: { success: true, errors: [], result: { id: 'rec-1' } } }
      }
      return {
        body: {
          success: true,
          errors: [],
          result: [
            { id: 'rec-1', name: 'preview--a.shogo.ai', type: 'A', content: '10.1.2.3', proxied: false },
          ],
        },
      }
    })
    try {
      await upsertPreviewDnsRecord('preview--a.shogo.ai')
      expect(fetched.calls.filter(c => c.method === 'PATCH')).toHaveLength(1)
    } finally {
      fetched.restore()
    }
  })

  test('swallows API errors (does not throw)', async () => {
    const fetched = installFakeFetch(() => ({
      status: 403,
      body: { success: false, errors: [{ code: 9109, message: 'Unauthorized' }], result: null },
    }))
    try {
      await expect(upsertPreviewDnsRecord('preview--a.shogo.ai')).resolves.toBeUndefined()
    } finally {
      fetched.restore()
    }
  })

  test('swallows network errors (does not throw)', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as any
    try {
      await expect(upsertPreviewDnsRecord('preview--a.shogo.ai')).resolves.toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('deletePreviewDnsRecord', () => {
  beforeEach(() => setEnv())
  afterEach(() => clearEnv())

  test('deletes when record exists', async () => {
    const fetched = installFakeFetch((url, init) => {
      if (init.method === 'DELETE') {
        return { body: { success: true, errors: [], result: { id: 'rec-1' } } }
      }
      return {
        body: {
          success: true,
          errors: [],
          result: [{ id: 'rec-1', name: 'preview--a.shogo.ai', type: 'A', content: '10.1.2.3', proxied: true }],
        },
      }
    })
    try {
      await deletePreviewDnsRecord('preview--a.shogo.ai')
      const deletes = fetched.calls.filter(c => c.method === 'DELETE')
      expect(deletes).toHaveLength(1)
      expect(deletes[0].url).toContain('/dns_records/rec-1')
    } finally {
      fetched.restore()
    }
  })

  test('no-op when record is already absent', async () => {
    const fetched = installFakeFetch(() => ({
      body: { success: true, errors: [], result: [] },
    }))
    try {
      await deletePreviewDnsRecord('preview--a.shogo.ai')
      expect(fetched.calls.filter(c => c.method === 'DELETE')).toHaveLength(0)
    } finally {
      fetched.restore()
    }
  })

  test('swallows delete API errors (does not throw)', async () => {
    const fetched = installFakeFetch((url, init) => {
      if (init.method === 'DELETE') {
        return {
          status: 500,
          body: { success: false, errors: [{ code: 9999, message: 'boom' }], result: null },
        }
      }
      return {
        body: {
          success: true,
          errors: [],
          result: [{ id: 'rec-1', name: 'preview--a.shogo.ai', type: 'A', content: '10.1.2.3', proxied: true }],
        },
      }
    })
    try {
      await expect(deletePreviewDnsRecord('preview--a.shogo.ai')).resolves.toBeUndefined()
    } finally {
      fetched.restore()
    }
  })
})
