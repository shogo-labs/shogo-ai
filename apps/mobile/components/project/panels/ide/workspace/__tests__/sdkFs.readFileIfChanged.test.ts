// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `SdkFs.readFileIfChanged` — the IDE's conditional re-read.
 *
 * The hook only needs to know "did this file change?". Sending the last ETag
 * turns a quiet file into a bodiless 304, which is what keeps a healthy IDE
 * tab off the network (PERF-10). These tests pin the ETag bookkeeping: it is
 * remembered after a 200, sent on the next read, and dropped when we write the
 * file ourselves.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { SdkFs } from '../sdkFs'

type Call = { url: string; headers: Record<string, string> }

function makeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: typeof input === 'string' ? input : input.toString(),
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    calls.push(call)
    return respond(call)
  }) as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  return { calls, fetchImpl }
}

afterEach(() => {
  // no shared state between tests: each SdkFs owns its ETag map
})

describe('SdkFs.readFileIfChanged', () => {
  test('remembers the ETag and sends it on the next read', async () => {
    let n = 0
    const { calls, fetchImpl } = makeFetch(() => {
      n += 1
      return n === 1
        ? new Response(JSON.stringify({ path: 'a.ts', content: 'let a = 1', encoding: 'utf-8' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ETag: 'W/"5-9"' },
          })
        : new Response(null, { status: 304 })
    })
    const fs = new SdkFs('http://agent.test', 'agent', fetchImpl)

    const first = await fs.readFileIfChanged('a.ts')
    expect(first?.content).toBe('let a = 1')

    const second = await fs.readFileIfChanged('a.ts')
    expect(second).toBeNull()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.headers['If-None-Match']).toBe('W/"5-9"')
  })

  test('starts with no If-None-Match', async () => {
    const { calls, fetchImpl } = makeFetch(
      () => new Response(JSON.stringify({ path: 'a.ts', content: 'x', encoding: 'utf-8' }), { status: 200 }),
    )
    const fs = new SdkFs('http://agent.test', 'agent', fetchImpl)
    await fs.readFileIfChanged('a.ts')
    expect(calls[0]!.headers['If-None-Match']).toBeUndefined()
  })

  test('forgets the ETag after we write the file ourselves', async () => {
    let mode: 'read' | 'written' = 'read'
    const { calls, fetchImpl } = makeFetch((call) => {
      if (call.url.endsWith('/agent/workspace/files/a.ts') && !call.headers['Content-Type']) {
        return mode === 'read'
          ? new Response(JSON.stringify({ path: 'a.ts', content: 'v1', encoding: 'utf-8' }), {
              status: 200,
              headers: { ETag: 'W/"1-2"' },
            })
          : new Response(JSON.stringify({ path: 'a.ts', content: 'v2', encoding: 'utf-8' }), {
              status: 200,
              headers: { ETag: 'W/"2-2"' },
            })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    const fs = new SdkFs('http://agent.test', 'agent', fetchImpl)

    await fs.readFileIfChanged('a.ts')
    await fs.writeFile('a.ts', 'v2')
    mode = 'written'
    await fs.readFileIfChanged('a.ts')

    // The read after our own write must not carry the stale validator.
    expect(calls.at(-1)!.headers['If-None-Match']).toBeUndefined()
  })

  test('binary paths are refused before any request', async () => {
    const { calls, fetchImpl } = makeFetch(() => new Response('{}', { status: 200 }))
    const fs = new SdkFs('http://agent.test', 'agent', fetchImpl)
    await expect(fs.readFileIfChanged('logo.png')).rejects.toThrow(/Binary file/)
    expect(calls).toHaveLength(0)
  })
})
