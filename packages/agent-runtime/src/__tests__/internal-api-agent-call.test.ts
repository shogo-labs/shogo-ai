// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { callProjectAgent, resetTrackedCallSupport } from '../internal-api'

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

const realFetch = globalThis.fetch
const savedApiUrl = process.env.SHOGO_API_URL
let calls: Array<{ method: string; path: string; body: any; headers: Record<string, string> }> = []

function route(handler: Handler) {
  calls = []
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({
      method: init.method ?? 'GET',
      path: url.pathname + url.search,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    })
    return handler(url, init)
  }) as any
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const isPoll = (url: URL) => /\/agent-call\/[^/]+$/.test(url.pathname)
const unknownRun = () => json({ error: { code: 'agent_call_unknown', message: 'no' } }, 404)

beforeEach(() => {
  process.env.SHOGO_API_URL = 'https://api.example'
  resetTrackedCallSupport()
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (savedApiUrl === undefined) delete process.env.SHOGO_API_URL
  else process.env.SHOGO_API_URL = savedApiUrl
})

describe('callProjectAgent', () => {
  it('wait=false is a single POST', async () => {
    route(() => json({ status: 'accepted', runId: 'run-1' }, 202))
    const res = await callProjectAgent('proj-2', { message: 'hi', runId: 'run-1', wait: false })
    expect(res.ok).toBe(true)
    expect(res.data?.status).toBe('accepted')
    expect(calls.map((c) => c.method)).toEqual(['POST'])
    expect(calls[0].body.wait).toBe(false)
    expect(calls[0].body.track).toBeUndefined()
  })

  it('wait=true starts a tracked call and long-polls with keep-alive until it completes', async () => {
    let polls = 0
    route((url, init) => {
      if (init.method === 'POST') return json({ status: 'accepted', tracked: true, runId: 'run-1', chatSessionId: 'chat-1' }, 202)
      if (url.searchParams.get('waitMs') === '0') return unknownRun()
      polls++
      return json(polls < 3 ? { httpStatus: 200, status: 'running' } : { httpStatus: 200, status: 'completed', reply: 'done', sessionId: 'chat-1', chatSessionId: 'chat-1' })
    })
    const res = await callProjectAgent('proj-2', { message: 'hi', runId: 'run-1' })
    expect(res).toMatchObject({ ok: true, data: { status: 'completed', reply: 'done', runId: 'run-1', chatSessionId: 'chat-1' } })

    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body).toMatchObject({ wait: false, track: true, runId: 'run-1' })
    const longPolls = calls.filter((c) => c.method === 'GET' && !c.path.endsWith('waitMs=0'))
    expect(longPolls).toHaveLength(3)
    expect(longPolls[0].path).toBe('/api/internal/projects/proj-2/agent-call/run-1?waitMs=60000')
    expect(longPolls[0].headers['X-Shogo-Keepalive']).toBe('1')
  })

  it('maps a failed record to an error with its code', async () => {
    route((url, init) => {
      if (init.method === 'POST') return json({ status: 'accepted', tracked: true }, 202)
      if (url.searchParams.get('waitMs') === '0') return unknownRun()
      return json({ httpStatus: 200, status: 'failed', error: { code: 'agent_turn_failed', message: 'boom' } })
    })
    const res = await callProjectAgent('proj-2', { message: 'hi', runId: 'run-1' })
    expect(res).toMatchObject({ ok: false, error: 'boom', code: 'agent_turn_failed' })
  })

  it('treats an httpStatus error in a 200 keep-alive body as a failure', async () => {
    route((url, init) => {
      if (init.method === 'POST') return json({ status: 'accepted', tracked: true }, 202)
      if (url.searchParams.get('waitMs') === '0') return unknownRun()
      return json({ httpStatus: 403, error: { code: 'forbidden', message: 'nope' } })
    })
    const res = await callProjectAgent('proj-2', { message: 'hi', runId: 'run-1' })
    expect(res).toMatchObject({ ok: false, status: 403, code: 'forbidden' })
  })

  it('gives up with agent_call_timeout once timeoutMs is spent', async () => {
    let offset = 0
    const realNow = Date.now.bind(Date)
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    try {
      route((url, init) => {
        if (init.method === 'POST') return json({ status: 'accepted', tracked: true }, 202)
        if (url.searchParams.get('waitMs') === '0') return unknownRun()
        offset += 61_000
        return json({ httpStatus: 200, status: 'running' })
      })
      const res = await callProjectAgent('proj-2', { message: 'hi', runId: 'run-1', timeoutMs: 120_000 })
      expect(res).toMatchObject({ ok: false, code: 'agent_call_timeout' })
      expect(calls.filter((c) => c.method === 'GET' && isPoll(new URL('https://x' + c.path)) && !c.path.endsWith('waitMs=0'))).toHaveLength(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('retries a Cloudflare 524 on a poll, mapping it to a timeout', async () => {
    let polls = 0
    route((url, init) => {
      if (init.method === 'POST') return json({ status: 'accepted', tracked: true }, 202)
      if (url.searchParams.get('waitMs') === '0') return unknownRun()
      polls++
      if (polls === 1) return new Response('<html>524 A timeout occurred</html>', { status: 524 })
      return json({ httpStatus: 200, status: 'completed', reply: 'ok' })
    })
    const res = await callProjectAgent('proj-2', { message: 'hi', runId: 'run-1' })
    expect(res).toMatchObject({ ok: true, data: { reply: 'ok' } })
  })

  it('maps a raw 524 HTML response to code timeout', async () => {
    route(() => new Response('<html>524</html>', { status: 524 }))
    const res = await callProjectAgent('proj-2', { message: 'hi', runId: 'run-1', wait: false })
    expect(res).toMatchObject({ ok: false, status: 524, code: 'timeout' })
  })

  it('falls back to one blocking POST when the API has no poll route', async () => {
    route((url, init) => {
      if (init.method === 'GET') return new Response('404 Not Found', { status: 404 })
      return json({ status: 'completed', reply: 'blocking reply' })
    })
    const res = await callProjectAgent('proj-2', { message: 'hi', runId: 'run-1' })
    expect(res).toMatchObject({ ok: true, data: { reply: 'blocking reply' } })
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0].body.wait).toBeUndefined()
    expect(posts[0].body.track).toBeUndefined()

    // The answer is cached, so the next call skips the probe.
    calls = []
    await callProjectAgent('proj-2', { message: 'again', runId: 'run-2' })
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0)
  })

  it('reports an untracked 202 as a failure that names where the reply is read', async () => {
    route((url, init) => {
      if (init.method === 'GET') return unknownRun()
      return json({ status: 'accepted', runId: 'run-1', chatSessionId: 'chat-9' }, 202)
    })
    const res = await callProjectAgent('proj-2', { message: 'hi', runId: 'run-1' })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('call_not_followed')
    expect(String(res.error)).toContain('chat-9')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })
})
