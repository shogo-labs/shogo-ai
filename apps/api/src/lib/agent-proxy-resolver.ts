// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Agent-proxy route's pod URL resolution + error-shaping helper.
 *
 * Lifted out of `server.ts:agent-proxy` so the resolution policy
 * (which fallback flag, which retry budget, which error → HTTP code
 * mapping) is in one place AND can be HTTP-integration-tested without
 * importing all of `server.ts` (which runs a lot of side-effectful
 * init at import time — Prisma, AI proxy, billing service, etc).
 *
 * The route handler stays thin: auth, then call this, then either
 * proxy the request (success) or return the error response (failure).
 */

import type { IRuntimeManager } from './runtime/types'
import { resolveProjectPodUrl, type ResolvePodUrlOpts } from './resolve-pod-url'

export type AgentProxyResolution =
  | { ok: true; url: string }
  | { ok: false; status: 502 | 503; body: { error: { code: string; message: string } } }

export interface AgentProxyResolverDeps {
  /** Override the helper for tests. Defaults to the production one. */
  resolver?: (projectId: string, opts: ResolvePodUrlOpts) => ReturnType<typeof resolveProjectPodUrl>
  /** Test-only env probes; default to `process.env`. */
  isVMIsolation?: () => boolean
  isKubernetes?: () => boolean
  /** Test-only RuntimeManager wiring (passed through to the helper). */
  runtimeManager?: IRuntimeManager
  /** Tag included in error log lines. Default: `AgentProxy`. */
  logTag?: string
}

const defaultIsVMIsolation = () => process.env.SHOGO_VM_ISOLATION === 'true'
const defaultIsKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

/**
 * Resolve where the agent proxy should forward a request for `projectId`.
 *
 * - VM permanently disabled → falls back to host (chat traffic must
 *   keep flowing; see `resolve-pod-url.ts` for the deeper rationale).
 * - VM transiently unavailable → 503 (client retries).
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
  const logTag = deps.logTag ?? 'AgentProxy'

  try {
    const res = await resolver(projectId, {
      logTag,
      onVMPermanentlyDisabled: 'fallback-to-host',
      runtimeManager: deps.runtimeManager,
    })
    return { ok: true, url: res.url }
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
