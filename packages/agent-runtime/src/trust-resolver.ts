// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live trust resolver for the agent-runtime.
 *
 * ## Why this exists
 *
 * Before this module, trust was a **snapshot** taken at process spawn:
 *
 *   manager.ts → runtimeEnv.TRUST_LEVEL = project.trustLevel
 *   server.ts  → globalThis.__SHOGO_AGENT_RUNTIME_CONFIG__ = { trustLevel, ... }
 *
 * `assertAllowedPath()` then read that global on every tool call. The
 * snapshot was never refreshed, because env vars are immutable for a
 * running Node process and nothing else updated the global. So when
 * the user clicked "Trust folder" the API wrote `trustLevel='trusted'`
 * into Postgres but the **running** agent-runtime kept reporting
 * `restricted_mode_write` forever. That was the bug.
 *
 * ## What this fixes
 *
 * Trust is now **resolved**, not **cached at spawn**. The DB
 * (Postgres, owned by the API) is the single source of truth. The
 * runtime asks the API for the current value via the existing
 * `x-runtime-token`-authenticated internal channel — once at boot,
 * once at the start of every chat turn, and on demand via a small
 * IPC route (`POST /internal/refresh-trust`) that the API's trust
 * endpoint fires after writing the new value.
 *
 * ## Why a sync cache instead of "fetch on every check"
 *
 * `assertAllowedPath()` is called from many synchronous code paths
 * inside the tool layer. Making it async would ripple through ~dozens
 * of call sites in `gateway-tools.ts`. Instead we keep a small mutable
 * cell, refresh it at well-defined turn boundaries, and read from it
 * synchronously. This is the same pattern VS Code uses for workspace
 * trust — the value can change, but only between user actions.
 *
 * Cold-start default (before the first `refresh()` returns) is
 * **fail-closed**: `restricted` for external projects, `trusted` for
 * managed (which always live inside our sandbox).
 */

import { deriveApiUrl, getInternalHeaders } from './internal-api'

export type WorkingMode = 'managed' | 'external'
export type TrustLevel = 'trusted' | 'restricted'

export interface ResolvedTrust {
  trustLevel: TrustLevel
  workingMode: WorkingMode
  workspaceDir: string
  linkedFolders: string[]
}

interface ResolverState extends ResolvedTrust {
  /** Has at least one successful refresh() landed? */
  initialized: boolean
  /** Project id used for the /internal/projects/:id/trust read. */
  projectId: string | null
  /**
   * Workspace (merged-root) runtime: there is no single project to read
   * trust for, and the runtime lives inside our sandbox (every attached
   * project is a subfolder we own). Trust is statically `trusted`; the
   * resolver must NOT call /internal/projects/:id/trust (the synthetic
   * `ws:<id>` PROJECT_ID 401s there).
   */
  isWorkspaceRuntime: boolean
  /**
   * Wall-clock ms of the last successful refresh. Exposed for
   * diagnostics / future TTL eviction; not used as a staleness gate
   * today (per-turn refresh is the gate). */
  lastRefreshAt: number | null
  /** In-flight refresh promise, deduplicated so concurrent callers share one fetch. */
  inFlight: Promise<void> | null
}

function defaultTrustFor(workingMode: WorkingMode): TrustLevel {
  // Fail closed for external projects (the user has to opt in by
  // clicking Trust folder); fail open for managed projects (they live
  // in our sandbox so write/exec are always safe).
  return workingMode === 'external' ? 'restricted' : 'trusted'
}

const state: ResolverState = {
  trustLevel: 'restricted',
  workingMode: 'external',
  workspaceDir: '',
  linkedFolders: [],
  initialized: false,
  projectId: null,
  isWorkspaceRuntime: false,
  lastRefreshAt: null,
  inFlight: null,
}

export interface InitArgs {
  projectId: string | null
  workspaceDir: string
  workingMode: WorkingMode
  linkedFolders: string[]
  /** Workspace (merged-root) runtime — statically trusted, no API trust read. */
  isWorkspaceRuntime?: boolean
}

/**
 * Seed the resolver with the immutable directory layout (workspaceDir,
 * workingMode, linkedFolders) and a safe initial trust level. Trust is
 * then asynchronously reconciled with the DB via `refresh()`.
 *
 * Idempotent — calling it twice with the same args is a no-op apart
 * from resetting `initialized` if you pass a different projectId.
 */
export function initTrustResolver(args: InitArgs): void {
  state.projectId = args.projectId
  state.workspaceDir = args.workspaceDir
  state.workingMode = args.workingMode
  state.linkedFolders = args.linkedFolders.slice()
  state.isWorkspaceRuntime = args.isWorkspaceRuntime ?? false
  // Workspace runtimes are always trusted (sandboxed, multi-project);
  // there is no per-project trust to reconcile, so mark initialized.
  state.trustLevel = state.isWorkspaceRuntime ? 'trusted' : defaultTrustFor(args.workingMode)
  state.initialized = state.isWorkspaceRuntime
  state.lastRefreshAt = null
  state.inFlight = null
}

