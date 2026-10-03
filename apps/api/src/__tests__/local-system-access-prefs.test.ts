// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GET/PUT /api/local/access-prefs: the desktop "Computer and files" settings
 * (computer use, per-app file access, blocked folders, dictation shortcuts).
 * PUT merges partial updates and pushes the enforced policy to running runtimes.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const store = new Map<string, string>()
const pushLocalAccessPolicy = mock(async (_policy: unknown) => {})

mock.module('../auth', () => ({ auth: {} }))
mock.module('../lib/prisma', () => ({
  prisma: {
    localConfig: {
      findUnique: async ({ where }: any) => (store.has(where.key) ? { key: where.key, value: store.get(where.key) } : null),
      upsert: async ({ where, create, update }: any) => {
        store.set(where.key, store.has(where.key) ? update.value : create.value)
        return {}
      },
      deleteMany: async () => ({}),
    },
  },
}))
mock.module('../lib/cloud-urls', () => ({ getShogoCloudUrl: () => 'https://cloud.test' }))
mock.module('../lib/federated-upstream', () => ({
  _resetAgentModelDefaultsCache: () => {},
  _resetUpstreamCredentialCache: () => {},
}))
mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({ pushLocalAccessPolicy }) }))

const { localSystemRoutes } = await import('../routes/local-system')

const app = new Hono()
app.route('/api', localSystemRoutes())

const get = () => app.fetch(new Request('http://x/api/local/access-prefs'))
const put = (body: unknown, raw = false) =>
  app.fetch(
    new Request('http://x/api/local/access-prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  )

beforeEach(() => {
  store.clear()
  pushLocalAccessPolicy.mockClear()
})

describe('/api/local/access-prefs', () => {
  test('GET reports defaults as not configured', async () => {
    const body: any = await (await get()).json()
    expect(body.configured).toBe(false)
    expect(body.prefs.computerUse).toBeDefined()
    expect(body.prefs.dictation).toBeDefined()
  })

  test('PUT persists and GET returns it as configured', async () => {
    const res = await put({ computerUse: false, apps: { mail: 'off' } })
    expect(res.status).toBe(200)
    const body: any = await (await get()).json()
    expect(body.configured).toBe(true)
    expect(body.prefs.computerUse).toBe(false)
    expect(body.prefs.apps.mail).toBe('off')
  })

  test('partial PUTs merge instead of resetting other sections', async () => {
    await put({ apps: { mail: 'off', notes: 'readwrite' } })
    await put({ apps: { messages: 'off' } })
    await put({ dictation: { handsFree: 'Control+Option+D' } })

    const { prefs }: any = await (await get()).json()
    expect(prefs.apps.mail).toBe('off')
    expect(prefs.apps.notes).toBe('readwrite')
    expect(prefs.apps.messages).toBe('off')
    expect(prefs.dictation.handsFree).toBe('Control+Option+D')
    // Untouched: push-to-talk keeps its default.
    expect(prefs.dictation.pushToTalk).toBe('Fn')
  })

  test('PUT pushes the enforced policy to running runtimes', async () => {
    await put({ computerUse: false })
    // The push is fire-and-forget (lazy import), so let it settle.
    await new Promise((r) => setTimeout(r, 20))
    expect(pushLocalAccessPolicy).toHaveBeenCalledTimes(1)
    expect((pushLocalAccessPolicy.mock.calls[0][0] as any).computerUse).toBe(false)
  })

  test('invalid JSON is a 400 and stores nothing', async () => {
    const res = await put('{nope', true)
    expect(res.status).toBe(400)
    expect(store.size).toBe(0)
  })

  test('corrupt stored JSON falls back to defaults', async () => {
    store.set('LOCAL_ACCESS_PREFS', '{broken')
    const body: any = await (await get()).json()
    expect(body.configured).toBe(false)
    expect(body.prefs.apps).toBeDefined()
  })
})
