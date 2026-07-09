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
import { MetalSubstrate, type MetalBackend, type ServerBackedKv } from '../metal-substrate'
import { KnativeSubstrate, type KnativeBackend } from '../knative-substrate'

interface Spies {
  stopped: string[]
  destroyed: string[]
  resized: string[]
  /** Runtimes provisioned by publish() (serverBacked only creates a runtime). */
  published: string[]
  /** Runtimes torn down by unpublish(). */
  unpublished: string[]
  /** always-on flips: `${subdomain}:${on}`. */
  alwaysOn: string[]
  /** Edge KV state: subdomain → backend value ('knative'|'metal') or absent. */
  kv: Map<string, string>
}

interface Case {
  name: string
  supportsResize: boolean
  make(): { substrate: ProjectSubstrate; spies: Spies }
}

/** A fake edge KV shared by both substrate fakes. */
function makeKv(kv: Map<string, string>): ServerBackedKv {
  return {
    async setServerBackedFlag(subdomain, backend = 'knative') {
      kv.set(subdomain, backend)
      return true
    },
    async clearServerBackedFlag(subdomain) {
      kv.delete(subdomain)
      return true
    },
  }
}

const metalCase: Case = {
  name: 'metal',
  supportsResize: true,
  make() {
    const stopped: string[] = []
    const destroyed: string[] = []
    const resized: string[] = []
    const published: string[] = []
    const unpublished: string[] = []
    const alwaysOn: string[] = []
    const kv = new Map<string, string>()
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
        return { suspended: true, busy: false }
      },
      async destroyProject(id) {
        destroyed.push(id)
      },
      async resizeProject(id) {
        resized.push(id)
      },
      async listProjects() {
        return [{ projectId: 'p1', ready: true, url: 'http://metal/p1', host: 'dal-1', region: 'us' }]
      },
      async getMetalPublishedUrl(id, subdomain) {
        if (id === 'fails') throw new Error('no live metal host')
        published.push(id)
        return { url: `http://metal/published/${subdomain}`, hostId: 'dal-1', region: 'us' }
      },
      async destroyPublished(id) {
        unpublished.push(id)
      },
      async setPublishedAlwaysOn(_id, subdomain, on) {
        alwaysOn.push(`${subdomain}:${on}`)
      },
    }
    return {
      substrate: new MetalSubstrate(backend, makeKv(kv)),
      spies: { stopped, destroyed, resized, published, unpublished, alwaysOn, kv },
    }
  },
}

const knativeCase: Case = {
  name: 'knative',
  supportsResize: true,
  make() {
    const stopped: string[] = []
    const destroyed: string[] = []
    const published: string[] = []
    const unpublished: string[] = []
    const alwaysOn: string[] = []
    const kv = new Map<string, string>()
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
      async createPublishedService(id) {
        published.push(id)
        return `http://knative/published-${id}`
      },
      async createPublishedServerService(id) {
        published.push(id)
        return `http://knative/published-${id}`
      },
      async createPublishedDomainMapping() {
        /* no-op */
      },
      async deletePublishedService(id) {
        unpublished.push(id)
      },
      async deletePublishedDomainMapping() {
        /* no-op */
      },
      async setPublishedMinScale(_id, minScale) {
        alwaysOn.push(`minScale:${minScale}`)
      },
      async healthCheckPublished(id) {
        return id !== 'fails'
      },
    }
    const resolve = async (id: string) => {
      if (id === 'fails') throw new Error('cold-start failed')
      return `http://knative/${id}`
    }
    return {
      substrate: new KnativeSubstrate(backend, resolve, makeKv(kv)),
      spies: { stopped, destroyed, resized: [], published, unpublished, alwaysOn, kv },
    }
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

    // --- publishing surface parity -----------------------------------------

    it('publish(server-backed) provisions a runtime + flags the edge', async () => {
      const { substrate, spies } = c.make()
      const r = await substrate.publish('p1', { subdomain: 'my-site', serverBacked: true })
      expect(r.serverBacked).toBe(true)
      expect(r.substrate).toBe(c.name as any)
      expect(spies.published).toContain('p1')
      // Edge KV flags the subdomain as server-backed (value is substrate-specific).
      expect(spies.kv.get('my-site')).toBeTruthy()
    })

    it('publish(static) provisions NO runtime and clears the edge flag', async () => {
      const { substrate, spies } = c.make()
      const r = await substrate.publish('p1', { subdomain: 'my-site', serverBacked: false })
      expect(r.serverBacked).toBe(false)
      expect(spies.published).not.toContain('p1')
      expect(spies.kv.has('my-site')).toBe(false)
    })

    it('unpublish tears down the runtime + clears the edge flag', async () => {
      const { substrate, spies } = c.make()
      await substrate.publish('p1', { subdomain: 'my-site', serverBacked: true })
      await substrate.unpublish('p1', 'my-site')
      expect(spies.unpublished).toContain('p1')
      expect(spies.kv.has('my-site')).toBe(false)
    })

    it('wakePublished returns ready when the published backend is up', async () => {
      const { substrate } = c.make()
      const r = await substrate.wakePublished('p1', 'my-site')
      expect(r.ready).toBe(true)
    })

    it('wakePublished NEVER throws — ready:false when the backend fails', async () => {
      const { substrate } = c.make()
      const r = await substrate.wakePublished('fails', 'my-site')
      expect(r.ready).toBe(false)
    })

    it('setPublishedAlwaysOn flips the live runtime', async () => {
      const { substrate, spies } = c.make()
      await substrate.setPublishedAlwaysOn('p1', 'my-site', true)
      expect(spies.alwaysOn.length).toBeGreaterThan(0)
    })
  })
}
