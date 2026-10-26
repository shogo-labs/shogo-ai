// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 *   bun test packages/sdk/src/llm/__tests__/music.test.ts
 */

import { afterEach, describe, expect, test } from 'bun:test'

import { createShogoMusicGenerator } from '../music'
import { createClient } from '../../client'

const RT = 'rt_v1_proj_123_' + 'a'.repeat(64)
const AUDIO = Buffer.from('ID3fake-mp3').toString('base64')

function captureFetch(status = 200, body: unknown = {
  model: 'lyria-3-clip',
  audio: { mime_type: 'audio/mpeg', b64_json: AUDIO },
  text: '[Verse] rain',
  usd: { raw: 0.04, billed: 0.05 },
}) {
  const calls: Array<{ url: string; auth: string | null; body: any }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: typeof input === 'string' ? input : (input as Request).url,
      auth: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(String(init?.body)),
    })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetchImpl }
}

describe('createShogoMusicGenerator', () => {
  test('posts to the gateway with the runtime token and decodes the audio', async () => {
    const { calls, fetchImpl } = captureFetch()
    const generate = createShogoMusicGenerator({ runtimeToken: RT, baseUrl: 'https://studio.example/', fetch: fetchImpl })

    const song = await generate({ prompt: 'lo-fi rain', instrumental: true })

    expect(calls[0].url).toBe('https://studio.example/api/ai/v1/music/generations')
    expect(calls[0].auth).toBe(`Bearer ${RT}`)
    expect(calls[0].body).toEqual({ prompt: 'lo-fi rain', instrumental: true })
    expect(song.mimeType).toBe('audio/mpeg')
    expect(Buffer.from(song.bytes).toString()).toBe('ID3fake-mp3')
    expect(song.lyrics).toBe('[Verse] rain')
    expect(song.billedUsd).toBe(0.05)
  })

  test('throws the gateway error message and code', async () => {
    const { fetchImpl } = captureFetch(402, { error: { message: 'Out of usage', code: 'usage_limit' } })
    const generate = createShogoMusicGenerator({ apiKey: 'shogo_sk_x', fetch: fetchImpl })
    const err = await generate({ prompt: 'x' }).catch((e) => e)
    expect(err.message).toBe('Out of usage')
    expect(err.status).toBe(402)
    expect(err.code).toBe('usage_limit')
  })

  test('requires exactly one credential', () => {
    expect(() => createShogoMusicGenerator({})).toThrow()
    expect(() => createShogoMusicGenerator({ apiKey: 'shogo_sk_x', runtimeToken: RT })).toThrow()
  })
})

describe('client.generateMusic', () => {
  const prev = process.env.RUNTIME_AUTH_SECRET
  afterEach(() => {
    if (prev === undefined) delete process.env.RUNTIME_AUTH_SECRET
    else process.env.RUNTIME_AUTH_SECRET = prev
  })

  test('is wired inside a pod with no shogoApiKey', () => {
    process.env.RUNTIME_AUTH_SECRET = RT
    const client = createClient({ apiUrl: 'http://localhost:3000' })
    expect(typeof client.generateMusic).toBe('function')
  })

  test('is null with no credential', () => {
    delete process.env.RUNTIME_AUTH_SECRET
    const client = createClient({ apiUrl: 'http://localhost:3000' })
    expect(client.generateMusic).toBeNull()
  })
})
