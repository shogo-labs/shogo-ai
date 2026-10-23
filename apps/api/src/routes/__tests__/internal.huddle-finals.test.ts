// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `POST /api/internal/huddle-notes/finals`: the fallback notes worker's only way
 * into the API process. It is the seam that lets a worker's line reach the
 * transcript and the wake hook, so it has to reject anything malformed and
 * anything that isn't the worker — and pass a good final through untouched.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const store = {
  calls: [] as any[],
  result: { ok: true, stored: true } as any,
}

// Keep the real module's other exports: the internal app pulls in services that
// import them, and a partial mock fails to link.
const huddleService = await import('../../services/huddle.service')
mock.module('../../services/huddle.service', () => ({
  ...huddleService,
  appendHuddleNoteFinal: async (input: any) => {
    store.calls.push(input)
    return store.result
  },
}))

const { default: app } = await import('../internal')

const TOKEN = 'notes-worker-token'
const previous = process.env.SHOGO_NOTES_WORKER_TOKEN

const final = (over: Record<string, unknown> = {}) => ({
  huddleId: 'h1',
  identity: 'u1',
  itemId: 'lk:u1:3',
  text: 'hey shogo, make a card',
  start: 1.5,
  end: 3,
  ...over,
})

const post = (body: unknown, token: string | null = TOKEN) =>
  app.request('/huddle-notes/finals', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { 'x-shogo-notes-worker': token }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

beforeEach(() => {
  store.calls = []
  store.result = { ok: true, stored: true }
  process.env.SHOGO_NOTES_WORKER_TOKEN = TOKEN
})

afterEach(() => {
  if (previous === undefined) delete process.env.SHOGO_NOTES_WORKER_TOKEN
  else process.env.SHOGO_NOTES_WORKER_TOKEN = previous
})

describe('POST /internal/huddle-notes/finals', () => {
  test('rejects a caller without the worker token', async () => {
    expect((await post(final(), null)).status).toBe(401)
    expect((await post(final(), 'wrong')).status).toBe(401)
    expect(store.calls).toHaveLength(0)
  })

  test('rejects everyone when the API never minted a token', async () => {
    delete process.env.SHOGO_NOTES_WORKER_TOKEN
    expect((await post(final())).status).toBe(401)
    expect(store.calls).toHaveLength(0)
  })

  test('rejects a body that is not a final', async () => {
    expect((await post('not json')).status).toBe(400)
    expect((await post(final({ text: '   ' }))).status).toBe(400)
    expect((await post(final({ itemId: '' }))).status).toBe(400)
    expect((await post(final({ identity: 'x'.repeat(101) }))).status).toBe(400)
    expect((await post(final({ itemId: 'x'.repeat(201) }))).status).toBe(400)
    expect((await post(final({ end: 86_401 }))).status).toBe(400)
    expect((await post(final({ start: -1 }))).status).toBe(400)
    expect((await post(final({ start: '1' }))).status).toBe(400)
    expect(store.calls).toHaveLength(0)
  })

  test('hands a good final to the service with exactly its fields', async () => {
    const res = await post(final())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stored: true })
    expect(store.calls).toEqual([
      { huddleId: 'h1', identity: 'u1', itemId: 'lk:u1:3', text: 'hey shogo, make a card', start: 1.5, end: 3 },
    ])
  })

  test('reports a lost race as 503 so the worker can retry it', async () => {
    store.result = { ok: false, reason: 'busy' }
    const res = await post(final())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, reason: 'busy' })
  })

  test('passes a not-recording result through as it is', async () => {
    store.result = { ok: false, reason: 'not_recording' }
    const res = await post(final())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, reason: 'not_recording' })
  })
})