/** Sync read of the most recent resolved trust + folder configuration. */
export function getResolvedTrust(): ResolvedTrust {
  return {
    trustLevel: state.trustLevel,
    workingMode: state.workingMode,
    workspaceDir: state.workspaceDir,
    linkedFolders: state.linkedFolders.slice(),
  }
}

/** Has the resolver ever successfully fetched from the API? */
export function isTrustResolverInitialized(): boolean {
  return state.initialized
}

/**
 * Fetch the authoritative trust + folders from the API and update the
 * cell. Best-effort: errors are logged and swallowed so a transient
 * network blip can't lock the agent into a wrong trust state. The last
 * known good value stays in place.
 *
 * Concurrent callers share a single in-flight promise — multiple tools
 * triggering refresh in the same tick don't cause N HTTP calls.
 */
export async function refreshTrust(): Promise<void> {
  if (state.inFlight) return state.inFlight

  // Workspace (merged-root) runtimes are statically trusted and have no
  // single project to read trust for. Short-circuit so we never hit
  // /internal/projects/ws:<id>/trust (which 401s on the synthetic id).
  if (state.isWorkspaceRuntime) {
    state.trustLevel = 'trusted'
    state.initialized = true
    return
  }

  const projectId = state.projectId
  if (!projectId) {
    // No projectId means we're in a test or a one-shot script. Nothing
    // to refresh against; keep whatever init() seeded.
    return
  }

  const apiUrl = deriveApiUrl()
  if (!apiUrl) {
    // No API to ask. Same fallback as above.
    return
  }

  const url = `${apiUrl}/api/internal/projects/${encodeURIComponent(projectId)}/trust`
  const promise = (async () => {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: getInternalHeaders(),
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) {
        console.warn(
          `[trust-resolver] refresh failed: HTTP ${res.status} from ${url} — keeping last known trust=${state.trustLevel}`,
        )
        return
      }
      const body = (await res.json()) as Partial<{
        trustLevel: string
        workingMode: string
        linkedFolders: unknown
      }>

      // Race guard: if initTrustResolver() was called for a different
      // project while this fetch was in flight, the response we got
      // belongs to the old project — do not write it into the new
      // project's slot. In production the runtime is single-project
      // for its lifetime, but this defends against tests and any
      // future multi-tenant runtime.
      if (state.projectId !== projectId) {
        return
      }

      const nextTrust: TrustLevel = body.trustLevel === 'restricted' ? 'restricted' : 'trusted'
      const nextMode: WorkingMode = body.workingMode === 'external' ? 'external' : 'managed'
      const nextFolders: string[] = Array.isArray(body.linkedFolders)
        ? body.linkedFolders.filter((p): p is string => typeof p === 'string' && p.length > 0)
        : state.linkedFolders

      const trustChanged = nextTrust !== state.trustLevel
      state.trustLevel = nextTrust
      state.workingMode = nextMode
      state.linkedFolders = nextFolders
      state.initialized = true
      state.lastRefreshAt = Date.now()

      if (trustChanged) {
        console.log(`[trust-resolver] trustLevel resolved to "${nextTrust}" for project ${projectId}`)
      }
    } catch (err: any) {
      console.warn(
        `[trust-resolver] refresh threw: ${err?.message ?? err} — keeping last known trust=${state.trustLevel}`,
      )
    } finally {
      state.inFlight = null
    }
  })()

  state.inFlight = promise
  return promise
}

/**
 * Test-only seam. Lets unit tests override the resolved trust without
 * needing a live API. Production code must go through `refreshTrust()`.
 */
export function __setTrustForTests(partial: Partial<ResolvedTrust> & { initialized?: boolean }): void {
  if (partial.trustLevel) state.trustLevel = partial.trustLevel
  if (partial.workingMode) state.workingMode = partial.workingMode
  if (typeof partial.workspaceDir === 'string') state.workspaceDir = partial.workspaceDir
  if (Array.isArray(partial.linkedFolders)) state.linkedFolders = partial.linkedFolders.slice()
  if (typeof partial.initialized === 'boolean') state.initialized = partial.initialized
}

/** Test-only reset; restores the cold-start defaults. */
export function __resetTrustForTests(): void {
  state.trustLevel = 'restricted'
  state.workingMode = 'external'
  state.workspaceDir = ''
  state.linkedFolders = []
  state.initialized = false
  state.projectId = null
  state.isWorkspaceRuntime = false
  state.lastRefreshAt = null
  state.inFlight = null
}
