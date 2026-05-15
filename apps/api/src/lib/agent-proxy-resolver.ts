// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Agent-proxy route resolution.
 *
 * The agent-proxy route (`/api/projects/:id/agent-proxy/*`) has to decide
 * where to forward each request before it touches the wire. There are
 * two terminal outcomes:
 *
 *   - kind: 'pod'    → forward to a cloud pod URL (existing behavior).
 *   - kind: 'tunnel' → relay through the paired Instance's WebSocket
 *                       tunnel into the worker on the user's VPS / laptop.
 *
 * Which one fires is driven by `Project.preferredInstanceId`:
 *
 *   1. If the project pins an Instance and the tunnel is live anywhere
 *      in the cluster, return 'tunnel'.
 *   2. If the project pins an Instance but the tunnel is offline:
 *        - `preferredInstancePolicy = 'pinned'` (default) → 503 so the
 *          external caller retries instead of silently fanning out
 *          to a cloud pod that has no channel config.
 *        - `preferredInstancePolicy = 'prefer'` → fall through to the
 *          cloud resolver. Useful when channels are mirrored.
 *   3. Otherwise (no pin) → existing cloud-pod resolution.
 *
 * Keeping this as a pure function gated by injected deps lets us unit
 * test all four routing combinations without importing `server.ts` (which
 * boots Prisma, the AI proxy, billing, etc. at import time).
 */

import type { IRuntimeManager } from './runtime/types'
import { resolveProjectPodUrl, type ResolvePodUrlOpts } from './resolve-pod-url'
import { prisma } from './prisma'
import { isTunnelConnectedAnywhere } from './tunnel-redis'

/** Cached project routing fields needed by the resolver. */
export interface ProjectRoutingRecord {
  workspaceId: string
  preferredInstanceId: string | null
  preferredInstancePolicy: string
}

export type AgentProxyResolution =
  | { ok: true; kind: 'pod'; url: string }
  | {
      ok: true
      kind: 'tunnel'
      instanceId: string
      workspaceId: string
      /** Surfaced so the relay layer can update lastUsedAt / log. */
      projectId: string
    }
  | { ok: false; status: 502 | 503; body: { error: { code: string; message: string } } }

export interface AgentProxyResolverDeps {
  /** Override the pod helper for tests. Defaults to the production one. */
  resolver?: (projectId: string, opts: ResolvePodUrlOpts) => ReturnType<typeof resolveProjectPodUrl>
  /** Test-only env probes; default to `process.env`. */
  isVMIsolation?: () => boolean
  isKubernetes?: () => boolean
  /** Test-only RuntimeManager wiring (passed through to the helper). */
  runtimeManager?: IRuntimeManager
  /** Tag included in error log lines. Default: `AgentProxy`. */
  logTag?: string
  /**
   * Project lookup — defaults to a single `prisma.project.findUnique` for
   * routing fields. Override in tests.
   *
   * Returning `null` is treated as "no routing hint" and falls through to
   * the existing cloud resolver, so a stale URL hits the same 404 surface
   * it always did.
   */
  loadProject?: (projectId: string) => Promise<ProjectRoutingRecord | null>
  /**
   * Live tunnel check — defaults to the Redis-primary, in-memory-fallback
   * helper in `tunnel-redis.ts`. Override in tests.
   */
  isTunnelOnline?: (instanceId: string) => Promise<boolean>
}

const defaultIsVMIsolation = () => process.env.SHOGO_VM_ISOLATION === 'true'
const defaultIsKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

const defaultLoadProject = async (projectId: string): Promise<ProjectRoutingRecord | null> => {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      workspaceId: true,
      preferredInstanceId: true,
      preferredInstancePolicy: true,
    },
  })
  return row
}

/**
 * Resolve where the agent proxy should forward a request for `projectId`.
 *
 * - Project pins an online Instance → 'tunnel' (instance routing wins
 *   over VM isolation and K8s — pinning is the user's explicit override).
 * - Project pins an offline Instance, policy 'pinned'  → 503 instance_offline.
 * - Project pins an offline Instance, policy 'prefer'  → fall through.
 * - VM permanently disabled → falls back to host.
 * - VM transiently unavailable → 503.
 * - K8s pod resolver throws → 502.
 * - Host start fails → 503.
 */
