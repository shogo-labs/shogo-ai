// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { keepAliveJson, wantsKeepAlive } from '../keepalive-json'

const decoder = new TextDecoder()

async function readChunks(res: Response): Promise<string[]> {
  const reader = res.body!.getReader()
  const chunks: string[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return chunks
    chunks.push(decoder.decode(value))
  }
}

describe('keepAliveJson', () => {
  it('sends 200 with no-buffering headers before the work settles', () => {
    const res = keepAliveJson(new Promise(() => {}), { intervalMs: 5 })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toBe('no-store, no-transform')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    void res.body!.cancel()
  })

  it('pings with spaces while pending, then ends with parseable JSON carrying httpStatus', async () => {
    const work = new Promise<{ status: number; body: unknown }>((resolve) =>
      setTimeout(() => resolve({ status: 404, body: { error: { code: 'agent_call_unknown' } } }), 40),
    )
    const chunks = await readChunks(keepAliveJson(work, { intervalMs: 5 }))
    const pings = chunks.slice(0, -1)
    expect(pings.length).toBeGreaterThanOrEqual(2)
    expect(pings.every((c) => c === ' ')).toBe(true)
    const parsed = JSON.parse(chunks.join(''))
    expect(parsed).toEqual({ httpStatus: 404, error: { code: 'agent_call_unknown' } })
  })

  it('turns a rejected work promise into an httpStatus 500 body', async () => {
    const text = await keepAliveJson(Promise.reject(new Error('kaput')), { intervalMs: 5 }).text()
    expect(JSON.parse(text)).toEqual({ httpStatus: 500, error: { code: 'internal_error', message: 'kaput' } })
  })

  it('wraps non-object bodies', async () => {
    const text = await keepAliveJson(Promise.resolve({ status: 200, body: 'ok' })).text()
    expect(JSON.parse(text)).toEqual({ httpStatus: 200, body: 'ok' })
  })
})

describe('wantsKeepAlive', () => {
  it('accepts 1 / true only', () => {
    expect(wantsKeepAlive('1')).toBe(true)
    expect(wantsKeepAlive('TRUE')).toBe(true)
    expect(wantsKeepAlive('0')).toBe(false)
    expect(wantsKeepAlive(undefined)).toBe(false)
  })
})
