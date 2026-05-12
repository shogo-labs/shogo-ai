// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * HTTP-level integration test for agent-proxy VM routing.
 *
 * Locks down the contract that prompted the 1.6.2 split-brain hang
 * fix: `app.all('/api/projects/:projectId/agent-proxy/*')` must
 * respect `SHOGO_VM_ISOLATION` and route to the warm-pool URL,
 * NOT silently call `runtimeManager.start()` like the original code
 * did. A unit test on `resolveProjectPodUrl` (see
 * `lib/__tests__/resolve-pod-url.test.ts`) covers the helper itself;
 * this test covers the route's *wiring* of that helper:
 *
 *   - request → Hono routing → agent-proxy-resolver → resolver →
 *     outbound fetch URL
 *
 * Implementation note: this test does NOT import `server.ts` (which
 * runs heavy side-effectful init at module load — Prisma client,
 * AI proxy, billing service, etc). Instead it mounts the same
 * `resolveAgentProxyPodUrl` helper into a tiny Hono app whose
 * structure mirrors the production route exactly (auth-stub →
 * resolve → proxy via fetch → return). The production route is one
 * line that calls the same helper, so regressions there show up
 * here too.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import {
  resolveAgentProxyPodUrl,
  type AgentProxyResolverDeps,
} from '../lib/agent-proxy-resolver'
import type { ResolvePodUrlOpts, ResolvedPod } from '../lib/resolve-pod-url'

class FakeVMPoolPermanentlyDisabledError extends Error {
  consecutiveFailures: number
  constructor(consecutiveFailures = 3) {
    super(`VM warm pool permanently disabled (${consecutiveFailures} failures)`)
    this.name = 'VMPoolPermanentlyDisabledError'
    this.consecutiveFailures = consecutiveFailures
  }
}

/**
 * Construct a tiny Hono app whose `/api/projects/:projectId/agent-proxy/*`
 * route follows the same auth → resolve → proxy structure as
 * `server.ts`. The outbound proxy fetch is recorded so the test can
 * assert which URL the route picked.
 *
 * The `deps` object lets each test inject its own resolver and
 * env-probe behaviour, simulating VM-on / VM-off / pool-failing
 * conditions without touching `process.env`.
 */
function buildTestApp(deps: AgentProxyResolverDeps & {
  fetchImpl?: (input: any, init?: any) => Promise<Response>
}) {
  const app = new Hono()
  const fetchCalls: string[] = []
  const fetchImpl = deps.fetchImpl ?? (async (input: any) => {
    fetchCalls.push(typeof input === 'string' ? input : input.url)
    return new Response('proxied-ok', { status: 200 })
  })

  app.all('/api/projects/:projectId/agent-proxy/*', async (c) => {
    const projectId = c.req.param('projectId')
    const requestPath = c.req.path.replace(`/api/projects/${projectId}/agent-proxy`, '') || '/'

    const resolution = await resolveAgentProxyPodUrl(projectId, deps)
    if (!resolution.ok) return c.json(resolution.body, resolution.status)

    const target = `${resolution.url}${requestPath}`
    const proxied = await fetchImpl(target, { method: c.req.method })
    return new Response(await proxied.text(), { status: proxied.status })
  })

  return { app, fetchCalls }
}

