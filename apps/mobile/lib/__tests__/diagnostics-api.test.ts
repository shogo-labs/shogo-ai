// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Diagnostics API client tests — staging-resilience focus.
 *
 * The whole point of mirroring PR #458's architecture for the Problems tab
 * is to NOT crash when the runtime pod is mid-cold-start and Knative serves
 * a `text/html` 503 page instead of our normal JSON. These tests pin that
 * contract:
 *
 *   1. HTML 503 → throws DiagnosticsApiError(code='service_starting', retryable=true)
 *      and does NOT call `response.json()` (which would explode on HTML).
 *   2. Successful but non-JSON 200 (SPA fallback returning index.html — the
 *      exact PR #458 regression) → throws code='non_json_response'.
 *   3. Aborted fetch propagates as AbortError without being wrapped.
 *   4. Happy-path JSON parses normally and the URL carries through `since`
 *      and `source` query params verbatim.
 *
 * We mock `agentFetch` (not global `fetch`) because that's what the module
 * actually calls — keeps the test focused on the parsing layer.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'

// Mock `react-native` BEFORE the SUT imports it (transitively via agent-fetch).
// `bun:test` resolves mocks at module-graph time, so this must come first.
mock.module('react-native', () => ({
  Platform: { OS: 'web' },
}))

// Stub agent-fetch + api so the SUT has a deterministic transport.
let mockResponse: Response | null = null
let lastUrl = ''
let lastInit: RequestInit | undefined
mock.module('../agent-fetch', () => ({
  agentFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    lastUrl = typeof input === 'string' ? input : input.toString()
    lastInit = init
    if (init?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    if (!mockResponse) throw new Error('test forgot to set mockResponse')
    return mockResponse
  },
}))
mock.module('../api', () => ({ API_URL: 'http://api.example.test' }))

// Auth client is pulled in transitively; stub it so we don't hit Expo SecureStore.
mock.module('../auth-client', () => ({ authClient: { getCookie: () => null } }))

// Now import the SUT.
const {
  fetchDiagnostics,
  refreshDiagnostics,
  DiagnosticsApiError,
} = await import('../diagnostics-api')

beforeEach(() => {
  mockResponse = null
  lastUrl = ''
  lastInit = undefined
})

afterEach(() => {
  mockResponse = null
})

describe('diagnostics-api — Knative cold-start (HTML 503)', () => {
  test('treats a text/html 503 as service_starting WITHOUT calling .json()', async () => {
    mockResponse = new Response(
      '<!doctype html><html><body>upstream connect error or disconnect/reset before headers</body></html>',
      { status: 503, headers: { 'content-type': 'text/html', 'retry-after': '5' } },
    )
    await expect(fetchDiagnostics('proj_a')).rejects.toMatchObject({
      name: 'DiagnosticsApiError',
      code: 'service_starting',
      status: 503,
      retryable: true,
    })
  })

  test('treats a text/plain 502 gateway error as service_unavailable', async () => {
    mockResponse = new Response('upstream error', {
      status: 502,
      headers: { 'content-type': 'text/plain' },
    })
    await expect(refreshDiagnostics('proj_a')).rejects.toMatchObject({
      code: 'service_unavailable',
      retryable: true,
    })
  })

  test('treats a 504 gateway timeout (HTML) as gateway_timeout', async () => {
    mockResponse = new Response('<html><body>504 Gateway Timeout</body></html>', {
      status: 504, headers: { 'content-type': 'text/html' },
    })
    await expect(fetchDiagnostics('proj_a')).rejects.toMatchObject({
      code: 'gateway_timeout',
      retryable: true,
    })
  })
})

describe('diagnostics-api — SPA fallthrough trap (PR #458 regression check)', () => {
  test('rejects a 200 OK with text/html body — never silently returns it as data', async () => {
    // This is the literal PR #458 bug: runtime route registered AFTER the SPA
    // fallback returned `index.html` with status 200. If our client ever
    // got that response, the symptom on the user's screen would be "loading
    // forever". The test pins that we explicitly throw `non_json_response`
    // so a regression surfaces immediately as a typed error.
    mockResponse = new Response('<!doctype html><html>...</html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    })
    await expect(fetchDiagnostics('proj_a')).rejects.toMatchObject({
      code: 'non_json_response',
      retryable: false,
    })
  })
})

describe('diagnostics-api — happy path', () => {
  test('parses JSON 200 and forwards since + source query params verbatim', async () => {
    const payload = {
      diagnostics: [{ id: 'x', source: 'ts', severity: 'error', file: 'a.ts', line: 1, column: 1, message: 'm' }],
      lastRunAt: '2024-01-01T00:00:00Z',
      sources: ['ts', 'eslint'],
      fromCache: false,
    }
    mockResponse = new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
    const result = await fetchDiagnostics('proj_a', {
      since: '2023-12-31T00:00:00Z',
      sources: ['ts', 'eslint'],
    })
    expect(result).toEqual(payload as any)
    expect(lastUrl).toContain('http://api.example.test/api/projects/proj_a/diagnostics')
    expect(lastUrl).toContain('since=2023-12-31T00%3A00%3A00Z')
    expect(lastUrl).toContain('source=ts%2Ceslint')
  })

  test('refreshDiagnostics POSTs to /refresh with sources body', async () => {
    mockResponse = new Response(JSON.stringify({
      diagnostics: [], lastRunAt: '2024-01-02T00:00:00Z', sources: ['ts'], fromCache: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    await refreshDiagnostics('proj_a', { sources: ['ts'] })
    expect(lastInit?.method).toBe('POST')
    expect((lastInit?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(lastInit?.body).toBe(JSON.stringify({ sources: ['ts'] }))
  })

  test('returns the structured JSON error when server returns JSON 4xx', async () => {
    mockResponse = new Response(JSON.stringify({
      error: { code: 'invalid_project_id', message: 'Bad id' },
    }), { status: 400, headers: { 'content-type': 'application/json' } })
    const err = await fetchDiagnostics('bad/id').catch(e => e) as InstanceType<typeof DiagnosticsApiError>
    expect(err).toBeInstanceOf(DiagnosticsApiError)
    expect(err.code).toBe('invalid_project_id')
    expect(err.message).toBe('Bad id')
    expect(err.status).toBe(400)
    expect(err.retryable).toBe(false)
  })
})

describe('diagnostics-api — abort handling', () => {
  test('abort signal pre-set propagates as AbortError, not DiagnosticsApiError', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(fetchDiagnostics('proj_a', { signal: ctrl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
