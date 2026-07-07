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

import type { ProjectSubstrate, RuntimeStatus, RuntimeSummary } from './types'
import { getMetalWarmPoolController } from '../metal-warm-pool-controller'

/** The slice of MetalWarmPoolController this substrate needs (DI seam for tests). */
export interface MetalBackend {
  getMetalProjectUrl(projectId: string): Promise<string>
  getProjectStatus(projectId: string): Promise<{ exists: boolean; ready: boolean; replicas: number; url?: string }>
  stopProject(projectId: string): Promise<void>
  destroyProject(projectId: string): Promise<void>
  listProjects(): Promise<RuntimeSummary[]>
}

export class MetalSubstrate implements ProjectSubstrate {
  readonly kind = 'metal' as const

  constructor(private readonly backend: MetalBackend = getMetalWarmPoolController()) {}

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

  // `resize` intentionally omitted: metal warm-pool VMs are pool-uniform-sized,
  // so per-project sizing isn't supported yet (the router raises
  // SubstrateUnsupportedError). Tracked as a parity follow-up.
}
