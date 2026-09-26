// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// ─── mocks ───────────────────────────────────────────────────────────────────

const store = {
  resolution: null as any,
  relayResponse: null as any,
  relayCalledWith: null as any,
  tokenCalledWith: null as any,
}

mock.module('../../lib/agent-proxy-resolver', () => ({
  resolveAgentProxyPodUrl: async (projectId: string, opts?: any) => {
    store.relayCalledWith = { ...(store.relayCalledWith ?? {}), resolveProjectId: projectId, resolveOpts: opts }
    return store.resolution
  },
}))

mock.module('../../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async (projectId: string, opts?: any) => {
    store.tokenCalledWith = { projectId, opts }
    return 'mock-runtime-token'
  },
}))

mock.module('../../lib/resolve-pod-url', () => ({
  resolveProjectPodUrl: async (projectId: string) => {
    store.relayCalledWith = { ...(store.relayCalledWith ?? {}), hostProjectId: projectId }
    return { url: 'http://127.0.0.1:37658', ready: true }
  },
}))

mock.module('../../lib/tunnel-relay', () => ({
  relayAgentProxyViaTunnel: async (opts: any) => {
    store.relayCalledWith = { ...(store.relayCalledWith ?? {}), tunnelOpts: opts }
    return store.relayResponse
  },
}))

const svc = await import('../agent-call.service')

// ─── fixtures ────────────────────────────────────────────────────────────────

const FAKE_CTX = {} as any

beforeEach(() => {
  store.resolution = { ok: true, kind: 'pod', url: 'http://pod.internal:8080' }
  store.relayResponse = new Response(JSON.stringify({ status: 'completed', reply: 'ok' }), { status: 200 })
  store.relayCalledWith = null
  store.tokenCalledWith = null
})

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

// ─── tests ───────────────────────────────────────────────────────────────────

describe('callProjectAgent — validation', () => {
  it('400s when message is empty or whitespace-only, without resolving anything', async () => {
    const out1 = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: '' })
    expect(out1.status).toBe(400)
    expect(out1.body.error.code).toBe('bad_request')

    const out2 = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: '   ' })
    expect(out2.status).toBe(400)

    expect(store.relayCalledWith).toBeNull()
  })
})

describe('callProjectAgent — resolver failure', () => {
  it('propagates the resolver status/body verbatim', async () => {
    store.resolution = { ok: false, status: 503, body: { error: { code: 'instance_offline', message: 'offline' } } }
    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi' })
    expect(out.status).toBe(503)
    expect(out.body.error.code).toBe('instance_offline')
  })
})

describe('callProjectAgent — cloud (pod) branch', () => {
  it('forwards to `${url}/agent/pipeline/call` with the runtime token header and the request body', async () => {
    store.resolution = { ok: true, kind: 'pod', url: 'http://pod.internal:8080' }
    let capturedUrl = ''
    let capturedInit: any = null
    globalThis.fetch = (async (url: any, init: any) => {
      capturedUrl = String(url)
      capturedInit = init
      return new Response(JSON.stringify({ status: 'completed', reply: 'from pod', runId: 'run-9' }), { status: 200 })
    }) as any

    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', {
      message: 'do the thing',
      runId: 'run-9',
      sessionId: 'sess-1',
      callerProjectId: 'proj-caller',
    })

    expect(out.status).toBe(200)
    expect(out.body.reply).toBe('from pod')
    expect(capturedUrl).toBe('http://pod.internal:8080/agent/pipeline/call')
    expect(capturedInit.headers['x-runtime-token']).toBe('mock-runtime-token')
    expect(capturedInit.headers['Content-Type']).toBe('application/json')
    const parsedBody = JSON.parse(capturedInit.body)
    expect(parsedBody).toEqual({
      message: 'do the thing',
      runId: 'run-9',
      sessionId: 'sess-1',
      wait: true,
      callerProjectId: 'proj-caller',
    })
    expect(store.tokenCalledWith.projectId).toBe('proj-1')
  })

  it('defaults wait to true when omitted, and passes wait:false through untouched', async () => {
    let capturedBody = ''
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = init.body
      return new Response(JSON.stringify({ status: 'accepted' }), { status: 202 })
    }) as any

    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi', wait: false })
    expect(out.status).toBe(202)
    expect(JSON.parse(capturedBody).wait).toBe(false)
  })

  it('clamps timeoutMs into [10s, 20min] and reflects it in the timeout-error message', async () => {
    globalThis.fetch = (async () => {
      const err: any = new Error('aborted')
      err.name = 'TimeoutError'
      throw err
    }) as any

    // Below the floor (5ms) should clamp to 10s.
    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi', timeoutMs: 5 })
    expect(out.status).toBe(504)
    expect(out.body.error.code).toBe('agent_call_timeout')
    expect(out.body.error.message).toContain('10s')
  })

  it('clamps an excessive timeoutMs down to 20 minutes', async () => {
    globalThis.fetch = (async () => {
      const err: any = new Error('aborted')
      err.name = 'TimeoutError'
      throw err
    }) as any

    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi', timeoutMs: 999 * 60_000 })
    expect(out.body.error.message).toContain('1200s')
  })

  it('returns 502 agent_call_failed on a non-timeout fetch error, with the underlying message', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as any

    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi' })
    expect(out.status).toBe(502)
    expect(out.body.error.code).toBe('agent_call_failed')
    expect(out.body.error.message).toBe('ECONNREFUSED')
  })

  it('falls back to a generic message when the thrown error has none', async () => {
    globalThis.fetch = (async () => { throw {} }) as any
    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi' })
    expect(out.status).toBe(502)
    expect(out.body.error.message).toBe('Failed to reach the target runtime')
  })
})

