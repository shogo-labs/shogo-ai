// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Single source of truth for "where is project P's agent runtime?"
 *
 * Before this helper existed, several sites in apps/api duplicated the same
 * `if (k8s) … else host` cascade (now also joined by the `metal` and host
 * warm-pool substrates below):
 *
 *   - `routes/runtime.ts`        — `/start`, `/sandbox/url`, `/restart`
 *   - `routes/project-chat.ts`   — `getProjectUrl()`
 *   - `server.ts`                — `/agent-proxy/*` route, `resolveAgentRuntimeUrl`
 *
 * This helper makes the resolution declarative and testable, with a
 * `logTag` knob that identifies the caller in fallback/error log lines.
 *
 * Tests (see `__tests__/resolve-pod-url.test.ts`) cover each branch.
 */

import type { IProjectRuntime, IRuntimeManager } from './runtime/types'
import {
  isMetalEnabled as metalEnabled,
  isMetalEligibleProject as metalEligible,
  isMetalAuthoritative as metalAuthoritative,
  isMetalDrainMode as metalDrainMode,
} from './metal-eligibility'
import type { KnativeStatusProbe } from './metal-drain'

export type PodMode = 'k8s' | 'host' | 'metal'

export type ResolvedPod =
  | { mode: 'k8s'; url: string }
  | { mode: 'metal'; url: string }
  | { mode: 'host'; url: string; runtime: IProjectRuntime }

export interface ResolvePodUrlOpts {
  /**
   * Log tag included in fallback/error log lines so the originating
   * caller is identifiable in `main.log`
   * (e.g. `[AgentProxy]`, `[Runtime]`, `[ProjectChat]`).
   */
  logTag?: string

  /**
   * Metal substrate only: total time to keep WAITING for the project to become
   * ready before giving up. On a slow wake the first `/assign` can outrun its
   * 30s host-side timeout; because the host dedupes concurrent opens
   * (singleflight) and the placement registry keeps retries sticky, simply
   * re-calling REJOINS the in-flight wake and returns as soon as it's ready.
   * This turns a wake that outran one assign into a slower SUCCESS instead of a
   * retryable `pod_starting` 503.
   *
   * Default 0 = single attempt (unchanged for callers like `/sandbox/url` that
   * drive their own client-side polling). `project-chat` sets this so a user's
   * chat blocks through the wake rather than flashing an error.
   */
  metalWaitMs?: number
  /** Delay between metal wait-retries while within `metalWaitMs` (default 1000ms). */
  metalRetryDelayMs?: number

  /**
   * RuntimeManager instance for host mode. Production callers pass
   * their existing `runtimeManager` here (so tests, /sandbox/url and
   * `/runtime/start` all share the same manager instance). Pass
   * `undefined` and the helper resolves it lazily via
   * `getRuntimeManager()`.
   */
  runtimeManager?: IRuntimeManager

  /**
   * Test-only override for the K8s resolver. In production this is
   * dynamically imported from the relevant lib module, preserving the
   * existing cold-start cost shape (the helper itself never pulls the
   * k8s dependency until first call).
   */
  _k8sResolver?: (projectId: string) => Promise<string>

  /**
   * Test-only override for the env-driven Kubernetes probe. In
   * production this reads `process.env`.
   */
  _isKubernetes?: () => boolean

  /**
   * Host warm pool (opt-in via `HOST_WARM_POOL_SIZE`). When enabled, the host
   * branch claims a pre-booted generic runtime and assigns the project via
   * `/pool/assign` instead of cold-spawning through the RuntimeManager. A
   * failure falls through to the direct host path. Test-only overrides.
   */
  _isHostWarmPoolEnabled?: () => boolean
  _hostPoolResolver?: (projectId: string) => Promise<string>

  /**
   * Test-only overrides for the `metal` substrate branch. In production these
   * are read from env / dynamically imported from metal-warm-pool-controller.
   */
  _isMetalEnabled?: () => boolean
  _isMetalEligible?: (projectId: string) => boolean
  _isMetalOnly?: () => boolean
  _metalResolver?: (projectId: string) => Promise<string>

  /**
   * Sticky-drain cutover (SHOGO_METAL_DRAIN_MODE). When on and running in
   * Kubernetes, a project that still has a LIVE Knative pod is served from
   * Knative (the old fleet drains as pods idle out); everything else routes to
   * metal. `_knativeStatus` is the (non-mutating) liveness probe used to decide.
   */
  _isMetalDrainMode?: () => boolean
  _knativeStatus?: KnativeStatusProbe
}

/**
 * Thrown when metal-only mode is active and the metal substrate could not place
 * the project. Message intentionally contains "starting" so the chat/runtime
 * routes map it to a retryable `pod_starting` 503 (client backs off while the
 * VM resumes/boots) rather than a hard failure — and, critically, we do NOT
 * fall through to Knative in this mode.
 */
