// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `@shogo-ai/sdk/voice/route/op` — one route module for every op.
 *
 * A pod app mounts this once (`app/api/voice/op/[opId]+api.ts`) and gets every
 * registry op, including ones added after it shipped. These tests pin that: the
 * dispatcher takes the id from the URL, and `voiceOpRoutes` covers the whole
 * registry without anyone listing the ops here.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { VOICE_OP_IDS } from '../ops'
import { GET, POST, voiceOpRoutes } from '../route/op'

const ORIGINAL = {
  rt: process.env.RUNTIME_AUTH_SECRET,
  pid: process.env.PROJECT_ID,
  api: process.env.SHOGO_API_URL,
}
const originalFetch = globalThis.fetch

beforeEach(() => {
  process.env.RUNTIME_AUTH_SECRET = 'rt_route'
  process.env.PROJECT_ID = 'proj_route'
  process.env.SHOGO_API_URL = 'http://api'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries({
    RUNTIME_AUTH_SECRET: ORIGINAL.rt,
    PROJECT_ID: ORIGINAL.pid,
    SHOGO_API_URL: ORIGINAL.api,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

type Call = { url: string; init: RequestInit }

function stubAudio(): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (input: any, init: any = {}) => {
    calls.push({ url: typeof input === 'string' ? input : String(input), init })
    return new Response(new Uint8Array([1, 2]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    })
  }) as unknown as typeof fetch
  return calls
}

describe('route/op dispatcher', () => {
  test('POST reads the op id from the last path segment', async () => {
    const calls = stubAudio()
    const form = new FormData()
    form.set('audio', new File([new Uint8Array([1])], 'a.mp3', { type: 'audio/mpeg' }))
    const res = await POST(
      new Request('http://pod/api/voice/op/speech-to-speech?voiceId=v1', {
        method: 'POST',
        body: form,
      }),
    )
    expect(res.status).toBe(200)
    expect(calls[0]!.url).toBe(
      'http://api/api/voice/op/speech-to-speech?projectId=proj_route&voiceId=v1',
    )
  })

  test('GET serves the listing ops', async () => {
    const calls = stubAudio()
    await GET(new Request('http://pod/api/voice/op/models'))
    expect(calls[0]!.url).toBe('http://api/api/voice/op/models?projectId=proj_route')
  })

  test('?op= wins when a framework cannot give the segment a name', async () => {
    const calls = stubAudio()
    await POST(
      new Request('http://pod/api/voice?op=sound-generation', {
        method: 'POST',
        body: JSON.stringify({ text: 'boom' }),
      }),
    )
    expect(calls[0]!.url).toBe(
      'http://api/api/voice/op/sound-generation?projectId=proj_route',
    )
  })

  test('an unknown op is a 404 before any network call', async () => {
    const calls = stubAudio()
    const res = await POST(
      new Request('http://pod/api/voice/op/not-a-thing', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    )
    expect(res.status).toBe(404)
    expect(calls).toHaveLength(0)
  })
})

describe('voiceOpRoutes', () => {
  test('covers every registry row — adding an op needs no edit here', () => {
    expect(Object.keys(voiceOpRoutes).sort()).toEqual([...VOICE_OP_IDS].sort())
  })

  test('each entry is bound to its own op, not the one in the URL', async () => {
    const calls = stubAudio()
    // Deliberately call the `models` handler on a path that names another op:
    // the binding, not the URL, decides.
    await voiceOpRoutes.models!.GET(
      new Request('http://pod/api/voice/op/speech-to-speech'),
    )
    expect(calls[0]!.url).toBe('http://api/api/voice/op/models?projectId=proj_route')
  })
})
