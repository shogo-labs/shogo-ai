// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { proxyTerminalSessionsToPod, type ProxyDeps } from '../lib/pty-pod-rest-proxy'

function makeDeps(overrides: Partial<ProxyDeps> = {}): ProxyDeps {
  return {
    resolvePodUrl: async (id: string) => `http://${id}.pod.svc`,
    deriveRuntimeToken: (id: string) => `token-${id}`,
    isSafeProjectId: () => true,
    logger: { error: () => {} },
    ...overrides,
  }
}

describe('proxyTerminalSessionsToPod', () => {
  test('POST: forwards body + content-type, attaches x-runtime-token, relays JSON response', async () => {
    const seen: Array<{ url: string; init: any }> = []
    const fetchImpl: typeof fetch = async (input: any, init: any = {}) => {
      seen.push({ url: String(input), init })
      return new Response(
        JSON.stringify({ id: 'sess-1', cwd: '/workspace', cols: 80, rows: 24, createdAt: 123 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const res = await proxyTerminalSessionsToPod(
      makeDeps({ fetchImpl }),
      { projectId: 'proj-abc', method: 'POST', pathSuffix: '', body: '{"cols":80}', contentType: 'application/json' },
    )

    expect(seen.length).toBe(1)
    expect(seen[0].url).toBe('http://proj-abc.pod.svc/terminal/sessions')
    expect(seen[0].init.method).toBe('POST')
    expect(seen[0].init.headers['x-runtime-token']).toBe('token-proj-abc')
    expect(seen[0].init.headers['content-type']).toBe('application/json')
    expect(seen[0].init.body).toBe('{"cols":80}')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ id: 'sess-1', cwd: '/workspace', cols: 80, rows: 24, createdAt: 123 })
  })

  test('GET (list): no body, omits content-type header', async () => {
    let captured: any = null
    const fetchImpl: typeof fetch = async (input: any, init: any = {}) => {
      captured = { url: String(input), init }
      return new Response(JSON.stringify({ sessions: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    await proxyTerminalSessionsToPod(
      makeDeps({ fetchImpl }),
      { projectId: 'proj-abc', method: 'GET', pathSuffix: '', body: undefined, contentType: undefined },
    )
    expect(captured.init.method).toBe('GET')
    expect(captured.init.headers['content-type']).toBeUndefined()
    expect(captured.init.body).toBeUndefined()
  })

  test('DELETE: appends /id to URL', async () => {
    let url = ''
    const fetchImpl: typeof fetch = async (input: any) => {
      url = String(input)
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    await proxyTerminalSessionsToPod(
      makeDeps({ fetchImpl }),
      { projectId: 'proj-abc', method: 'DELETE', pathSuffix: '/sess-1', body: undefined, contentType: undefined },
    )
    expect(url).toBe('http://proj-abc.pod.svc/terminal/sessions/sess-1')
  })

  test('invalid projectId short-circuits to 400 before fetch', async () => {
    let fetched = false
    const fetchImpl: typeof fetch = async () => {
      fetched = true
      return new Response('')
    }
    const res = await proxyTerminalSessionsToPod(
      makeDeps({ fetchImpl, isSafeProjectId: () => false }),
      { projectId: 'bad..id', method: 'GET', pathSuffix: '', body: undefined, contentType: undefined },
    )
    expect(fetched).toBe(false)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: { code: 'invalid_project_id', message: 'Invalid project id' } })
  })

  test('pod resolver throwing → 503 pod_unavailable', async () => {
    const res = await proxyTerminalSessionsToPod(
      makeDeps({ resolvePodUrl: async () => { throw new Error('pod gone') } }),
      { projectId: 'proj-abc', method: 'GET', pathSuffix: '', body: undefined, contentType: undefined },
    )
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.code).toBe('pod_unavailable')
    expect(body.error.message).toBe('pod gone')
  })

  test('upstream JSON 4xx is passed through verbatim', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { code: 'max_sessions_reached', message: 'too many' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      })
    const res = await proxyTerminalSessionsToPod(
      makeDeps({ fetchImpl }),
      { projectId: 'proj-abc', method: 'POST', pathSuffix: '', body: '{}', contentType: 'application/json' },
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: { code: 'max_sessions_reached', message: 'too many' } })
  })

  test('upstream non-JSON 503 (Knative HTML) → wrapped as service_starting with Retry-After', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('<html>Knative is starting</html>', {
        status: 503, headers: { 'content-type': 'text/html' },
      })
    const res = await proxyTerminalSessionsToPod(
      makeDeps({ fetchImpl }),
      { projectId: 'proj-abc', method: 'GET', pathSuffix: '', body: undefined, contentType: undefined },
    )
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('Retry-After')).toBe('5')
    const body = await res.json()
    expect(body.error.code).toBe('service_starting')
  })

  test('upstream non-JSON 502 → wrapped as service_unavailable', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } })
    const res = await proxyTerminalSessionsToPod(
      makeDeps({ fetchImpl, logger: { error: () => {} } }),
      { projectId: 'proj-abc', method: 'GET', pathSuffix: '', body: undefined, contentType: undefined },
    )
    expect(res.status).toBe(502)
    expect(res.headers.get('Retry-After')).toBeNull()
    expect((await res.json()).error.code).toBe('service_unavailable')
  })

  test('trims trailing slash from pod URL', async () => {
    let url = ''
    const fetchImpl: typeof fetch = async (input: any) => {
      url = String(input)
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    await proxyTerminalSessionsToPod(
      makeDeps({ resolvePodUrl: async () => 'http://x.svc/', fetchImpl }),
      { projectId: 'proj-abc', method: 'GET', pathSuffix: '', body: undefined, contentType: undefined },
    )
    expect(url).toBe('http://x.svc/terminal/sessions')
  })
})
