// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it, mock } from 'bun:test'
import { resolveAgentProxyPodUrl } from '../agent-proxy-resolver'

class VMPoolPermanentlyDisabledError extends Error {
  constructor(msg = 'VM warm pool permanently disabled') {
    super(msg)
    this.name = 'VMPoolPermanentlyDisabledError'
  }
}

function makeResolver(impl: (projectId: string, opts: any) => any) {
  return mock(async (projectId: string, opts: any) => impl(projectId, opts))
}

/** Default: no instance pin (mirrors a fresh Project row). */
const noPin = async () => ({
  workspaceId: 'ws-1',
  preferredInstanceId: null,
  preferredInstancePolicy: 'pinned',
})

describe('resolveAgentProxyPodUrl', () => {
  describe('cloud-pod success', () => {
    it('returns ok with kind=pod + url from resolver when no pin', async () => {
      const resolver = makeResolver(() => ({ url: 'http://10.0.0.1:8080', mode: 'k8s' }))
      const res = await resolveAgentProxyPodUrl('proj-1', {
        resolver: resolver as any,
        isVMIsolation: () => false,
        isKubernetes: () => true,
        loadProject: noPin,
      })
      expect(res).toEqual({ ok: true, kind: 'pod', url: 'http://10.0.0.1:8080' })
      expect(resolver).toHaveBeenCalledTimes(1)
    })

    it('passes logTag, fallback policy, and runtimeManager through to resolver', async () => {
      let capturedOpts: any
      const resolver = makeResolver((_pid, opts) => {
        capturedOpts = opts
        return { url: 'http://host:1234' }
      })
      const fakeRm = { status: () => null, start: async () => ({}) } as any
      await resolveAgentProxyPodUrl('proj-2', {
        resolver: resolver as any,
        isVMIsolation: () => false,
        isKubernetes: () => false,
        runtimeManager: fakeRm,
        logTag: 'CustomTag',
        loadProject: noPin,
      })
      expect(capturedOpts.logTag).toBe('CustomTag')
      expect(capturedOpts.onVMPermanentlyDisabled).toBe('fallback-to-host')
      expect(capturedOpts.runtimeManager).toBe(fakeRm)
    })

    it('defaults logTag to AgentProxy when not supplied', async () => {
      let capturedOpts: any
      const resolver = makeResolver((_pid, opts) => {
        capturedOpts = opts
        return { url: 'http://host:1234' }
      })
      await resolveAgentProxyPodUrl('proj-3', {
        resolver: resolver as any,
        isVMIsolation: () => false,
        isKubernetes: () => false,
        loadProject: noPin,
      })
      expect(capturedOpts.logTag).toBe('AgentProxy')
    })
  })

  describe('instance pin', () => {
    it('returns kind=tunnel when pinned + online', async () => {
      const resolver = makeResolver(() => {
        throw new Error('cloud resolver should not be called when pinned + online')
      })
      const res = await resolveAgentProxyPodUrl('proj-pin', {
        resolver: resolver as any,
        loadProject: async () => ({
          workspaceId: 'ws-9',
          preferredInstanceId: 'inst-vps-1',
          preferredInstancePolicy: 'pinned',
        }),
        isTunnelOnline: async () => true,
        isVMIsolation: () => true,  // pinning beats VM isolation
        isKubernetes: () => true,
      })
      expect(res).toEqual({
        ok: true,
        kind: 'tunnel',
        instanceId: 'inst-vps-1',
        workspaceId: 'ws-9',
        projectId: 'proj-pin',
      })
      expect(resolver).not.toHaveBeenCalled()
    })

    it('returns 503 instance_offline when pinned + offline + policy=pinned', async () => {
      const resolver = makeResolver(() => ({ url: 'http://10.0.0.1:8080' }))
      const res = await resolveAgentProxyPodUrl('proj-pin', {
        resolver: resolver as any,
        loadProject: async () => ({
          workspaceId: 'ws-9',
          preferredInstanceId: 'inst-vps-1',
          preferredInstancePolicy: 'pinned',
        }),
        isTunnelOnline: async () => false,
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(503)
        expect(res.body.error.code).toBe('instance_offline')
      }
      expect(resolver).not.toHaveBeenCalled()
    })

    it('treats unrecognized policy as pinned (fail closed)', async () => {
      const resolver = makeResolver(() => ({ url: 'http://10.0.0.1:8080' }))
      const res = await resolveAgentProxyPodUrl('proj-pin', {
        resolver: resolver as any,
        loadProject: async () => ({
          workspaceId: 'ws-9',
          preferredInstanceId: 'inst-vps-1',
          preferredInstancePolicy: 'something-new',  // unknown -> fail closed
        }),
        isTunnelOnline: async () => false,
      })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.body.error.code).toBe('instance_offline')
      expect(resolver).not.toHaveBeenCalled()
    })

    it('falls through to cloud resolver when pinned + offline + policy=prefer', async () => {
      const resolver = makeResolver(() => ({ url: 'http://cloud-pod:8080' }))
      const res = await resolveAgentProxyPodUrl('proj-pin', {
        resolver: resolver as any,
        loadProject: async () => ({
          workspaceId: 'ws-9',
          preferredInstanceId: 'inst-vps-1',
          preferredInstancePolicy: 'prefer',
        }),
        isTunnelOnline: async () => false,
        isVMIsolation: () => false,
        isKubernetes: () => false,
      })
      expect(res).toEqual({ ok: true, kind: 'pod', url: 'http://cloud-pod:8080' })
      expect(resolver).toHaveBeenCalledTimes(1)
    })

    it('treats isTunnelOnline throw as offline (best-effort) and applies policy', async () => {
      const resolver = makeResolver(() => ({ url: 'http://cloud-pod:8080' }))
      const res = await resolveAgentProxyPodUrl('proj-pin', {
        resolver: resolver as any,
        loadProject: async () => ({
          workspaceId: 'ws-9',
          preferredInstanceId: 'inst-vps-1',
          preferredInstancePolicy: 'pinned',
        }),
        isTunnelOnline: async () => {
          throw new Error('redis down')
        },
      })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.body.error.code).toBe('instance_offline')
    })

    it('falls through to cloud when loadProject throws (best-effort)', async () => {
      const resolver = makeResolver(() => ({ url: 'http://cloud-pod:8080' }))
      const res = await resolveAgentProxyPodUrl('proj-pin', {
        resolver: resolver as any,
        loadProject: async () => {
          throw new Error('db down')
        },
        isVMIsolation: () => false,
        isKubernetes: () => false,
      })
      expect(res).toEqual({ ok: true, kind: 'pod', url: 'http://cloud-pod:8080' })
    })

    it('falls through to cloud when loadProject returns null', async () => {
      const resolver = makeResolver(() => ({ url: 'http://cloud-pod:8080' }))
      const res = await resolveAgentProxyPodUrl('proj-missing', {
        resolver: resolver as any,
        loadProject: async () => null,
        isVMIsolation: () => false,
        isKubernetes: () => false,
      })
      expect(res).toEqual({ ok: true, kind: 'pod', url: 'http://cloud-pod:8080' })
    })
  })

  describe('error paths', () => {
    it('returns 503 vm_pool_unavailable when VMPoolPermanentlyDisabledError surfaces (guard branch)', async () => {
      const resolver = makeResolver(() => {
        throw new VMPoolPermanentlyDisabledError('pool gone')
      })
      const res = await resolveAgentProxyPodUrl('proj-1', {
        resolver: resolver as any,
        isVMIsolation: () => false,
        isKubernetes: () => false,
        loadProject: noPin,
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(503)
        expect(res.body.error.code).toBe('vm_pool_unavailable')
        expect(res.body.error.message).toBe('pool gone')
      }
    })

    it('returns 503 vm_pool_unavailable when VM isolation is enabled and resolver throws', async () => {
      const resolver = makeResolver(() => {
        throw new Error('boom')
      })
      const res = await resolveAgentProxyPodUrl('proj-1', {
        resolver: resolver as any,
        isVMIsolation: () => true,
        isKubernetes: () => false,
        loadProject: noPin,
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(503)
        expect(res.body.error.code).toBe('vm_pool_unavailable')
        expect(res.body.error.message).toContain('VM isolation')
      }
    })

    it('returns 502 proxy_error when running in K8s and resolver throws', async () => {
      const resolver = makeResolver(() => {
        throw new Error('k8s api down')
      })
      const res = await resolveAgentProxyPodUrl('proj-1', {
        resolver: resolver as any,
        isVMIsolation: () => false,
        isKubernetes: () => true,
        loadProject: noPin,
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(502)
        expect(res.body.error.code).toBe('proxy_error')
        expect(res.body.error.message).toBe('k8s api down')
      }
    })

    it('falls back to k8s 502 with default message when error has no message', async () => {
      const resolver = makeResolver(() => {
        const e: any = new Error()
        e.message = ''
        throw e
      })
      const res = await resolveAgentProxyPodUrl('proj-1', {
        resolver: resolver as any,
        isVMIsolation: () => false,
        isKubernetes: () => true,
        loadProject: noPin,
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(502)
        expect(res.body.error.message).toBe('Failed to resolve agent pod')
      }
    })

    it('returns 503 agent_start_failed in host mode (neither VM nor K8s)', async () => {
      const resolver = makeResolver(() => {
        throw new Error('port in use')
      })
      const res = await resolveAgentProxyPodUrl('proj-1', {
        resolver: resolver as any,
        isVMIsolation: () => false,
        isKubernetes: () => false,
        loadProject: noPin,
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(503)
        expect(res.body.error.code).toBe('agent_start_failed')
        expect(res.body.error.message).toBe('port in use')
      }
    })

    it('host-mode fallback uses default message when error has no message', async () => {
      const resolver = makeResolver(() => {
        throw new Error('')
      })
      const res = await resolveAgentProxyPodUrl('proj-1', {
        resolver: resolver as any,
        isVMIsolation: () => false,
        isKubernetes: () => false,
        loadProject: noPin,
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.body.error.message).toBe('Failed to start agent runtime')
      }
    })

    it('prefers VMPoolPermanentlyDisabled branch over VM isolation branch', async () => {
      const resolver = makeResolver(() => {
        throw new VMPoolPermanentlyDisabledError('permanent')
      })
      const res = await resolveAgentProxyPodUrl('proj-1', {
        resolver: resolver as any,
        isVMIsolation: () => true,
        isKubernetes: () => true,
        loadProject: noPin,
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(503)
        expect(res.body.error.code).toBe('vm_pool_unavailable')
        expect(res.body.error.message).toBe('permanent')
      }
    })

    it('prefers VM isolation branch over K8s branch when both flags are true', async () => {
      const resolver = makeResolver(() => {
        throw new Error('generic err')
      })
      const res = await resolveAgentProxyPodUrl('proj-1', {
        resolver: resolver as any,
        isVMIsolation: () => true,
        isKubernetes: () => true,
        loadProject: noPin,
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(503)
        expect(res.body.error.code).toBe('vm_pool_unavailable')
      }
    })
  })

  describe('env-probe defaults', () => {
    it('reads SHOGO_VM_ISOLATION and KUBERNETES_SERVICE_HOST when not overridden', async () => {
      const prevVM = process.env.SHOGO_VM_ISOLATION
      const prevK8s = process.env.KUBERNETES_SERVICE_HOST
      process.env.SHOGO_VM_ISOLATION = 'true'
      delete process.env.KUBERNETES_SERVICE_HOST
      try {
        const resolver = makeResolver(() => {
          throw new Error('x')
        })
        const res = await resolveAgentProxyPodUrl('proj-1', {
          resolver: resolver as any,
          loadProject: noPin,
        })
        expect(res.ok).toBe(false)
        if (!res.ok) expect(res.body.error.code).toBe('vm_pool_unavailable')
      } finally {
        if (prevVM === undefined) delete process.env.SHOGO_VM_ISOLATION
        else process.env.SHOGO_VM_ISOLATION = prevVM
        if (prevK8s === undefined) delete process.env.KUBERNETES_SERVICE_HOST
        else process.env.KUBERNETES_SERVICE_HOST = prevK8s
      }
    })
  })
})
