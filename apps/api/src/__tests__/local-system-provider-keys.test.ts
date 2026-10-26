// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop provider-key registry (`/api/local/api-keys`).
 *
 * SHO-37 surfaced Tripo in the admin Models card in both cloud and local mode,
 * so the desktop registry has to accept it too: the route silently skips an
 * unknown provider id, which would make the field look like it saved while
 * writing nothing.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

type Row = { key: string; value: string }
let rows: Map<string, string>

const localConfig = {
  findMany: async ({ where }: any = {}) => {
    let entries = [...rows.entries()]
    if (where?.key?.in) entries = entries.filter(([k]) => where.key.in.includes(k))
    return entries.map(([key, value]) => ({ key, value }))
  },
  upsert: async ({ where, update, create }: any) => {
    const existed = rows.has(where.key)
    rows.set(where.key, String((existed ? update : create).value))
    return { key: where.key, value: rows.get(where.key) }
  },
  deleteMany: async ({ where }: any = {}) => {
    if (where?.key) rows.delete(where.key)
    return {}
  },
}

mock.module('../auth', () => ({ auth: {} }))
mock.module('../lib/prisma', () => ({ prisma: { localConfig } }))
mock.module('../lib/cloud-urls', () => ({ getShogoCloudUrl: () => 'https://cloud.test' }))
mock.module('../lib/federated-upstream', () => ({
  _resetAgentModelDefaultsCache: () => {},
  _resetUpstreamCredentialCache: () => {},
}))

const { localSystemRoutes } = await import('../routes/local-system')

const ORIG_TRIPO = process.env.TRIPO_API_KEY

function buildApp(): Hono {
  const app = new Hono()
  app.route('/api', localSystemRoutes())
  return app
}

function getKeys(): Promise<Response> {
  return buildApp().fetch(new Request('http://x/api/local/api-keys'))
}

function putKeys(body: Record<string, unknown>): Promise<Response> {
  return buildApp().fetch(new Request('http://x/api/local/api-keys', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

beforeEach(() => {
  rows = new Map<string, string>()
  delete process.env.TRIPO_API_KEY
})

afterEach(() => {
  if (ORIG_TRIPO === undefined) delete process.env.TRIPO_API_KEY
  else process.env.TRIPO_API_KEY = ORIG_TRIPO
})

describe('/api/local/api-keys', () => {
  test('GET reports a stored tripo key as a mask', async () => {
    rows.set('TRIPO_API_KEY', 'tsk_live_tripo_secret')

    const data = await (await getKeys()).json() as any
    expect(data.ok).toBe(true)
    expect(data.keys.tripo).toBe('tsk_live...cret')
    expect(JSON.stringify(data)).not.toContain('tsk_live_tripo_secret')
  })

  test('PUT stores tripo in localConfig and mirrors it into process.env', async () => {
    const res = await putKeys({ tripo: 'tsk_live_tripo_secret' })
    expect(res.status).toBe(200)
    expect(rows.get('TRIPO_API_KEY')).toBe('tsk_live_tripo_secret')
    expect(process.env.TRIPO_API_KEY).toBe('tsk_live_tripo_secret')

    const data = await (await getKeys()).json() as any
    expect(data.keys.tripo).toBe('tsk_live...cret')
  })

  test('PUT with an empty string clears the stored tripo key', async () => {
    rows.set('TRIPO_API_KEY', 'tsk_live_tripo_secret')
    process.env.TRIPO_API_KEY = 'tsk_live_tripo_secret'

    await putKeys({ tripo: '' })
    expect(rows.has('TRIPO_API_KEY')).toBe(false)
    expect(process.env.TRIPO_API_KEY).toBeUndefined()
    expect((await (await getKeys()).json() as any).keys.tripo).toBeUndefined()
  })

  test('PUT still ignores an unknown provider id', async () => {
    await putKeys({ nope: 'x' })
    expect(rows.size).toBe(0)
  })
})
