// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Single source of truth for "where is project P's agent runtime?"
 *
 * Before this helper existed, six different sites in apps/api duplicated
 * the same `if (k8s) … else if (SHOGO_VM_ISOLATION) … else host` cascade:
 *
 *   - `routes/runtime.ts`        — `/start`, `/sandbox/url`, `/restart`
 *   - `routes/project-chat.ts`   — `getProjectUrl()`
 *   - `server.ts`                — `/agent-proxy/*` route, `resolveAgentRuntimeUrl`
 *
 * Each copy got the K8s and VM cases right, but the original `server.ts`
 * pair forgot the `SHOGO_VM_ISOLATION` gate entirely — silently starting
 * a host RuntimeManager in parallel with the warm pool and producing
 * the split-brain "Connecting to agent runtime…" hang that 1.6.2 users
 * reported. With every new RuntimeManager caller, the odds of someone
 * forgetting the gate again grew.
 *
 * This helper makes the resolution declarative and testable, with
 * three knobs that capture every variation seen in the call sites:
 *
 *   - logTag: identifies the caller in fallback/error log lines.
 *   - onVMPermanentlyDisabled: 'throw' for /sandbox/url (a
 *     split-brain there would mis-render the preview) vs.
 *     'fallback-to-host' for chat traffic (a working host runtime
 *     is strictly better than a permanently-503'd VM).
 *   - VM retry loop (maxVMRetries / vmRetryDelayMs): project-chat
 *     used to retry transient warm-pool errors 5 times inline; now
 *     it threads those values through here instead.
 *
 * Tests (see `__tests__/resolve-pod-url.test.ts`) cover each branch.
 */

import type { IProjectRuntime, IRuntimeManager } from './runtime/types'

export type PodMode = 'k8s' | 'vm' | 'host'

export type ResolvedPod =
  | { mode: 'k8s'; url: string }
  | { mode: 'vm'; url: string }
  | { mode: 'host'; url: string; runtime: IProjectRuntime }

export interface ResolvePodUrlOpts {
  /**
   * Log tag included in fallback/error log lines so the originating
   * caller is identifiable in `main.log`
   * (e.g. `[AgentProxy]`, `[Runtime]`, `[ProjectChat]`).
   */
  logTag?: string

  /**
   * Behaviour when VM_ISOLATION is on and the warm pool has reached
   * `MAX_CONSECUTIVE_FAILURES` boot failures.
   *
   *   - `'throw'` (default): re-throw `VMPoolPermanentlyDisabledError`.
   *     Use for routes where a host fallback would create a
   *     split-brain (e.g. `/sandbox/url`'s preview iframe).
   *   - `'fallback-to-host'`: spin up the host RuntimeManager
   *     instead. Use for agent traffic paths (chat, agent-proxy)
   *     where a working host runtime beats a permanently-503'd VM.
   */
  onVMPermanentlyDisabled?: 'throw' | 'fallback-to-host'

  /**
   * If VM isolation throws a *transient* error (warm pool still
   * trying to boot the first VM), retry up to `maxVMRetries` times
   * with `vmRetryDelayMs` between attempts.
   *
   * Defaults: no retry, throw the first transient error so the
   * caller can decide whether to 503 or return early. project-chat
   * passes `{ maxVMRetries: 5, vmRetryDelayMs: 3000 }` to preserve
   * its prior inline behaviour.
   */
  maxVMRetries?: number
  vmRetryDelayMs?: number

  /**
   * RuntimeManager instance for host mode. Production callers pass
   * their existing `runtimeManager` here (so tests, /sandbox/url and
   * `/runtime/start` all share the same manager instance). Pass
   * `undefined` and the helper resolves it lazily via
   * `getRuntimeManager()`.
   */
  runtimeManager?: IRuntimeManager

  /**
   * Test-only overrides for the K8s and VM resolvers. In production
   * these are dynamically imported from the relevant lib modules,
   * preserving the existing cold-start cost shape (the helper itself
   * never pulls k8s/VM dependencies until first call).
   */
  _k8sResolver?: (projectId: string) => Promise<string>
  _vmResolver?: (projectId: string) => Promise<string>
  _vmPoolPermanentlyDisabledError?: new (...args: any[]) => Error

  /**
   * Test-only overrides for the env-driven mode probes. In
   * production these read `process.env`.
   */
  _isKubernetes?: () => boolean
  _isVMIsolation?: () => boolean
}

/**
 * Default mode probes used in production.
 */
function defaultIsKubernetes(): boolean {
  // Matches `apps/api/src/server.ts:96` and project-chat.ts. Don't
  // expand the check without auditing every caller — false positives
  // here send all desktop traffic to a Knative manager that doesn't
  // exist outside k8s.
  return !!process.env.KUBERNETES_SERVICE_HOST
}

function defaultIsVMIsolation(): boolean {
  return process.env.SHOGO_VM_ISOLATION === 'true'
}

/**
 * Resolve the agent-runtime URL for `projectId`, honouring the
 * desktop/K8s/VM/host hierarchy.
 *
 * On the host path this calls `runtimeManager.start(projectId)`,
 * which is idempotent — returns the existing runtime if running,
 * deduplicates concurrent starts. Callers that need stop-then-start
 * (e.g. `/runtime/restart`) should `await manager.stop(projectId)`
 * BEFORE calling this helper.
 */
export async function resolveProjectPodUrl(
  projectId: string,
  opts: ResolvePodUrlOpts = {},
): Promise<ResolvedPod> {
  const tag = opts.logTag ?? 'PodResolver'
  const isKubernetes = opts._isKubernetes ?? defaultIsKubernetes
  const isVMIsolation = opts._isVMIsolation ?? defaultIsVMIsolation

  if (isKubernetes()) {
    const resolver = opts._k8sResolver
      ?? (await import('./knative-project-manager')).getProjectPodUrl
    const url = await resolver(projectId)
    return { mode: 'k8s', url }
  }

  if (isVMIsolation()) {
    const vmPool = opts._vmResolver
      ? { getVMProjectUrl: opts._vmResolver, VMPoolPermanentlyDisabledError: opts._vmPoolPermanentlyDisabledError }
      : await import('./vm-warm-pool-controller')
    const { getVMProjectUrl, VMPoolPermanentlyDisabledError } = vmPool

    const maxRetries = Math.max(1, opts.maxVMRetries ?? 1)
    const retryDelayMs = opts.vmRetryDelayMs ?? 0

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const url = await getVMProjectUrl(projectId)
        return { mode: 'vm', url }
      } catch (err) {
        const isPermanent =
          VMPoolPermanentlyDisabledError != null && err instanceof VMPoolPermanentlyDisabledError
        if (isPermanent) {
          if (opts.onVMPermanentlyDisabled === 'fallback-to-host') {
            const consecutiveFailures = (err as any).consecutiveFailures ?? 'unknown'
            console.warn(
              `[${tag}] VM warm pool permanently disabled (${consecutiveFailures} boot failures); ` +
                `falling back to host RuntimeManager for ${projectId}. ` +
                `Set vmIsolation.enabled=false in the desktop config to silence this warning.`,
            )
            break // fall through to host path
          }
          throw err
        }
        // Transient — retry if budget remains.
        if (attempt === maxRetries) throw err
        console.log(`[${tag}] VM not ready (attempt ${attempt}/${maxRetries}), retrying in ${retryDelayMs}ms...`)
        if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs))
      }
    }
    // Fell through from the permanent-disabled branch; resolve via host.
  }

  // Host mode.
  const manager: IRuntimeManager = opts.runtimeManager
    ?? (await import('./runtime/index')).getRuntimeManager()

  // Only short-circuit when the runtime is fully `running` AND has an
  // `agentPort` (the latter guards an interrupted-boot edge case where
  // a stale `running` runtime is missing its agent port).
  //
  // The `status !== 'running'` half catches the prewarm race: `doStart()`
  // (apps/api/src/lib/runtime/manager.ts) allocates `agentPort`
  // synchronously and flips `status` to `'starting'` long before Vite +
  // the agent-runtime are listening. The previous gate ("agentPort set &
  // status !== stopped/error") happily skipped the await for that
  // `'starting'` state, so when the home composer fired
  // `POST /runtime/prewarm` and the user navigated before the runtime
  // finished booting, `/sandbox/url` returned `ready:false` with URLs
  // whose ports weren't accepting connections yet — ECONNREFUSED on
  // the canvas / preview iframe / agent SSE. `manager.start()` already
  // dedupes via `startingPromises`, so awaiting it here joins the
  // inflight prewarm rather than triggering a second spawn.
  let runtime = manager.status(projectId) ?? undefined
  if (!runtime || runtime.status !== 'running' || !runtime.agentPort) {
    runtime = await manager.start(projectId)
  }

  // Build the host agent URL the same way every caller used to:
  // `http://<host-from-runtime.url>:<agentPort>`. Falls back to
  // localhost if `runtime.url` is somehow missing.
  let host = 'localhost'
  try {
    if (runtime.url) host = new URL(runtime.url).hostname
  } catch {
    // runtime.url isn't a URL (legacy code path); leave host=localhost.
  }
  const agentPort = runtime.agentPort ?? (runtime.port + 1000)
  return { mode: 'host', url: `http://${host}:${agentPort}`, runtime }
}
