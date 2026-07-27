// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  resolveAgentProxyPodUrl,
  type AgentProxyResolverDeps,
} from '../lib/agent-proxy-resolver'

// Use a no-op console.error spy in every test so error-path log output
// doesn't drown the test runner. Restored in afterEach.
let errorSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
})

function deps(over: Partial<AgentProxyResolverDeps>): AgentProxyResolverDeps {
  // Provide safe defaults for env probes so a test only specifies what matters.
  return {
    isKubernetes: () => false,
    ...over,
  }
}

describe('resolveAgentProxyPodUrl — happy path', () => {
  test('returns ok:true with the resolved URL when the resolver succeeds', async () => {
    const resolver = mock(async () => ({ url: 'http://10.0.0.5:3001' }))
    const out = await resolveAgentProxyPodUrl('proj_1', deps({ resolver: resolver as any }))
    expect(out).toEqual({ ok: true, kind: 'pod', url: 'http://10.0.0.5:3001' })
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  test('forwards the projectId and default logTag to the resolver', async () => {
    const resolver = mock(async () => ({ url: 'http://x' }))
    await resolveAgentProxyPodUrl('proj_2', deps({ resolver: resolver as any }))
    const [projectId, opts] = resolver.mock.calls[0]
    expect(projectId).toBe('proj_2')
    expect(opts.logTag).toBe('AgentProxy') // default
  })

  test('forwards a custom logTag to the resolver', async () => {
    const resolver = mock(async () => ({ url: 'http://x' }))
    await resolveAgentProxyPodUrl('p', deps({ resolver: resolver as any, logTag: 'CustomTag' }))
    expect(resolver.mock.calls[0][1].logTag).toBe('CustomTag')
  })

  test('forwards a custom runtimeManager to the resolver', async () => {
    const resolver = mock(async () => ({ url: 'http://x' }))
    const rm = { __id: 'fake-runtime' } as any
    await resolveAgentProxyPodUrl('p', deps({ resolver: resolver as any, runtimeManager: rm }))
    expect(resolver.mock.calls[0][1].runtimeManager).toBe(rm)
  })
})

describe('resolveAgentProxyPodUrl — Kubernetes branch', () => {
  test('returns 502 proxy_error when running on K8s and the resolver throws', async () => {
    const resolver = mock(async () => {
      throw new Error('pod not found')
    })
    const out = await resolveAgentProxyPodUrl('p', deps({
      resolver: resolver as any,
      isKubernetes: () => true,
    }))
    expect(out).toEqual({
      ok: false,
      status: 502,
      body: { error: { code: 'proxy_error', message: 'pod not found' } },
    })
  })

  test('forwards the original err.message into the response', async () => {
    const resolver = mock(async () => {
      throw new Error('k8s api connection reset')
    })
    const out = await resolveAgentProxyPodUrl('p', deps({
      resolver: resolver as any,
      isKubernetes: () => true,
    }))
    if (!out.ok) expect(out.body.error.message).toBe('k8s api connection reset')
  })

  test('falls back to a default message when the K8s error has no message', async () => {
    const resolver = mock(async () => {
      throw new Error('')
    })
    const out = await resolveAgentProxyPodUrl('p', deps({
      resolver: resolver as any,
      isKubernetes: () => true,
    }))
    if (!out.ok) expect(out.body.error.message).toBe('Failed to resolve agent pod')
  })
})

describe('resolveAgentProxyPodUrl — local / host-runtime fallback', () => {
  test('returns 503 agent_start_failed when K8s is not enabled and resolver throws', async () => {
    const resolver = mock(async () => {
      throw new Error('vite never came up')
    })
    const out = await resolveAgentProxyPodUrl('p', deps({
      resolver: resolver as any,
      isKubernetes: () => false,
    }))
    expect(out).toEqual({
      ok: false,
      status: 503,
      body: { error: { code: 'agent_start_failed', message: 'vite never came up' } },
    })
  })

  test('falls back to a default message when host-runtime error has no message', async () => {
    const resolver = mock(async () => {
      throw new Error('')
    })
    const out = await resolveAgentProxyPodUrl('p', deps({ resolver: resolver as any }))
    if (!out.ok) expect(out.body.error.message).toBe('Failed to start agent runtime')
  })

  test('handles a non-Error throw (string / undefined) without crashing', async () => {
    const resolver = mock(async () => {
      throw 'string thrown' as unknown as Error
    })
    const out = await resolveAgentProxyPodUrl('p', deps({ resolver: resolver as any }))
    expect(out.ok).toBe(false)
    if (!out.ok) {
      // err?.message is undefined → default kicks in.
      expect(out.body.error.message).toBe('Failed to start agent runtime')
      expect(out.status).toBe(503)
    }
  })
})

describe('resolveAgentProxyPodUrl — logging', () => {
  test('emits a console.error tagged with the configured logTag on the K8s path', async () => {
    const resolver = mock(async () => {
      throw new Error('boom')
    })
    await resolveAgentProxyPodUrl('p', deps({
      resolver: resolver as any,
      isKubernetes: () => true,
      logTag: 'TestTag',
    }))
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toContain('[TestTag]')
  })

  test('emits a console.error on the local-fallback path with the projectId', async () => {
    const resolver = mock(async () => {
      throw new Error('boom')
    })
    await resolveAgentProxyPodUrl('proj_logged', deps({ resolver: resolver as any }))
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toContain('proj_logged')
  })

  test('does NOT log when the resolver succeeds', async () => {
    const resolver = mock(async () => ({ url: 'http://x' }))
    await resolveAgentProxyPodUrl('p', deps({ resolver: resolver as any }))
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