describe('agent-proxy HTTP routing — VM isolation contract', () => {
  // Each test resets process.env touches to guarantee no cross-test leakage.
  beforeEach(() => {
    delete process.env.SHOGO_VM_ISOLATION
    delete process.env.KUBERNETES_SERVICE_HOST
  })

  it('routes outbound fetch to VM URL when SHOGO_VM_ISOLATION=true (NEVER host)', async () => {
    const resolver = mock(async (_projectId: string, opts: ResolvePodUrlOpts): Promise<ResolvedPod> => {
      // The helper should be called with the policy that prevents
      // the original split-brain bug. If a future refactor changes
      // these opts, this test fails LOUDLY.
      expect(opts.logTag).toBe('AgentProxy')
      expect(opts.onVMPermanentlyDisabled).toBe('fallback-to-host')
      return { mode: 'vm', url: 'http://localhost:39200' }
    })

    const { app, fetchCalls } = buildTestApp({
      resolver,
      isVMIsolation: () => true,
      isKubernetes: () => false,
    })

    const res = await app.request('/api/projects/proj-1/agent-proxy/agent/health')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('proxied-ok')
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(fetchCalls).toEqual(['http://localhost:39200/agent/health'])
  })

  it('routes outbound fetch to host URL when SHOGO_VM_ISOLATION is unset', async () => {
    const resolver = mock(async (): Promise<ResolvedPod> => ({
      mode: 'host',
      url: 'http://localhost:38500',
      runtime: {
        id: 'proj-1',
        port: 37500,
        agentPort: 38500,
        status: 'running',
        url: 'http://localhost:37500',
        startedAt: Date.now(),
      },
    }))

    const { app, fetchCalls } = buildTestApp({
      resolver,
      isVMIsolation: () => false,
      isKubernetes: () => false,
    })

    const res = await app.request('/api/projects/proj-1/agent-proxy/agent/health')
    expect(res.status).toBe(200)
    expect(fetchCalls).toEqual(['http://localhost:38500/agent/health'])
  })

  it('routes outbound fetch to K8s pod URL when KUBERNETES_SERVICE_HOST is set', async () => {
    const resolver = mock(async (): Promise<ResolvedPod> => ({
      mode: 'k8s',
      url: 'http://project-pod.cluster.local:8080',
    }))

    const { app, fetchCalls } = buildTestApp({
      resolver,
      isVMIsolation: () => false,
      isKubernetes: () => true,
    })

    await app.request('/api/projects/proj-1/agent-proxy/anything')
    expect(fetchCalls).toEqual(['http://project-pod.cluster.local:8080/anything'])
  })

  it('returns 503 when VM isolation is on and the pool is still warming up (transient)', async () => {
    const resolver = mock(async () => {
      throw new Error('transient: warm pool has 0 ready VMs')
    })

    const { app, fetchCalls } = buildTestApp({
      resolver,
      isVMIsolation: () => true,
      isKubernetes: () => false,
    })

    const res = await app.request('/api/projects/proj-1/agent-proxy/agent/health')
    expect(res.status).toBe(503)
    const body = (await res.json()) as any
    expect(body.error?.code).toBe('vm_pool_unavailable')
    // CRITICAL: outbound fetch must NOT happen — that would be the
    // original split-brain regression (warm pool not ready, but
    // route silently hits host runtime anyway).
    expect(fetchCalls).toEqual([])
  })

  it('falls back to host when VM warm pool is permanently disabled', async () => {
    let attempts = 0
    const resolver = mock(async (_projectId: string, opts: ResolvePodUrlOpts): Promise<ResolvedPod> => {
      attempts++
      // First call: helper internally caught VMPoolPermanentlyDisabledError
      // and used its 'fallback-to-host' policy → returned host result.
      // We simulate the post-fallback state here.
      expect(opts.onVMPermanentlyDisabled).toBe('fallback-to-host')
      return {
        mode: 'host',
        url: 'http://localhost:38500',
        runtime: { id: 'p', port: 37500, agentPort: 38500, status: 'running', url: 'http://localhost:37500', startedAt: 0 },
      }
    })

    const { app, fetchCalls } = buildTestApp({
      resolver,
      isVMIsolation: () => true,
      isKubernetes: () => false,
    })

    const res = await app.request('/api/projects/proj-1/agent-proxy/agent/health')
    expect(res.status).toBe(200)
    expect(attempts).toBe(1)
    expect(fetchCalls).toEqual(['http://localhost:38500/agent/health'])
  })

  it('returns 503 when VMPoolPermanentlyDisabledError reaches the route (belt-and-braces)', async () => {
    // The helper would only do this if `onVMPermanentlyDisabled: 'throw'`
    // — which the production route never sets — but the agent-proxy
    // resolver has a defensive branch for it. This test pins it down.
    const resolver = mock(async () => {
      throw new FakeVMPoolPermanentlyDisabledError(7)
    })

    const { app, fetchCalls } = buildTestApp({
      resolver,
      isVMIsolation: () => true,
      isKubernetes: () => false,
    })

    const res = await app.request('/api/projects/proj-1/agent-proxy/agent/health')
    expect(res.status).toBe(503)
    const body = (await res.json()) as any
    expect(body.error?.code).toBe('vm_pool_unavailable')
    expect(fetchCalls).toEqual([])
  })

  it('returns 502 when K8s pod resolver throws', async () => {
    const resolver = mock(async () => { throw new Error('knative: namespace not found') })

    const { app, fetchCalls } = buildTestApp({
      resolver,
      isVMIsolation: () => false,
      isKubernetes: () => true,
    })

    const res = await app.request('/api/projects/proj-1/agent-proxy/agent/health')
    expect(res.status).toBe(502)
    const body = (await res.json()) as any
    expect(body.error?.code).toBe('proxy_error')
    expect(fetchCalls).toEqual([])
  })

  it('returns 503 when host RuntimeManager fails to start (non-VM, non-K8s)', async () => {
    const resolver = mock(async () => { throw new Error('host: port range exhausted') })

    const { app, fetchCalls } = buildTestApp({
      resolver,
      isVMIsolation: () => false,
      isKubernetes: () => false,
    })

    const res = await app.request('/api/projects/proj-1/agent-proxy/agent/health')
    expect(res.status).toBe(503)
    const body = (await res.json()) as any
    expect(body.error?.code).toBe('agent_start_failed')
    expect(fetchCalls).toEqual([])
  })

  it('preserves the request path when proxying (no path truncation across URL join)', async () => {
    const resolver = mock(async (): Promise<ResolvedPod> => ({ mode: 'vm', url: 'http://localhost:39200' }))
    const { app, fetchCalls } = buildTestApp({
      resolver,
      isVMIsolation: () => true,
      isKubernetes: () => false,
    })

    await app.request('/api/projects/proj-1/agent-proxy/agent/chat')
    await app.request('/api/projects/proj-1/agent-proxy/agent/channels/webchat/widget.js')
    await app.request('/api/projects/proj-1/agent-proxy/')
    expect(fetchCalls).toEqual([
      'http://localhost:39200/agent/chat',
      'http://localhost:39200/agent/channels/webchat/widget.js',
      'http://localhost:39200/',
    ])
  })

  it('regression: VM-on + concurrent in-flight host runtime status must NEVER produce a split-brain', async () => {
    // The 1.6.2 bug: agent-proxy unconditionally called
    // `runtimeManager.start()`. Even if the resolver said "VM",
    // the host runtime got created in parallel. We assert the
    // resolver controls which URL is used — there's no
    // `runtimeManager.start()` path inside the route anymore.
    const resolver = mock(async (): Promise<ResolvedPod> => ({ mode: 'vm', url: 'http://localhost:39200' }))
    let hostStartCalls = 0
    const fakeRuntimeManager = {
      start: async () => { hostStartCalls++; return null as any },
      status: () => null,
      stop: async () => {},
      restart: async () => null as any,
      getHealth: async () => ({ healthy: true, lastCheck: 0 }),
      stopAll: async () => {},
      getActiveProjects: () => [],
    }

    const { app } = buildTestApp({
      resolver,
      isVMIsolation: () => true,
      isKubernetes: () => false,
      runtimeManager: fakeRuntimeManager,
    })

    await app.request('/api/projects/proj-1/agent-proxy/agent/health')
    expect(hostStartCalls).toBe(0)
  })
})