describe('callProjectAgent — tunnel branch', () => {
  it('relays through relayAgentProxyViaTunnel with the pipeline path and runtime token', async () => {
    store.resolution = { ok: true, kind: 'tunnel', instanceId: 'inst-1', workspaceId: 'ws-1', projectId: 'proj-1' }
    store.relayResponse = new Response(JSON.stringify({ status: 'completed', reply: 'from tunnel' }), { status: 200 })

    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi', runId: 'run-1' })

    expect(out.status).toBe(200)
    expect(out.body.reply).toBe('from tunnel')
    const tunnelOpts = store.relayCalledWith.tunnelOpts
    expect(tunnelOpts.instanceId).toBe('inst-1')
    expect(tunnelOpts.agentPath).toBe('/agent/pipeline/call')
    expect(tunnelOpts.cleanPath).toBe('/agent/pipeline/call')
    expect(tunnelOpts.method).toBe('POST')
    expect(tunnelOpts.headers['x-runtime-token']).toBe('mock-runtime-token')
    expect(JSON.parse(tunnelOpts.body).runId).toBe('run-1')
  })
})

describe('callProjectAgent — desktop (local mode)', () => {
  const previous = process.env.SHOGO_LOCAL_MODE
  beforeEach(() => { process.env.SHOGO_LOCAL_MODE = 'true' })
  afterEach(() => {
    if (previous === undefined) delete process.env.SHOGO_LOCAL_MODE
    else process.env.SHOGO_LOCAL_MODE = previous
  })

  it('calls the target on the host runtime without the cloud tunnel resolver', async () => {
    let capturedUrl = ''
    globalThis.fetch = (async (url: any) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify({ status: 'completed', reply: 'from host' }), { status: 200 })
    }) as any

    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-2', 'ws-1', { message: 'hi' })

    expect(out.status).toBe(200)
    expect(out.body.reply).toBe('from host')
    expect(capturedUrl).toBe('http://127.0.0.1:37658/agent/pipeline/call')
    expect(store.relayCalledWith.hostProjectId).toBe('proj-2')
    expect(store.relayCalledWith.resolveProjectId).toBeUndefined()
    expect(store.tokenCalledWith.projectId).toBe('proj-2')
  })
})

describe('getProjectAgentCall', () => {
  it('reads a completed call from the resolved runtime', async () => {
    let capturedUrl = ''
    globalThis.fetch = (async (url: any) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify({
        callId: 'call-1',
        status: 'completed',
        sessionId: 'run:1',
        reply: 'done',
      }), { status: 200 })
    }) as any

    const out = await svc.getProjectAgentCall(FAKE_CTX, 'proj-1', 'ws-1', 'call-1', 5000)
    expect(out.status).toBe(200)
    expect(out.body.reply).toBe('done')
    expect(capturedUrl).toBe('http://pod.internal:8080/agent/pipeline/call/call-1?waitMs=5000')
  })

  it('forwards status polling through an instance tunnel', async () => {
    store.resolution = { ok: true, kind: 'tunnel', instanceId: 'inst-1', workspaceId: 'ws-1', projectId: 'proj-1' }
    store.relayResponse = new Response(JSON.stringify({ callId: 'call-1', status: 'running', sessionId: 'run:1' }), { status: 200 })
    const out = await svc.getProjectAgentCall(FAKE_CTX, 'proj-1', 'ws-1', 'call-1', 1000)
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('running')
    expect(store.relayCalledWith.tunnelOpts.method).toBe('GET')
    expect(store.relayCalledWith.tunnelOpts.agentPath).toContain('waitMs=1000')
  })
})