export class MetalOnlyUnavailableError extends Error {
  constructor(projectId: string, cause?: unknown) {
    super(
      `metal runtime for ${projectId} is starting (metal-only mode; no Knative fallback): ` +
        `${(cause as any)?.message ?? cause ?? 'no host available'}`,
    )
    this.name = 'MetalOnlyUnavailableError'
  }
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

function defaultIsHostWarmPoolEnabled(): boolean {
  return parseInt(process.env.HOST_WARM_POOL_SIZE || '0', 10) > 0
}

// Metal probes are pure env reads (metal-eligibility) — cheap to call on every
// request; the heavy controller is only dynamically imported once eligible.
function defaultIsMetalEnabled(): boolean {
  return metalEnabled()
}

function defaultIsMetalEligible(projectId: string): boolean {
  return metalEligible(projectId)
}

/**
 * Resolve the agent-runtime URL for `projectId`, honouring the
 * metal/K8s/host hierarchy.
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

  // Metal microVM substrate (cloud-agnostic bare-metal, reached over the mesh).
  //
  //   - Rollout mode (SHOGO_METAL_ENABLED + allowlist/percentage): BEST-EFFORT.
  //     A miss/host failure falls through to the Knative/host cascade below,
  //     so canarying is safe — a project is never unreachable if a host is down.
  //   - Metal-only mode (SHOGO_METAL_ALL_PROJECTS): EVERY project runs on metal
  //     and Knative is NOT used. A miss throws MetalOnlyUnavailableError (→
  //     retryable 503) instead of falling through, so traffic never silently
  //     lands on Knative.
  //   - Drain cutover mode (SHOGO_METAL_DRAIN_MODE): EVERY project is metal-
  //     eligible, but one that still has a LIVE Knative pod keeps being served
  //     from Knative until that pod idles out; new opens (and projects whose pod
  //     is gone) go to metal, authoritatively (no fallback). This drains the old
  //     fleet with no interruption and no cross-substrate dual-run.
  const isMetalEnabled = opts._isMetalEnabled ?? defaultIsMetalEnabled
  const isMetalEligible = opts._isMetalEligible ?? defaultIsMetalEligible
  const isMetalOnly = opts._isMetalOnly ?? metalAuthoritative
  const isMetalDrain = opts._isMetalDrainMode ?? metalDrainMode
  if (isMetalEnabled() && isMetalEligible(projectId)) {
    // Sticky-drain cutover: if this project still has a LIVE Knative pod, keep
    // serving it (the old fleet drains as pods idle out). Only once its pod is
    // gone — or for a brand-new project — does the open route to metal. The
    // probe is non-mutating (does not wake a scaled-to-zero pod).
    if (isMetalDrain() && isKubernetes()) {
      const probe = opts._knativeStatus ?? (await import('./metal-drain')).defaultKnativeStatus
      try {
        const s = await probe(projectId)
        if (s.exists && s.ready && s.replicas > 0 && s.url) {
          return { mode: 'k8s', url: s.url }
        }
      } catch (err: any) {
        // Unknown Knative state: do NOT route to metal or start a Knative pod
        // (either could dual-run the project across substrates). Surface a
        // retryable "starting" so the caller backs off and retries.
        console.warn(`[${tag}] drain-mode knative probe failed for ${projectId}; retryable (no dual-run): ${err?.message ?? err}`)
        throw new MetalOnlyUnavailableError(projectId, err)
      }
    }
    const resolve = opts._metalResolver
      ?? (await import('./metal-warm-pool-controller')).getMetalProjectUrl
    const waitMs = Math.max(0, opts.metalWaitMs ?? 0)
    const retryDelayMs = Math.max(0, opts.metalRetryDelayMs ?? 1000)
    const deadline = Date.now() + waitMs
    for (let attempt = 1; ; attempt++) {
      try {
        const url = await resolve(projectId)
        return { mode: 'metal', url }
      } catch (err: any) {
        // Wait-and-retry within the budget: re-calling rejoins the host's
        // in-flight wake (singleflight) and returns as soon as it's ready, so a
        // wake slower than one assign timeout degrades to a slower success.
        if (Date.now() + retryDelayMs < deadline) {
          if (attempt === 1) {
            console.log(`[${tag}] metal ${projectId} not ready yet; waiting up to ${waitMs}ms for wake...`)
          }
          if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs))
          continue
        }
        // Budget exhausted (or none configured) — terminal handling.
        if (isMetalOnly()) {
          // Authoritative: do not fall through to Knative in metal-only mode.
          console.warn(`[${tag}] metal resolve failed for ${projectId} (metal-only, no fallback): ${err?.message ?? err}`)
          throw new MetalOnlyUnavailableError(projectId, err)
        }
        console.warn(
          `[${tag}] metal resolve failed for ${projectId}; falling back to k8s/host: ${err?.message ?? err}`,
        )
        break // fall through to the standard cascade
      }
    }
  }

  if (isKubernetes()) {
    // Use the KNATIVE-ONLY resolver here, never the substrate-agnostic
    // `getProjectPodUrl` (which delegates back to THIS function) — otherwise the
    // knative branch would recurse. `getProjectPodUrl` is the public entrypoint;
    // `resolveKnativePodUrl` is its knative arm.
    const resolver = opts._k8sResolver
      ?? (await import('./knative-project-manager')).resolveKnativePodUrl
    const url = await resolver(projectId)
    return { mode: 'k8s', url }
  }

  // Host warm pool (opt-in via HOST_WARM_POOL_SIZE). Claims a pre-booted generic
  // runtime and assigns the project via /pool/assign, skipping the cold spawn.
  // Any failure falls through to the direct RuntimeManager host path below so a
  // pool hiccup never leaves the project unreachable.
  const isHostWarmPool = opts._isHostWarmPoolEnabled ?? defaultIsHostWarmPoolEnabled
  if (isHostWarmPool()) {
    try {
      const resolve = opts._hostPoolResolver
        ?? (await import('./host-warm-pool-controller')).getHostPoolProjectUrl
      const url = await resolve(projectId)
      let agentPort = 0
      try { agentPort = parseInt(new URL(url).port, 10) || 0 } catch { /* leave 0 */ }
      const runtime: IProjectRuntime = {
        id: projectId,
        port: agentPort,
        agentPort,
        status: 'running',
        url,
        startedAt: Date.now(),
      }
      return { mode: 'host', url, runtime }
    } catch (err: any) {
      console.warn(
        `[${tag}] host warm pool resolve failed for ${projectId}; ` +
          `falling back to direct host runtime: ${err?.message ?? err}`,
      )
    }
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
