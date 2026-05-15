// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Machines API
 *
 * Typed client for listing paired Shogo machines (desktops + VPS workers)
 * and managing a project's "Run on" preference — i.e. which paired
 * machine the cloud should route `agent-proxy/*` traffic to for a given
 * project. Powers the external-trigger workflow: a Jira webhook hitting
 * the canonical project URL is forwarded through the pinned machine's
 * tunnel into the agent running on that machine.
 *
 * Cloud endpoints (require authenticated session OR a `shogo_sk_*` key):
 *   - GET    /api/instances?workspaceId=…
 *   - GET    /api/instances/online?workspaceId=…
 *   - GET    /api/instances/:id
 *   - PUT    /api/projects/:projectId/preferred-instance
 *   - DELETE /api/projects/:projectId/preferred-instance
 *
 * See:
 *   - apps/docs/docs/features/external-triggers/quickstart.md for the
 *     user-facing story.
 *   - apps/api/src/lib/agent-proxy-resolver.ts for the routing rules.
 */

import type { HttpClient } from '../http/client.js'

// =============================================================================
// Types
// =============================================================================

/** How the cloud should treat an offline pinned instance. */
export type PreferredInstancePolicy = 'pinned' | 'prefer'

/** Distinguishes desktop sign-ins from `shogo worker` CLI sign-ins. */
export type MachineKind = 'desktop' | 'cli_worker'

/** Live, derived status. `heartbeat` means we've seen an HTTP heartbeat
 * recently but the WebSocket tunnel is not currently open. */
export type MachineStatus = 'online' | 'heartbeat' | 'offline'

export interface Machine {
  id: string
  workspaceId: string
  name: string
  hostname: string
  os: string | null
  arch: string | null
  kind: MachineKind
  status: MachineStatus
  lastSeenAt: string | null
  /** Optional structured metadata uploaded with the worker's heartbeat. */
  metadata?: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export interface OnlineMachine {
  id: string
  name: string
  hostname: string
  kind: MachineKind
}

export interface PinProjectOptions {
  /** Target machine UUID. */
  instanceId: string
  /**
   * - 'pinned' (default): if the machine is offline, return 503 — the
   *   external caller retries until the machine comes back. Use this when
   *   you NEED the request to land on a specific VPS (channel secrets,
   *   filesystem state, etc).
   * - 'prefer': if the machine is offline, fall back to a cloud pod. Use
   *   this when the agent is stateless and either runtime is acceptable.
   */
  policy?: PreferredInstancePolicy
}

export interface PinProjectResult {
  ok: boolean
  preferredInstanceId: string
  preferredInstancePolicy: PreferredInstancePolicy
  instance: { id: string; name: string }
}

/** Shape returned by `GET /api/projects/:id/preferred-instance`. Reflects
 * the persisted Project.preferredInstance* fields, plus the joined
 * Instance row for display. */
export interface ProjectPin {
  preferredInstanceId: string | null
  preferredInstancePolicy: PreferredInstancePolicy
  instance: {
    id: string
    name: string
    hostname: string
    kind: MachineKind
  } | null
}

// =============================================================================
// MachinesApi
// =============================================================================

/**
 * @example
 * ```ts
 * const client = createClient({ apiUrl: 'https://api.shogo.ai', shogoApiKey })
 *
 * const machines = await client.machines.list({ workspaceId })
 * const vps = machines.find((m) => m.name === 'prod-vps-1')
 * if (vps) {
 *   await client.machines.pinProject(projectId, { instanceId: vps.id })
 *   // External webhooks hitting:
 *   //   POST https://api.shogo.ai/api/projects/<projectId>/agent-proxy/agent/channels/webhook/incoming
 *   // now relay through the worker on prod-vps-1.
 * }
 * ```
 */
export class MachinesApi {
  constructor(private http: HttpClient) {}

  /** List all paired machines (desktop + worker) for a workspace. */
  async list(opts: { workspaceId: string }): Promise<Machine[]> {
    const res = await this.http.get<{ instances: Machine[] }>('/api/instances', {
      workspaceId: opts.workspaceId,
    })
    return res.data?.instances ?? []
  }

  /** List only currently-online machines (trimmed shape; used by pickers). */
  async listOnline(opts: { workspaceId: string }): Promise<OnlineMachine[]> {
    const res = await this.http.get<{ instances: OnlineMachine[] }>('/api/instances/online', {
      workspaceId: opts.workspaceId,
    })
    return res.data?.instances ?? []
  }

  /** Fetch a single machine by ID. */
  async get(id: string): Promise<Machine | null> {
    const res = await this.http.get<Machine>(`/api/instances/${encodeURIComponent(id)}`)
    return res.data ?? null
  }

  /**
   * Read a project's current pin. Returns `preferredInstanceId: null`
   * when the project is cloud-routed (the default).
   */
  async getProjectPin(projectId: string): Promise<ProjectPin> {
    const res = await this.http.get<ProjectPin>(
      `/api/projects/${encodeURIComponent(projectId)}/preferred-instance`,
    )
    return (
      res.data ?? {
        preferredInstanceId: null,
        preferredInstancePolicy: 'pinned',
        instance: null,
      }
    )
  }

  /**
   * Pin a project to a specific paired machine. Future external-trigger
   * requests to `/api/projects/:projectId/agent-proxy/*` will be relayed
   * through that machine's outbound tunnel instead of a cloud pod.
   */
  async pinProject(projectId: string, opts: PinProjectOptions): Promise<PinProjectResult> {
    const body: { instanceId: string; policy?: PreferredInstancePolicy } = {
      instanceId: opts.instanceId,
    }
    if (opts.policy) body.policy = opts.policy
    const res = await this.http.request<PinProjectResult>(
      `/api/projects/${encodeURIComponent(projectId)}/preferred-instance`,
      { method: 'PUT', body },
    )
    if (!res.data) throw new Error('Failed to pin project')
    return res.data
  }

  /** Clear the project's pin, restoring cloud-pod routing. */
  async unpinProject(projectId: string): Promise<void> {
    await this.http.delete(
      `/api/projects/${encodeURIComponent(projectId)}/preferred-instance`,
    )
  }
}
