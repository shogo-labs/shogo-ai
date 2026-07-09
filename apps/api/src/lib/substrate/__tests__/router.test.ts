// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { destroyProjectRuntime, getProjectSubstrate, getPublishSubstrate, resizeProjectRuntime, unpublishProjectEverywhere } from '../router'
import { SubstrateUnsupportedError, type ProjectSubstrate, type RuntimeSummary } from '../types'

function fakeSubstrate(kind: 'metal' | 'knative', opts: { resize?: boolean } = {}) {
  const destroyed: string[] = []
  const resized: string[] = []
  const unpublished: string[] = []
  const sub: ProjectSubstrate & { destroyed: string[]; resized: string[]; unpublished: string[] } = {
    kind,
    destroyed,
    resized,
    unpublished,
    async resolveUrl(id) {
      return { url: `http://${kind}/${id}` }
    },
    async getStatus() {
      return { exists: true, ready: true, replicas: 1 }
    },
    async wake(id) {
      return { ready: true, url: `http://${kind}/${id}` }
    },
    async stop() {},
    async destroy(id) {
      destroyed.push(id)
    },
    async listAll(): Promise<RuntimeSummary[]> {
      return []
    },
    async publish(id) {
      return { serverBacked: false, substrate: kind }
    },
    async unpublish(id) {
      unpublished.push(id)
    },
    async wakePublished(id) {
      return { ready: true, url: `http://${kind}/published/${id}` }
    },
    async setPublishedAlwaysOn() {},
  }
  if (opts.resize) {
    sub.resize = async (id: string) => {
      resized.push(id)
    }
  }
  return sub
}

