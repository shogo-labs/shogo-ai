// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const rows = new Map<string, { key: string; value: string; updatedBy: string }>()
let failDb = false

mock.module('../../lib/prisma', () => ({
  prisma: {
    platformSetting: {
      findUnique: async ({ where }: any) => {
        if (failDb) throw new Error('db down')
        return rows.get(where.key) ?? null
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = rows.get(where.key)
        const row = existing ? { ...existing, ...update } : create
        rows.set(where.key, row)
        return row
      },
      deleteMany: async ({ where }: any) => {
        rows.delete(where.key)
        return { count: 1 }
      },
    },
  },
}))

mock.module('../../services/public-models.service', () => ({
  resolvePublicModelSync: (id: string) => (id === 'hoshi-2-0' ? { publicId: 'hoshi-2-0', enabled: true } : null),
}))
mock.module('../../services/model-registry.service', () => ({
  getMergedModelEntrySync: (id: string) => (id === 'gpt-5.4-nano' ? { id, provider: 'openai' } : undefined),
}))

const { platformModelSettingRoutes, loadPlatformModelSetting } = await import('../platform-model-setting')

const KEY = 'test.model'
let applied: Array<string | null> = []
const setting = { settingKey: KEY, apply: (id: string | null) => { applied.push(id) } }

function buildApp(): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', { user: { id: 'admin-1' } })
    await next()
  })
  app.route('/api/admin/settings/test-model', platformModelSettingRoutes(setting))
  return app
}

function put(body: unknown): Promise<Response> {
  return buildApp().fetch(new Request('http://x/api/admin/settings/test-model', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

beforeEach(() => {
  rows.clear()
  applied = []
  failDb = false
})

describe('platformModelSettingRoutes', () => {
  test('GET returns null when unset and the stored id otherwise', async () => {
    let res = await buildApp().fetch(new Request('http://x/api/admin/settings/test-model'))
    expect(await res.json()).toEqual({ model: null })

    rows.set(KEY, { key: KEY, value: 'gpt-5.4-nano', updatedBy: 'x' })
    res = await buildApp().fetch(new Request('http://x/api/admin/settings/test-model'))
    expect(await res.json()).toEqual({ model: 'gpt-5.4-nano' })
  })

  test('PUT stores a known model id or public alias and applies it', async () => {
    let res = await put({ model: '  gpt-5.4-nano ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, model: 'gpt-5.4-nano' })
    expect(rows.get(KEY)).toEqual({ key: KEY, value: 'gpt-5.4-nano', updatedBy: 'admin-1' })

    res = await put({ model: 'hoshi-2-0' })
    expect(res.status).toBe(200)
    expect(rows.get(KEY)?.value).toBe('hoshi-2-0')
    expect(applied).toEqual(['gpt-5.4-nano', 'hoshi-2-0'])
  })

  test('PUT rejects an unknown model id without writing', async () => {
    const res = await put({ model: 'gpt-5.4-nanoo' })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toContain('gpt-5.4-nanoo')
    expect(rows.has(KEY)).toBe(false)
    expect(applied).toEqual([])
  })

  test('PUT with an empty or missing model resets to the default', async () => {
    rows.set(KEY, { key: KEY, value: 'gpt-5.4-nano', updatedBy: 'x' })
    const res = await put({ model: '' })
    expect(await res.json()).toEqual({ ok: true, model: null })
    expect(rows.has(KEY)).toBe(false)

    await put({})
    expect(applied).toEqual([null, null])
  })

  test('GET surfaces a database failure as 500', async () => {
    failDb = true
    const res = await buildApp().fetch(new Request('http://x/api/admin/settings/test-model'))
    expect(res.status).toBe(500)
  })
})

describe('loadPlatformModelSetting', () => {
  test('applies a stored value and skips an unset one', async () => {
    const origLog = console.log
    console.log = () => {}
    try {
      await loadPlatformModelSetting(setting, 'Test')
      expect(applied).toEqual([])
      rows.set(KEY, { key: KEY, value: 'gpt-5.4-nano', updatedBy: 'x' })
      await loadPlatformModelSetting(setting, 'Test')
      expect(applied).toEqual(['gpt-5.4-nano'])
      failDb = true
      await loadPlatformModelSetting(setting, 'Test')
      expect(applied).toEqual(['gpt-5.4-nano'])
    } finally {
      console.log = origLog
    }
  })
})
