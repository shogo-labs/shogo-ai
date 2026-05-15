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
    isVMIsolation: () => false,
    isKubernetes: () => false,
    ...over,
  }
}

class VMPoolPermanentlyDisabledError extends Error {
  constructor(msg = 'VM pool perma-disabled') {
    super(msg)
  }
}

describe('resolveAgentProxyPodUrl — happy path', () => {
  test('returns ok:true with the resolved URL when the resolver succeeds', async () => {
    const resolver = mock(async () => ({ url: 'http://10.0.0.5:3001' }))
    const out = await resolveAgentProxyPodUrl('proj_1', deps({ resolver: resolver as any }))
    expect(out).toEqual({ ok: true, url: 'http://10.0.0.5:3001' })
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  test('passes the projectId and onVMPermanentlyDisabled="fallback-to-host" to the resolver', async () => {
    const resolver = mock(async () => ({ url: 'http://x' }))
    await resolveAgentProxyPodUrl('proj_2', deps({ resolver: resolver as any }))
    const [projectId, opts] = resolver.mock.calls[0]
    expect(projectId).toBe('proj_2')
    expect(opts.onVMPermanentlyDisabled).toBe('fallback-to-host')
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

describe('resolveAgentProxyPodUrl — VMPoolPermanentlyDisabledError', () => {
  test('returns 503 vm_pool_unavailable when the resolver throws VMPoolPermanentlyDisabledError', async () => {
    const err = new VMPoolPermanentlyDisabledError('pool drained')
    const resolver = mock(async () => {
      throw err
    })
    const out = await resolveAgentProxyPodUrl('p', deps({ resolver: resolver as any }))
    expect(out).toEqual({
      ok: false,
      status: 503,
      body: { error: { code: 'vm_pool_unavailable', message: 'pool drained' } },
    })
  })

  test('falls back to a default message when the error has no message', async () => {
    const err = new VMPoolPermanentlyDisabledError('')
    const resolver = mock(async () => {
      throw err
    })
    const out = await resolveAgentProxyPodUrl('p', deps({ resolver: resolver as any }))
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.body.error.message).toBe('VM pool permanently disabled')
    }
  })

  test('the VMPool branch fires regardless of isVMIsolation/isKubernetes (constructor.name match wins)', async () => {
    const err = new VMPoolPermanentlyDisabledError('drained')
    const resolver = mock(async () => {
      throw err
    })
    // Both env probes true — the VMPool path should still take precedence.
    const out = await resolveAgentProxyPodUrl('p', deps({
      resolver: resolver as any,
      isVMIsolation: () => true,
      isKubernetes: () => true,
    }))
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.body.error.code).toBe('vm_pool_unavailable')
      expect(out.status).toBe(503)
    }
  })
})

describe('resolveAgentProxyPodUrl — VM isolation enabled', () => {
  test('returns 503 vm_pool_unavailable when VM isolation is on and the resolver throws', async () => {
    const resolver = mock(async () => {
      throw new Error('pool not ready')
    })
    const out = await resolveAgentProxyPodUrl('p', deps({
      resolver: resolver as any,
      isVMIsolation: () => true,
    }))
    expect(out).toEqual({
      ok: false,
      status: 503,
      body: {
        error: {
          code: 'vm_pool_unavailable',
          message: 'VM isolation is enabled but the pool is not ready. Retrying...',
        },
      },
    })
  })

  test('uses a fixed message (not err.message) when VM isolation is the active branch', async () => {
    const resolver = mock(async () => {
      throw new Error('some internal driver error')
    })
    const out = await resolveAgentProxyPodUrl('p', deps({
      resolver: resolver as any,
      isVMIsolation: () => true,
    }))
    if (!out.ok) {
      // Operator-visible message is sanitized — driver internals don't leak.
      expect(out.body.error.message).not.toContain('driver')
      expect(out.body.error.message).toBe(
        'VM isolation is enabled but the pool is not ready. Retrying...'
      )
    }
  })

  test('VM isolation branch wins over the K8s branch when both probes are true', async () => {
    const resolver = mock(async () => {
      throw new Error('boom')
    })
    const out = await resolveAgentProxyPodUrl('p', deps({
      resolver: resolver as any,
      isVMIsolation: () => true,
      isKubernetes: () => true,
    }))
    if (!out.ok) expect(out.body.error.code).toBe('vm_pool_unavailable')
  })
})

describe('resolveAgentProxyPodUrl — Kubernetes branch', () => {
  test('returns 502 proxy_error when running on K8s and the resolver throws', async () => {
    const resolver = mock(async () => {
      throw new Error('pod not found')
    })
    const out = await resolveAgentProxyPodUrl('p', deps({
      resolver: resolver as any,
      isVMIsolation: () => false,
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
  test('returns 503 agent_start_failed when neither VM nor K8s is enabled and resolver throws', async () => {
    const resolver = mock(async () => {
      throw new Error('vite never came up')
    })
    const out = await resolveAgentProxyPodUrl('p', deps({
      resolver: resolver as any,
      isVMIsolation: () => false,
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
