// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Single source of truth for "where is workspace W's runtime?"
 *
 * The workspace-scoped sibling of `resolve-pod-url.ts`. A workspace
 * runtime serves a merged tree of several attached projects rather than
 * one project, so resolution is keyed by `workspaceId` + the attached
 * project set. The k8s/vm/host cascade mirrors `resolveProjectPodUrl`
 * exactly so the two stay in lockstep.
 *
 * ─── Rollout gate ──────────────────────────────────────────────────
 *
 * This resolver is gated behind `SHOGO_WORKSPACE_RUNTIME`: with the flag
 * off it throws `WorkspaceRuntimeNotEnabledError` so the
 * `/api/workspaces/:id/chat` route can return a clean 501 instead of
 * half-booting a single-project runtime.
 *
 * Drivers:
 *   - k8s:  the Knative workspace driver (`knative-workspace-manager.ts`)
 *           is wired as the default `_k8sResolver`. It creates the
 *           `workspace-{id}` merged-root Service and short-circuits on an
 *           existing one (cheap re-resolution for spawn-lease losers).
 *   - host: spawns a merged-root agent-runtime via
 *           `RuntimeManager.startWorkspace` (desktop/local).
 *   - vm:   the workspace VM pool driver is not yet wired; the branch
 *           throws "not configured" until a VM resolver is injected.
 *
 * The branch-selection logic is fully unit-tested via the `_`-prefixed
 * injection seams.
 */

import type { IProjectRuntime, IRuntimeManager } from './runtime/types'
import { withWorkspaceSpawnLease } from './runtime/workspace-spawn-lease'

export type WorkspacePodMode = 'k8s' | 'vm' | 'host'

export type ResolvedWorkspacePod =
  | { mode: 'k8s'; url: string }
  | { mode: 'vm'; url: string }
  | { mode: 'host'; url: string; runtime: IProjectRuntime }

/**
 * Thrown when a workspace runtime is requested but the feature flag
 * (`SHOGO_WORKSPACE_RUNTIME`) is not enabled. Callers should map this
 * to a 501 with a clear "not yet available" message.
 */
export class WorkspaceRuntimeNotEnabledError extends Error {
  constructor(workspaceId: string) {
    super(
      `Workspace runtime for ${workspaceId} is not enabled. ` +
        `Set SHOGO_WORKSPACE_RUNTIME=true once the merged-root agent-runtime (Phase 2b) is available.`,
    )
    this.name = 'WorkspaceRuntimeNotEnabledError'
  }
}

export interface ResolveWorkspaceRuntimeOpts {
  /** Attached project ids this runtime should mount. */
  attachedProjectIds: string[]

  /**
   * For the universal project-anchored path: the anchor project id. When
   * set, host mode spawns a PROJECT-anchored merged runtime
   * (`startProjectWorkspace`, keyed `ws:proj:<anchor>`) that mounts the
   * anchor + attachments + linked folders, instead of the workspace-session
   * runtime keyed by workspaceId. Cloud (k8s) is anchor-aware too: the
   * Knative Service is keyed `workspace-proj-<anchor>` and the pod hydrates
   * every member into its own subfolder (VM is not yet wired).
   */
  anchorProjectId?: string
  /** Linked local host folders to mount (project-anchored host path only). */
  localFolders?: string[]
  /** Subset of attached projects mounted read-only (write-denied). */
  readonlyProjectIds?: string[]

  /** Log tag included in fallback/error log lines. */
  logTag?: string

  /** RuntimeManager instance for host mode (lazy-resolved if omitted). */
  runtimeManager?: IRuntimeManager

  /** Test-only override: is the workspace-runtime feature enabled? */
  _isEnabled?: () => boolean
  /** Test-only override for the K8s mode probe. */
  _isKubernetes?: () => boolean
  /** Test-only override for the VM-isolation mode probe. */
  _isVMIsolation?: () => boolean