describe('substrate router', () => {
  it('routes metal-eligible projects to the metal substrate', async () => {
    const metal = fakeSubstrate('metal')
    const knative = fakeSubstrate('knative')
    const s = await getProjectSubstrate('p1', {
      _isMetalEnabled: () => true,
      _isMetalEligible: () => true,
      _metalSubstrate: metal,
      _knativeSubstrate: knative,
    })
    expect(s.kind).toBe('metal')
  })

  it('routes ineligible projects to Knative even when metal is enabled', async () => {
    const metal = fakeSubstrate('metal')
    const knative = fakeSubstrate('knative')
    const s = await getProjectSubstrate('p1', {
      _isMetalEnabled: () => true,
      _isMetalEligible: () => false,
      _metalSubstrate: metal,
      _knativeSubstrate: knative,
    })
    expect(s.kind).toBe('knative')
  })

  it('routes to Knative when metal is disabled', async () => {
    const metal = fakeSubstrate('metal')
    const knative = fakeSubstrate('knative')
    const s = await getProjectSubstrate('p1', {
      _isMetalEnabled: () => false,
      _isMetalEligible: () => true,
      _metalSubstrate: metal,
      _knativeSubstrate: knative,
    })
    expect(s.kind).toBe('knative')
  })

  describe('getPublishSubstrate', () => {
    it('routes publishing to metal when metal is publish-authoritative', async () => {
      const metal = fakeSubstrate('metal')
      const knative = fakeSubstrate('knative')
      const s = await getPublishSubstrate('p1', {
        _isPublishMetalAuthoritative: () => true,
        _metalSubstrate: metal,
        _knativeSubstrate: knative,
      })
      expect(s.kind).toBe('metal')
    })

    it('routes publishing to Knative when metal is not publish-authoritative (rollback)', async () => {
      const metal = fakeSubstrate('metal')
      const knative = fakeSubstrate('knative')
      const s = await getPublishSubstrate('p1', {
        _isPublishMetalAuthoritative: () => false,
        _metalSubstrate: metal,
        _knativeSubstrate: knative,
      })
      expect(s.kind).toBe('knative')
    })

    it('ignores the per-project preview rollout (authoritative fleet-wide)', async () => {
      // Even a project the graduated preview rollout would send to Knative
      // publishes to metal once the fleet is publish-authoritative.
      const metal = fakeSubstrate('metal')
      const knative = fakeSubstrate('knative')
      const s = await getPublishSubstrate('ineligible-preview-project', {
        _isPublishMetalAuthoritative: () => true,
        _isMetalEligible: () => false,
        _metalSubstrate: metal,
        _knativeSubstrate: knative,
      })
      expect(s.kind).toBe('metal')
    })
  })

  describe('destroyProjectRuntime', () => {
    it('tears down BOTH substrates (leak-proof during a cutover)', async () => {
      const metal = fakeSubstrate('metal')
      const knative = fakeSubstrate('knative')
      await destroyProjectRuntime('p1', {
        _isKubernetes: () => true,
        _isMetalEnabled: () => true,
        _metalSubstrate: metal,
        _knativeSubstrate: knative,
      })
      expect(metal.destroyed).toContain('p1')
      expect(knative.destroyed).toContain('p1')
    })

    it('is a no-op off Kubernetes (desktop/VM teardown handled elsewhere)', async () => {
      const metal = fakeSubstrate('metal')
      const knative = fakeSubstrate('knative')
      await destroyProjectRuntime('p1', {
        _isKubernetes: () => false,
        _metalSubstrate: metal,
        _knativeSubstrate: knative,
      })
      expect(metal.destroyed).toHaveLength(0)
      expect(knative.destroyed).toHaveLength(0)
    })

    it('destroys Knative only when metal is disabled and no metal substrate injected', async () => {
      const knative = fakeSubstrate('knative')
      await destroyProjectRuntime('p1', {
        _isKubernetes: () => true,
        _isMetalEnabled: () => false,
        _knativeSubstrate: knative,
      })
      expect(knative.destroyed).toContain('p1')
    })

    it('does not let one substrate failure block the other', async () => {
      const metal = fakeSubstrate('metal')
      metal.destroy = async () => {
        throw new Error('metal host down')
      }
      const knative = fakeSubstrate('knative')
      await destroyProjectRuntime('p1', {
        _isKubernetes: () => true,
        _isMetalEnabled: () => true,
        _metalSubstrate: metal,
        _knativeSubstrate: knative,
      })
      // Knative still torn down despite metal throwing.
      expect(knative.destroyed).toContain('p1')
    })
  })

  describe('unpublishProjectEverywhere', () => {
    it('tears down publishing on BOTH substrates (leak-proof during a cutover)', async () => {
      const metal = fakeSubstrate('metal')
      const knative = fakeSubstrate('knative')
      await unpublishProjectEverywhere('p1', 'my-site', {
        _isKubernetes: () => true,
        _isMetalEnabled: () => true,
        _metalSubstrate: metal,
        _knativeSubstrate: knative,
      })
      expect(metal.unpublished).toContain('p1')
      expect(knative.unpublished).toContain('p1')
    })

    it('is a no-op off Kubernetes', async () => {
      const metal = fakeSubstrate('metal')
      const knative = fakeSubstrate('knative')
      await unpublishProjectEverywhere('p1', 'my-site', {
        _isKubernetes: () => false,
        _metalSubstrate: metal,
        _knativeSubstrate: knative,
      })
      expect(metal.unpublished).toHaveLength(0)
      expect(knative.unpublished).toHaveLength(0)
    })

    it('does not let one substrate failure block the other', async () => {
      const metal = fakeSubstrate('metal')
      metal.unpublish = async () => {
        throw new Error('metal host down')
      }
      const knative = fakeSubstrate('knative')
      await unpublishProjectEverywhere('p1', 'my-site', {
        _isKubernetes: () => true,
        _isMetalEnabled: () => true,
        _metalSubstrate: metal,
        _knativeSubstrate: knative,
      })
      expect(knative.unpublished).toContain('p1')
    })
  })

  describe('resizeProjectRuntime', () => {
    it('resizes on a substrate that supports it', async () => {
      const knative = fakeSubstrate('knative', { resize: true })
      await resizeProjectRuntime('p1', { cpu: '2' }, {
        _isMetalEnabled: () => false,
        _knativeSubstrate: knative,
      })
      expect(knative.resized).toContain('p1')
    })

    it('throws SubstrateUnsupportedError on a substrate without resize (metal)', async () => {
      const metal = fakeSubstrate('metal') // no resize
      await expect(
        resizeProjectRuntime('p1', { cpu: '2' }, {
          _isMetalEnabled: () => true,
          _isMetalEligible: () => true,
          _metalSubstrate: metal,
        }),
      ).rejects.toBeInstanceOf(SubstrateUnsupportedError)
    })
  })
})
