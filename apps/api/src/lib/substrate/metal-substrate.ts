// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * MetalSubstrate — the ProjectSubstrate implementation backed by the
 * MetalWarmPoolController (control plane) + the node-agent HTTP API on each
 * bare-metal host. It is the metal analog of KnativeSubstrate; the two are held
 * to the same behavioral contract in `__tests__/substrate-contract.test.ts`.
 *
 * All heavy lifting lives in the controller (routing, stickiness, /assign,
 * /stop, /destroy, /status fan-out); this class is a thin, testable adapter that
 * maps controller results onto the substrate contract.
 */

import type { ProjectSubstrate, PublishOpts, PublishResult, Resources, RuntimeStatus, RuntimeSummary, WakeOpts } from './types'
import { getMetalWarmPoolController, type StopResult } from '../metal-warm-pool-controller'

/** The slice of MetalWarmPoolController this substrate needs (DI seam for tests). */
export interface MetalBackend {
  getMetalProjectUrl(projectId: string): Promise<string>
  getProjectStatus(projectId: string): Promise<{ exists: boolean; ready: boolean; replicas: number; url?: string }>
  stopProject(projectId: string): Promise<StopResult>
  destroyProject(projectId: string): Promise<void>
  resizeProject(projectId: string, resources: { cpu?: string; memory?: string; disk?: string; minScale?: number }): Promise<void>
  listProjects(): Promise<RuntimeSummary[]>
  // --- published site (published:{id} microVM) ---
  getMetalPublishedUrl(projectId: string, subdomain: string, opts?: { alwaysOn?: boolean }): Promise<{ url: string; hostId?: string; region?: string }>
  destroyPublished(projectId: string, subdomain?: string): Promise<void>
  setPublishedAlwaysOn(projectId: string, subdomain: string, on: boolean): Promise<void>
}

/** Edge-KV control for the Worker's /api/* routing (DI for tests). */
export interface ServerBackedKv {
  setServerBackedFlag(subdomain: string, backend?: 'knative' | 'metal'): Promise<boolean>
  clearServerBackedFlag(subdomain: string): Promise<boolean>
}

async function defaultServerBackedKv(): Promise<ServerBackedKv> {
  const mod = await import('../cloudflare-server-backed-kv')
  return { setServerBackedFlag: mod.setServerBackedFlag, clearServerBackedFlag: mod.clearServerBackedFlag }
}

export class MetalSubstrate implements ProjectSubstrate {
  readonly kind = 'metal' as const

  constructor(
    private readonly backend: MetalBackend = getMetalWarmPoolController(),
    private readonly kv: ServerBackedKv | (() => Promise<ServerBackedKv>) = defaultServerBackedKv,
  ) {}

  private async serverBackedKv(): Promise<ServerBackedKv> {
    return typeof this.kv === 'function' ? this.kv() : this.kv
  }

  async resolveUrl(projectId: string): Promise<{ url: string }> {
    return { url: await this.backend.getMetalProjectUrl(projectId) }
  }

  async getStatus(projectId: string): Promise<RuntimeStatus> {
    return this.backend.getProjectStatus(projectId)
  }

  async wake(projectId: string): Promise<{ ready: boolean; url?: string }> {
    // getMetalProjectUrl resumes-from-snapshot on a hit, else claims a warm VM —
    // i.e. it IS the wake. Contract: never throw (callers poll on ready:false).
    try {
      const url = await this.backend.getMetalProjectUrl(projectId)
      return { ready: true, url }
    } catch {
      return { ready: false }
    }
  }

  async stop(projectId: string): Promise<void> {
    await this.backend.stopProject(projectId)
  }

  async destroy(projectId: string): Promise<void> {
    await this.backend.destroyProject(projectId)
  }

  async listAll(): Promise<RuntimeSummary[]> {
    return this.backend.listProjects()
  }

  async resize(projectId: string, resources: Resources): Promise<void> {
    // Firecracker can't hot-change vCPU/RAM: the controller pushes the always-on
    // flag live to the owning host and the new size lands on the next cold
    // boot/resume (the assign env, derived from the tier, is re-read then).
    await this.backend.resizeProject(projectId, {
      cpu: resources.cpu,
      memory: resources.memory,
      disk: resources.disk,
      minScale: resources.minScale,
    })
  }

  // --- publishing surface --------------------------------------------------

  async publish(projectId: string, opts: PublishOpts): Promise<PublishResult> {
    const { subdomain, serverBacked, alwaysOn } = opts
    const kv = await this.serverBackedKv()

    if (!serverBacked) {
      // Static apps serve entirely from PUBLISH_BUCKET + the Cloudflare Worker —
      // no microVM. Clear the server-backed flag (edge serves /api/* from OCI,
      // if any) and tear down any leftover published VM from a prior
      // server-backed publish.
      await kv.clearServerBackedFlag(subdomain)
      await this.backend.destroyPublished(projectId, subdomain).catch(() => {})
      return { serverBacked: false, substrate: this.kind }
    }

    // Server-backed: boot/refresh the always-on published microVM and flag the
    // edge to proxy `/api/*` to the API published endpoint (backend='metal').
    const { url } = await this.backend.getMetalPublishedUrl(projectId, subdomain, { alwaysOn })
    await kv.setServerBackedFlag(subdomain, 'metal')
    return { serverBacked: true, substrate: this.kind, url }
  }

  async unpublish(projectId: string, subdomain: string): Promise<void> {
    const kv = await this.serverBackedKv()
    await this.backend.destroyPublished(projectId, subdomain).catch(() => {})
    await kv.clearServerBackedFlag(subdomain).catch(() => {})
  }

  async wakePublished(projectId: string, subdomain: string, _opts?: WakeOpts): Promise<{ ready: boolean; url?: string }> {
    // getMetalPublishedUrl resumes-from-snapshot on a hit, else claims + boots —
    // i.e. it IS the wake. Contract: never throw (callers poll on ready:false).
    try {
      const placement = await this.backend
        .getMetalPublishedUrl(projectId, subdomain)
        .catch(() => null)
      if (placement?.url) return { ready: true, url: placement.url }
      return { ready: false }
    } catch {
      return { ready: false }
    }
  }

  async setPublishedAlwaysOn(projectId: string, subdomain: string, on: boolean): Promise<void> {
    await this.backend.setPublishedAlwaysOn(projectId, subdomain, on)
  }
}