export async function resolveAgentProxyPodUrl(
  projectId: string,
  deps: AgentProxyResolverDeps = {},
): Promise<AgentProxyResolution> {
  const resolver = deps.resolver ?? resolveProjectPodUrl
  const isVMIsolation = deps.isVMIsolation ?? defaultIsVMIsolation
  const isKubernetes = deps.isKubernetes ?? defaultIsKubernetes
  const loadProject = deps.loadProject ?? defaultLoadProject
  const isTunnelOnline = deps.isTunnelOnline ?? isTunnelConnectedAnywhere
  const logTag = deps.logTag ?? 'AgentProxy'

  // ─── Instance pin (runs before VM/K8s on purpose) ────────────────────
  // The pin is an explicit user choice persisted on the Project row;
  // honor it before any cluster-side routing kicks in. A bad pin (e.g.
  // dangling instanceId after DB drift) returns 503 with policy='pinned'
  // so external callers retry instead of silently hitting a cloud pod
  // that has no channel config.
  let project: ProjectRoutingRecord | null = null
  try {
    project = await loadProject(projectId)
  } catch (err: any) {
    // Project lookup is best-effort: if Prisma is unavailable, fall back
    // to cloud resolution rather than 500-ing on every webhook request.
    console.warn(
      `[${logTag}] loadProject failed for ${projectId}, falling back to cloud routing:`,
      err?.message ?? err,
    )
  }

  if (project?.preferredInstanceId) {
    let online = false
    try {
      online = await isTunnelOnline(project.preferredInstanceId)
    } catch (err: any) {
      // If Redis is down we can't prove the tunnel is alive; treat it
      // as offline and let the policy decide the user-visible behavior.
      console.warn(
        `[${logTag}] isTunnelConnectedAnywhere failed for ${project.preferredInstanceId}:`,
        err?.message ?? err,
      )
    }

    if (online) {
      return {
        ok: true,
        kind: 'tunnel',
        instanceId: project.preferredInstanceId,
        workspaceId: project.workspaceId,
        projectId,
      }
    }

    if (project.preferredInstancePolicy !== 'prefer') {
      // 'pinned' (default) and any unrecognized value fail closed.
      return {
        ok: false,
        status: 503,
        body: {
          error: {
            code: 'instance_offline',
            message:
              'The instance this project is pinned to is offline. ' +
              'Start it with `shogo worker start`, or re-run with policy=prefer to fall back to the cloud.',
          },
        },
      }
    }
    // policy === 'prefer' → fall through to cloud resolution.
    console.warn(
      `[${logTag}] preferredInstance ${project.preferredInstanceId} for project ${projectId} is offline; ` +
        `falling back to cloud pod (policy=prefer)`,
    )
  }

  // ─── Cloud pod resolution (unchanged) ────────────────────────────────
  try {
    const res = await resolver(projectId, {
      logTag,
      onVMPermanentlyDisabled: 'fallback-to-host',
      runtimeManager: deps.runtimeManager,
    })
    return { ok: true, kind: 'pod', url: res.url }
  } catch (err: any) {
    // The helper rethrows VMPoolPermanentlyDisabledError only when
    // `onVMPermanentlyDisabled: 'throw'` is set — which we never do
    // here. This branch exists as a guard for future signature
    // changes; better a clear 503 than silently bringing up a host
    // runtime without anyone asking for it.
    const errName = err?.constructor?.name ?? ''
    if (errName === 'VMPoolPermanentlyDisabledError') {
      console.error(`[${logTag}] VM pool permanently disabled and host fallback failed:`, err.message)
      return { ok: false, status: 503, body: { error: { code: 'vm_pool_unavailable', message: err.message || 'VM pool permanently disabled' } } }
    }
    if (isVMIsolation()) {
      console.error(`[${logTag}] VM pool unavailable:`, err.message)
      return {
        ok: false,
        status: 503,
        body: { error: { code: 'vm_pool_unavailable', message: 'VM isolation is enabled but the pool is not ready. Retrying...' } },
      }
    }
    if (isKubernetes()) {
      console.error(`[${logTag}] K8s pod resolution error:`, err)
      return { ok: false, status: 502, body: { error: { code: 'proxy_error', message: err.message || 'Failed to resolve agent pod' } } }
    }
    console.error(`[${logTag}] Failed to auto-start runtime for ${projectId}:`, err)
    return { ok: false, status: 503, body: { error: { code: 'agent_start_failed', message: err.message || 'Failed to start agent runtime' } } }
  }
}