  /** Test-only branch resolvers (mirror resolve-pod-url's seams). */
  _k8sResolver?: (
    workspaceId: string,
    attachedProjectIds: string[],
    opts?: { anchorProjectId?: string; readonlyProjectIds?: string[] },
  ) => Promise<string>
  _vmResolver?: (workspaceId: string, attachedProjectIds: string[]) => Promise<string>
  _hostStart?: (
    workspaceId: string,
    attachedProjectIds: string[],
    manager?: IRuntimeManager,
  ) => Promise<IProjectRuntime>
  /** Test-only override for the project-anchored host spawn. */
  _hostStartProject?: (
    anchorProjectId: string,
    opts: {
      workspaceId: string
      attachedProjectIds: string[]
      localFolders: string[]
      readonlyProjectIds: string[]
    },
    manager?: IRuntimeManager,
  ) => Promise<IProjectRuntime>

  /**
   * Test-only override for the cross-replica spawn lease wrapper used around
   * the cloud (k8s/vm) branches. Defaults to `withWorkspaceSpawnLease`
   * (PostgreSQL advisory lock keyed on workspaceId). Host mode never takes
   * the lease (single-process, SQLite-backed).
   */
  _spawnLease?: <T>(workspaceId: string, fn: () => Promise<T>) => Promise<T>
}

function defaultIsEnabled(): boolean {
  return process.env.SHOGO_WORKSPACE_RUNTIME === 'true'
}

function defaultIsKubernetes(): boolean {
  return !!process.env.KUBERNETES_SERVICE_HOST
}

function defaultIsVMIsolation(): boolean {
  return process.env.SHOGO_VM_ISOLATION === 'true'
}

/**
 * Default host spawn. Delegates to `RuntimeManager.startWorkspace`,
 * which spawns a merged-root agent-runtime (WORKSPACE_RUNTIME=true)
 * rooted at the workspaces parent and mounting each attached project as
 * a subfolder. The `typeof` guard stays as defense-in-depth for any
 * IRuntimeManager implementation that predates the workspace method.
 */
async function defaultHostStart(
  workspaceId: string,
  attachedProjectIds: string[],
  manager?: IRuntimeManager,
): Promise<IProjectRuntime> {
  const m: any =
    manager ?? (await import('./runtime/index')).getRuntimeManager()
  if (typeof m.startWorkspace !== 'function') {
    throw new Error(
      `[WorkspaceRuntime] host spawn unavailable: this RuntimeManager has no startWorkspace(). ` +
        `Expected on the desktop/local RuntimeManager (apps/api/src/lib/runtime/manager.ts).`,
    )
  }
  return m.startWorkspace(workspaceId, { attachedProjectIds })
}

/**
 * Default host spawn for the project-anchored path. Delegates to
 * `RuntimeManager.startProjectWorkspace`, keyed `ws:proj:<anchor>`.
 */
async function defaultHostStartProject(
  anchorProjectId: string,
  opts: {
    workspaceId: string
    attachedProjectIds: string[]
    localFolders: string[]
    readonlyProjectIds: string[]
  },
  manager?: IRuntimeManager,
): Promise<IProjectRuntime> {
  const m: any =
    manager ?? (await import('./runtime/index')).getRuntimeManager()
  if (typeof m.startProjectWorkspace !== 'function') {
    throw new Error(
      `[WorkspaceRuntime] host spawn unavailable: this RuntimeManager has no startProjectWorkspace(). ` +
        `Expected on the desktop/local RuntimeManager (apps/api/src/lib/runtime/manager.ts).`,
    )
  }
  return m.startProjectWorkspace(anchorProjectId, opts)
}

/**
 * Resolve the agent-runtime URL for a workspace, honouring the
 * k8s/vm/host hierarchy. Throws `WorkspaceRuntimeNotEnabledError` when
 * the feature flag is off.
 */
