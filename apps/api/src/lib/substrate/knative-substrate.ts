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

import type { ProjectSubstrate, Resources, RuntimeStatus, RuntimeSummary } from './types'

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
}

export class KnativeSubstrate implements ProjectSubstrate {
  readonly kind = 'knative' as const

  constructor(
    private readonly backend: KnativeBackend,
    /** Knative-only URL resolver (resolveKnativePodUrl): claim/create + wait. */
    private readonly resolve: (projectId: string) => Promise<string>,
  ) {}

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
}
