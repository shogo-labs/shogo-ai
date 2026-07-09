// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * KnativeSubstrate — the ProjectSubstrate implementation backed by
 * KnativeProjectManager (ksvc + DomainMapping) and the Knative-only pod URL
 * resolver (warm-pool claim → DB mapping → cold createProject).
 *
 * It exists so the whole Knative lifecycle sits behind the same interface as
 * metal: once the fleet is fully drained, deleting this file (and its backend)
 * removes Knative from the product without touching any caller. Held to the same
 * behavioral contract as MetalSubstrate in `__tests__/substrate-contract.test.ts`.
 */

import type { ProjectSubstrate, PublishOpts, PublishResult, Resources, RuntimeStatus, RuntimeSummary, WakeOpts } from './types'
import { shouldServeStaticFromEdgeOnly } from '../publish-substrate-config'

/** The slice of KnativeProjectManager this substrate needs (DI seam for tests). */
export interface KnativeBackend {
  getStatus(projectId: string): Promise<{ exists: boolean; ready: boolean; url: string | null; replicas: number; message?: string }>
  deleteProject(projectId: string): Promise<void>
  scaleProject(projectId: string, replicas: number): Promise<void>
  patchProjectResources(
    projectId: string,
    overrides: { cpu?: string; memory?: string; disk?: string; minScale?: number },
  ): Promise<void>
  listAllServices(): Promise<Array<{ projectId: string; name: string; status: { ready: boolean; url: string | null; replicas: number } }>>
  // --- published site (ksvc + DomainMapping) ---
  createPublishedService(projectId: string, subdomain: string, opts?: { minScale?: number }): Promise<string>
  createPublishedServerService(projectId: string, subdomain: string, opts?: { minScale?: number }): Promise<string>
  createPublishedDomainMapping(subdomain: string, projectId: string): Promise<void>
  deletePublishedService(projectId: string): Promise<void>
  deletePublishedDomainMapping(subdomain: string): Promise<void>
  setPublishedMinScale(projectId: string, minScale: number): Promise<void>
  healthCheckPublished(projectId: string, timeoutMs?: number): Promise<boolean>
}

/**
 * Edge-KV control the substrate uses to steer the Cloudflare Worker's `/api/*`
 * routing for a published subdomain. Injected (defaults to the real KV module)
 * so unit tests can assert the flag transitions without hitting Cloudflare.
 */
export interface ServerBackedKv {
  setServerBackedFlag(subdomain: string, backend?: 'knative' | 'metal'): Promise<boolean>
  clearServerBackedFlag(subdomain: string): Promise<boolean>
}

async function defaultServerBackedKv(): Promise<ServerBackedKv> {
  const mod = await import('../cloudflare-server-backed-kv')
  return { setServerBackedFlag: mod.setServerBackedFlag, clearServerBackedFlag: mod.clearServerBackedFlag }
}

export class KnativeSubstrate implements ProjectSubstrate {
  readonly kind = 'knative' as const

  constructor(
    private readonly backend: KnativeBackend,
    /** Knative-only URL resolver (resolveKnativePodUrl): claim/create + wait. */
    private readonly resolve: (projectId: string) => Promise<string>,
    /** Edge KV steering the Worker's /api/* routing (DI for tests). */
    private readonly kv: ServerBackedKv | (() => Promise<ServerBackedKv>) = defaultServerBackedKv,
  ) {}

  private async serverBackedKv(): Promise<ServerBackedKv> {
    return typeof this.kv === 'function' ? this.kv() : this.kv
  }

  async resolveUrl(projectId: string): Promise<{ url: string }> {
    return { url: await this.resolve(projectId) }
  }

  async getStatus(projectId: string): Promise<RuntimeStatus> {
    const s = await this.backend.getStatus(projectId)
    return { exists: s.exists, ready: s.ready, replicas: s.replicas, url: s.url ?? undefined, message: s.message }
  }

  async wake(projectId: string): Promise<{ ready: boolean; url?: string }> {
    // resolveKnativePodUrl claims a warm pod / creates + waits — i.e. the wake.
    try {
      const url = await this.resolve(projectId)
      return { ready: true, url }
    } catch {
      return { ready: false }
    }
  }

  async stop(projectId: string): Promise<void> {
    // Knative scales to zero on idle; make it explicit for parity with metal stop.
    await this.backend.scaleProject(projectId, 0)
  }

  async destroy(projectId: string): Promise<void> {
    await this.backend.deleteProject(projectId)
  }

  async listAll(): Promise<RuntimeSummary[]> {
    const svcs = await this.backend.listAllServices()
    return svcs.map((s) => ({ projectId: s.projectId, ready: s.status.ready, url: s.status.url ?? undefined }))
  }

  async resize(projectId: string, resources: Resources): Promise<void> {
    await this.backend.patchProjectResources(projectId, {
      cpu: resources.cpu,
      memory: resources.memory,
      disk: resources.disk,
      minScale: resources.minScale,
    })
  }

  // --- publishing surface --------------------------------------------------

  async publish(projectId: string, opts: PublishOpts): Promise<PublishResult> {
    const { subdomain, serverBacked, alwaysOn } = opts
    const minScale = alwaysOn ? 1 : 0
    const kv = await this.serverBackedKv()

    if (serverBacked) {
      const url = await this.backend.createPublishedServerService(projectId, subdomain, { minScale })
      await this.backend.createPublishedDomainMapping(subdomain, projectId)
      await kv.setServerBackedFlag(subdomain, 'knative')
      return { serverBacked: true, substrate: this.kind, url }
    }

    // Static app. The Cloudflare Worker serves it entirely from PUBLISH_BUCKET,
    // so the nginx ksvc is off the hot path. By default (edge-only) we skip it
    // and delete any leftover published ksvc/DomainMapping from a prior
    // server-backed publish, dropping the Knative dependency for static apps.
    await kv.clearServerBackedFlag(subdomain)
    if (shouldServeStaticFromEdgeOnly()) {
      await this.backend.deletePublishedService(projectId).catch(() => {})
      await this.backend.deletePublishedDomainMapping(subdomain).catch(() => {})
      return { serverBacked: false, substrate: this.kind }
    }
    const url = await this.backend.createPublishedService(projectId, subdomain, { minScale })
    await this.backend.createPublishedDomainMapping(subdomain, projectId)
    return { serverBacked: false, substrate: this.kind, url }
  }

  async unpublish(projectId: string, subdomain: string): Promise<void> {
    const kv = await this.serverBackedKv()
    await this.backend.deletePublishedDomainMapping(subdomain).catch(() => {})
    await this.backend.deletePublishedService(projectId).catch(() => {})
    await kv.clearServerBackedFlag(subdomain).catch(() => {})
  }

  async wakePublished(projectId: string, _subdomain: string, opts?: WakeOpts): Promise<{ ready: boolean; url?: string }> {
    // A short probe both reports readiness AND nudges the Knative activator to
    // scale published-{id} up from zero. Never throws (the visitor page polls).
    try {
      const ready = await this.backend.healthCheckPublished(projectId, opts?.waitMs ?? 5000)
      return { ready }
    } catch {
      return { ready: false }
    }
  }

  async setPublishedAlwaysOn(projectId: string, _subdomain: string, on: boolean): Promise<void> {
    await this.backend.setPublishedMinScale(projectId, on ? 1 : 0)
  }
}