export async function resolveWorkspaceRuntimeUrl(
  workspaceId: string,
  opts: ResolveWorkspaceRuntimeOpts,
): Promise<ResolvedWorkspacePod> {
  const tag = opts.logTag ?? 'WorkspaceRuntime'
  const isEnabled = opts._isEnabled ?? defaultIsEnabled
  const isKubernetes = opts._isKubernetes ?? defaultIsKubernetes
  const isVMIsolation = opts._isVMIsolation ?? defaultIsVMIsolation
  const attachedProjectIds = opts.attachedProjectIds ?? []
  // Cloud branches serialize spawns across replicas with an advisory lease.
  const spawnLease =
    opts._spawnLease ?? (<T>(id: string, fn: () => Promise<T>) => withWorkspaceSpawnLease(id, fn, { logTag: tag }))

  if (!workspaceId) {
    throw new Error('[WorkspaceRuntime] resolveWorkspaceRuntimeUrl: workspaceId is required')
  }
  if (!isEnabled()) {
    throw new WorkspaceRuntimeNotEnabledError(workspaceId)
  }

  // VM isolation is still keyed by workspaceId only and is not anchor-aware.
  // Fail loudly rather than silently mounting the wrong tree there. (k8s IS
  // anchor-aware now — see below.)
  if (opts.anchorProjectId && isVMIsolation() && !isKubernetes()) {
    throw new Error(
      `[${tag}] project-anchored workspace runtime (anchor=${opts.anchorProjectId}) is not yet ` +
        `supported in VM-isolation mode. It is currently host/desktop + k8s only.`,
    )
  }

  if (isKubernetes()) {
    // Default to the Knative workspace driver (creates/short-circuits the
    // `workspace-{id}` — or `workspace-proj-<anchor>` when anchored — Service).
    // Lazy import keeps k8s deps off the cold path until the first cloud
    // resolution, mirroring resolve-pod-url.ts.
    const resolver =
      opts._k8sResolver ??
      (await import('./knative-workspace-manager')).getWorkspacePodUrl
    // Serialize across replicas: only one builds the workspace KSvc; others
    // wait and re-resolve via the same resolver (which short-circuits on an
    // existing service). Anchored runtimes lease on the anchor id so two
    // anchors in one workspace don't serialize against each other.
    const leaseKey = opts.anchorProjectId ? `proj:${opts.anchorProjectId}` : workspaceId
    const url = await spawnLease(leaseKey, () =>
      resolver(workspaceId, attachedProjectIds, {
        anchorProjectId: opts.anchorProjectId,
        readonlyProjectIds: opts.readonlyProjectIds,
      }),
    )
    // Keep the last-N most-recently-opened workspace runtimes warm: record this
    // resolution in the MRU so the keep-warm sweep pings the top-N /health
    // endpoints and refreshes their Knative scale-to-zero retention. The rest
    // scale to zero. Best-effort; never blocks resolution. Skipped under test
    // resolver injection to keep unit tests free of the singleton.
    if (!opts._k8sResolver) {
      try {
        const { getWorkspaceKeepWarm } = await import('./workspace-keep-warm')
        getWorkspaceKeepWarm().recordOpened(leaseKey, url)
      } catch {
        // keep-warm is an optimization; never fail resolution on it.
      }
    }
    return { mode: 'k8s', url }
  }

  if (isVMIsolation()) {
    if (!opts._vmResolver) {
      throw new Error(
        `[${tag}] VM workspace runtime driver not configured (workspace VM pool assign ` +
          `not yet wired). Inject _vmResolver — see resolve-workspace-runtime-url.ts.`,
      )
    }
    const resolver = opts._vmResolver
    const url = await spawnLease(workspaceId, () => resolver(workspaceId, attachedProjectIds))
    return { mode: 'vm', url }
  }

  // Host mode.
  let runtime: IProjectRuntime
  if (opts.anchorProjectId) {
    const startProject = opts._hostStartProject ?? defaultHostStartProject
    runtime = await startProject(
      opts.anchorProjectId,
      {
        workspaceId,
        attachedProjectIds,
        localFolders: opts.localFolders ?? [],
        readonlyProjectIds: opts.readonlyProjectIds ?? [],
      },
      opts.runtimeManager,
    )
  } else {
    const start = opts._hostStart ?? defaultHostStart
    runtime = await start(workspaceId, attachedProjectIds, opts.runtimeManager)
  }

  let host = 'localhost'
  try {
    if (runtime.url) host = new URL(runtime.url).hostname
  } catch {
    // runtime.url isn't a URL; leave host=localhost.
  }
  const agentPort = runtime.agentPort ?? (runtime.port + 1000)
  return { mode: 'host', url: `http://${host}:${agentPort}`, runtime }
}
