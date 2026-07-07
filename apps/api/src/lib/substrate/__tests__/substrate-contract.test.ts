// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Shared ProjectSubstrate contract — the parity proof.
 *
 * This is the "reuse the Knative tests" requirement made concrete: the SAME
 * behavioral suite runs against BOTH the KnativeSubstrate (backed by a fake
 * KnativeProjectManager, mirroring the assertions in knative-project-manager
 * tests) and the MetalSubstrate (backed by a fake MetalWarmPoolController). If a
 * case passes for one and not the other, metal is not at parity.
 *
 * Each case builds a fresh backend + spies so tests are isolated. The special
 * project ids are shared vocabulary:
 *   'p1'    → a healthy, ready project
 *   'gone'  → a project with no runtime
 *   'fails' → a backend that fails to wake (never throws out of wake())
 */

import { describe, expect, it } from 'bun:test'
import type { ProjectSubstrate } from '../types'
import { MetalSubstrate, type MetalBackend } from '../metal-substrate'
import { KnativeSubstrate, type KnativeBackend } from '../knative-substrate'

interface Spies {
  stopped: string[]
  destroyed: string[]
}

interface Case {
  name: string
  supportsResize: boolean
  make(): { substrate: ProjectSubstrate; spies: Spies }
}

const metalCase: Case = {
  name: 'metal',
  supportsResize: false,
  make() {
    const stopped: string[] = []
    const destroyed: string[] = []
    const backend: MetalBackend = {
      async getMetalProjectUrl(id) {
        if (id === 'fails') throw new Error('no live metal host')
        return `http://metal/${id}`
      },
      async getProjectStatus(id) {
        if (id === 'gone') return { exists: false, ready: false, replicas: 0 }
        return { exists: true, ready: true, replicas: 1, url: `http://metal/${id}` }
      },
      async stopProject(id) {
        stopped.push(id)
      },
      async destroyProject(id) {
        destroyed.push(id)
      },
      async listProjects() {
        return [{ projectId: 'p1', ready: true, url: 'http://metal/p1', host: 'dal-1', region: 'us' }]
      },
    }
    return { substrate: new MetalSubstrate(backend), spies: { stopped, destroyed } }
  },
}

const knativeCase: Case = {
  name: 'knative',
  supportsResize: true,
  make() {
    const stopped: string[] = []
    const destroyed: string[] = []
    const backend: KnativeBackend = {
      async getStatus(id) {
        if (id === 'gone') return { exists: false, ready: false, url: null, replicas: 0 }
        return { exists: true, ready: true, url: `http://knative/${id}`, replicas: 1 }
      },
      async deleteProject(id) {
        destroyed.push(id)
      },
      async scaleProject(id, replicas) {
        if (replicas === 0) stopped.push(id)
      },
      async patchProjectResources() {
        /* recorded by the resize case below */
      },
      async listAllServices() {
        return [{ projectId: 'p1', name: 'project-p1', status: { ready: true, url: 'http://knative/p1', replicas: 1 } }]
      },
    }
    const resolve = async (id: string) => {
      if (id === 'fails') throw new Error('cold-start failed')
      return `http://knative/${id}`
    }
    return { substrate: new KnativeSubstrate(backend, resolve), spies: { stopped, destroyed } }
  },
}

for (const c of [metalCase, knativeCase]) {
  describe(`ProjectSubstrate contract: ${c.name}`, () => {
    it('exposes its kind', () => {
      const { substrate } = c.make()
      expect(substrate.kind).toBe(c.name as any)
    })

    it('resolveUrl returns a url for a ready project', async () => {
      const { substrate } = c.make()
      const { url } = await substrate.resolveUrl('p1')
      expect(url).toContain('p1')
    })

    it('getStatus reports exists/ready/replicas for a live project', async () => {
      const { substrate } = c.make()
      const status = await substrate.getStatus('p1')
      expect(status.exists).toBe(true)
      expect(status.ready).toBe(true)
      expect(status.replicas).toBe(1)
    })

    it('getStatus reports a missing project as not existing', async () => {
      const { substrate } = c.make()
      const status = await substrate.getStatus('gone')
      expect(status.exists).toBe(false)
      expect(status.replicas).toBe(0)
    })

    it('wake returns ready + url when the backend is up', async () => {
      const { substrate } = c.make()
      const r = await substrate.wake('p1')
      expect(r.ready).toBe(true)
      expect(r.url).toContain('p1')
    })

    it('wake NEVER throws — returns ready:false when the backend fails', async () => {
      const { substrate } = c.make()
      const r = await substrate.wake('fails')
      expect(r.ready).toBe(false)
      expect(r.url).toBeUndefined()
    })

    it('stop suspends/scales-to-zero the project', async () => {
      const { substrate, spies } = c.make()
      await substrate.stop('p1')
      expect(spies.stopped).toContain('p1')
    })

    it('destroy tears the runtime down', async () => {
      const { substrate, spies } = c.make()
      await substrate.destroy('p1')
      expect(spies.destroyed).toContain('p1')
    })

    it('listAll returns runtime summaries', async () => {
      const { substrate } = c.make()
      const all = await substrate.listAll()
      expect(all.length).toBeGreaterThan(0)
      expect(all[0].projectId).toBe('p1')
      expect(all[0].ready).toBe(true)
    })

    it(`resize is ${c.supportsResize ? 'supported' : 'not implemented'}`, async () => {
      const { substrate } = c.make()
      if (c.supportsResize) {
        expect(typeof substrate.resize).toBe('function')
        await substrate.resize!('p1', { cpu: '2', memory: '4Gi' })
      } else {
        expect(substrate.resize).toBeUndefined()
      }
    })
  })
}
