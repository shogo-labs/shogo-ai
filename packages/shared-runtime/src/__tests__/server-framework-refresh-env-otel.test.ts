// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// A metal snapshot restore brings the runtime process back with its boot-time
// env, so a guest that first booted BEFORE the control plane injected the OTEL
// endpoint starts with telemetry disabled. `/pool/refresh-env` delivers the
// endpoint on resume, and must (re-)activate OpenTelemetry in-process —
// otherwise the guest stays dark in SigNoz until a cold boot. This exercises
// that wiring with the instrumentation module mocked so no real SDK starts.
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ---- Mock the OTEL instrumentation module (before importing server-framework).
// The shared-runtime `./instrumentation` shim re-exports from this package
// specifier, so mocking it here intercepts server-framework's imports too.
const initCalls: Array<{ serviceName: string }> = []
mock.module('@shogo-ai/sdk/instrumentation', () => ({
  initInstrumentation: (cfg: { serviceName: string }) => {
    initCalls.push({ serviceName: cfg.serviceName })
  },
  shutdownInstrumentation: async () => {},
  traceOperation: async (_t: string, _s: string, _a: any, fn: any) =>
    fn({ setAttribute() {}, setStatus() {}, recordException() {}, end() {} }),
}))

// A permissive fetch stub keeps assign / token-refresh from throwing.
const originalFetch = global.fetch
global.fetch = mock(async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => '{}',
})) as any

const originalEnv = { ...process.env }
const AUTH = { 'x-runtime-token': 'test-runtime-secret', 'content-type': 'application/json' }
const workDirs: string[] = []

async function buildAssigned() {
  const workDir = mkdtempSync(join(tmpdir(), 'srv-fw-otel-'))
  workDirs.push(workDir)
  const { createRuntimeApp } = await import('../server-framework')
  const handle = await createRuntimeApp({
    name: 'test-runtime',
    workDir,
    runtimeType: 'unified',
    authPrefixes: ['/agent', '/pool'],
    async onAssign() {},
    onRefreshEnv() {},
  })
  const assign = await handle.app.request('/pool/assign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'proj-x', env: { CUSTOM: 'v1' } }),
  })
  expect(assign.status).toBe(200)
  return handle
}

beforeEach(() => {
  process.env = { ...originalEnv }
  process.env.PROJECT_ID = '__POOL__'
  process.env.WARM_POOL_MODE = 'true'
  process.env.RUNTIME_AUTH_SECRET = 'test-runtime-secret'
  process.env.SHOGO_API_URL = 'http://api.test.local'
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete process.env.AI_PROXY_URL
  delete process.env.AI_PROXY_TOKEN
  initCalls.length = 0
})

afterEach(() => {
  process.env = { ...originalEnv }
  for (const d of workDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('/pool/refresh-env — OTEL activation on resume', () => {
  test('re-initializes instrumentation when the OTEL endpoint newly appears', async () => {
    const { app } = await buildAssigned()
    // Only count calls triggered by refresh-env, not the createRuntimeApp boot call.
    initCalls.length = 0

    const res = await app.request('/pool/refresh-env', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        projectId: 'proj-x',
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ingest.us.signoz.cloud:443' },
      }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).changed).toContain('OTEL_EXPORTER_OTLP_ENDPOINT')
    expect(initCalls).toHaveLength(1)
    expect(initCalls[0].serviceName).toBe('shogo-test-runtime')
  })

  test('does NOT re-initialize when the OTEL endpoint is unchanged', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ingest.us.signoz.cloud:443'
    const { app } = await buildAssigned()
    initCalls.length = 0

    const res = await app.request('/pool/refresh-env', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        projectId: 'proj-x',
        // Same endpoint already in process.env → not in `changed` → no re-init.
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ingest.us.signoz.cloud:443',
          CUSTOM: 'v2',
        },
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.changed).toContain('CUSTOM')
    expect(body.changed).not.toContain('OTEL_EXPORTER_OTLP_ENDPOINT')
    expect(initCalls).toHaveLength(0)
  })
})
