// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Single source of truth for "where is workspace W's runtime?"
 *
 * The workspace-scoped sibling of `resolve-pod-url.ts`. A workspace
 * runtime serves a merged tree of several attached projects rather than
 * one project, so resolution is keyed by `workspaceId` + the attached
 * project set. The k8s/host cascade mirrors `resolveProjectPodUrl`
 * exactly so the two stay in lockstep.
 *
 * Drivers:
 *   - k8s:  the Knative workspace driver (`knative-workspace-manager.ts`)
 *           is wired as the default `_k8sResolver`. It creates the
 *           `workspace-{id}` merged-root Service and short-circuits on an
 *           existing one (cheap re-resolution for spawn-lease losers).
 *   - host: spawns a merged-root agent-runtime via
 *           `RuntimeManager.startWorkspace` (desktop/local).
 *
 * The branch-selection logic is fully unit-tested via the `_`-prefixed
 * injection seams.
 */

import type { IProjectRuntime, IRuntimeManager } from './runtime/types'
import { withWorkspaceSpawnLease } from './runtime/workspace-spawn-lease'
import { isMetalEnabled as defaultIsMetalEnabled } from './metal-eligibility'

export type WorkspacePodMode = 'k8s' | 'metal' | 'host'

export type ResolvedWorkspacePod =
  | { mode: 'k8s'; url: string }
  | { mode: 'metal'; url: string }
  | { mode: 'host'; url: string; runtime: IProjectRuntime }

/**
 * Retained as a compatibility export for callers that imported the old
 * rollout error. Workspace runtimes are now unconditional, so production
 * code never throws this error.
 */
export class WorkspaceRuntimeNotEnabledError extends Error {
  constructor(workspaceId: string) {
    super(
      `Workspace runtime for ${workspaceId} is unavailable. ` +
        'The merged-root workspace runtime could not be resolved.',
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
   * every member into its own subfolder.
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
  /** Correlates a UI open attempt with host runtime boot logs. */
  openAttemptId?: string

  /** @deprecated Workspace runtimes are always enabled. */
  _isEnabled?: () => boolean
  /** @deprecated Retained for source compatibility; ignored. */
  alwaysEnabled?: boolean
  /** @deprecated Workspace kind no longer changes runtime selection. */
  workspaceKind?: 'personal' | 'team'
  /** @deprecated Workspace kind is no longer loaded for runtime selection. */
  _loadWorkspaceKind?: (workspaceId: string) => Promise<'personal' | 'team' | null>
  /** Test-only override for the K8s mode probe. */
  _isKubernetes?: () => boolean
  /** Test-only override for the metal mode probe. */
  _isMetalEnabled?: () => boolean

  /** Test-only branch resolvers (mirror resolve-pod-url's seams). */
  _k8sResolver?: (
    workspaceId: string,
    attachedProjectIds: string[],
    opts?: { anchorProjectId?: string; readonlyProjectIds?: string[] },
  ) => Promise<string>
  /** Test seam / optional override for the Metal merged-root microVM resolver. */
  _metalResolver?: (
    workspaceId: string,
    attachedProjectIds: string[],
    opts?: { anchorProjectId?: string; readonlyProjectIds?: string[] },
  ) => Promise<string>
  _hostStart?: (
    workspaceId: string,
    attachedProjectIds: string[],
    manager?: IRuntimeManager,
    opts?: { openAttemptId?: string },
  ) => Promise<IProjectRuntime>
  /** Test-only override for the project-anchored host spawn. */
  _hostStartProject?: (
    anchorProjectId: string,
    opts: {
      workspaceId: string
      attachedProjectIds: string[]
      localFolders: string[]
      readonlyProjectIds: string[]
      openAttemptId?: string
    },
    manager?: IRuntimeManager,
  ) => Promise<IProjectRuntime>

  /**
   * Test-only override for the cross-replica spawn lease wrapper used around
   * the cloud (k8s/metal) branches. Defaults to `withWorkspaceSpawnLease`
   * (PostgreSQL advisory lock keyed on workspaceId). Host mode never takes
   * the lease (single-process, SQLite-backed).
   */
  _spawnLease?: <T>(workspaceId: string, fn: () => Promise<T>) => Promise<T>
}

function defaultIsKubernetes(): boolean {
  return !!process.env.KUBERNETES_SERVICE_HOST
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
  opts?: { openAttemptId?: string },
): Promise<IProjectRuntime> {
  const m: any =
    manager ?? (await import('./runtime/index')).getRuntimeManager()
  if (typeof m.startWorkspace !== 'function') {
    throw new Error(
      `[WorkspaceRuntime] host spawn unavailable: this RuntimeManager has no startWorkspace(). ` +
        `Expected on the desktop/local RuntimeManager (apps/api/src/lib/runtime/manager.ts).`,
    )
  }
  return m.startWorkspace(workspaceId, {
    attachedProjectIds,
    openAttemptId: opts?.openAttemptId,
  })
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
    openAttemptId?: string
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
 * metal/k8s/host hierarchy. Workspace runtimes are unconditional; the
 * The former workspace rollout gate has been retired.
 */
export async function resolveWorkspaceRuntimeUrl(
  workspaceId: string,
  opts: ResolveWorkspaceRuntimeOpts,
): Promise<ResolvedWorkspacePod> {
  const tag = opts.logTag ?? 'WorkspaceRuntime'
  const isKubernetes = opts._isKubernetes ?? defaultIsKubernetes
  const isMetalEnabled = opts._isMetalEnabled ?? defaultIsMetalEnabled
  // The anchor project is always a member of its own merged-root workspace —
  // it owns the root path, so its guest-side PreviewManager can only ever
  // come up if the runtime's member list includes it. `startProjectWorkspace`
  // (host mode) already defensively prepends the anchor for this reason, but
  // the metal and k8s branches below previously forwarded `opts.attachedProjectIds`
  // verbatim, which only lists the anchor's OTHER attachments (see
  // `resolveAnchorSpawnOpts` in runtime/manager.ts — it never includes the
  // anchor itself). That left every anchor project with no OTHER attachments
  // — i.e. every project in an otherwise-empty workspace, which is the common
  // case — booting a workspace runtime whose guest never recognizes the
  // anchor as an attached member, so `getWorkspacePreviewManager()` on the
  // guest returns null and the preview never starts, permanently stuck on
  // the "Project Ready" placeholder (staging incident, 2026-09-22, project
  // a0bea431-... and its 27 workspace siblings). Computing the deduped
  // member list once, here, fixes metal + k8s uniformly and makes the
  // host branch's own prepend a harmless no-op.
  const attachedProjectIds = opts.anchorProjectId
    ? [opts.anchorProjectId, ...(opts.attachedProjectIds ?? [])].filter(
        (id, i, arr) => !!id && arr.indexOf(id) === i,
      )
    : opts.attachedProjectIds ?? []
  // Cloud branches serialize spawns across replicas with an advisory lease.
  const spawnLease =
    opts._spawnLease ?? (<T>(id: string, fn: () => Promise<T>) => withWorkspaceSpawnLease(id, fn, { logTag: tag }))

  if (!workspaceId) {
    throw new Error('[WorkspaceRuntime] resolveWorkspaceRuntimeUrl: workspaceId is required')
  }
  // Metal takes precedence over the k8s (Knative) branch: in metal regions the
  // API pod runs IN Kubernetes, so a workspace runtime must resolve to a
  // merged-root microVM rather than creating a Knative Service.
  if (isMetalEnabled()) {
    if (!opts._metalResolver && !defaultIsMetalEnabled()) {
      throw new Error(
        `[${tag}] metal workspace runtime driver not configured (merged-root metal microVM ` +
          `not yet wired). Inject _metalResolver — see resolve-workspace-runtime-url.ts.`,
      )
    }
    const resolver =
      opts._metalResolver ??
      (async (
        id: string,
        ids: string[],
        resolverOpts?: { anchorProjectId?: string; readonlyProjectIds?: string[] },
      ) => {
        const { getMetalWarmPoolController } = await import(
          new URL('./metal-warm-pool-controller.ts', import.meta.url).href
        )
        return getMetalWarmPoolController().getMetalWorkspaceUrl(id, ids, resolverOpts)
      })
    const leaseKey = opts.anchorProjectId ? `proj:${opts.anchorProjectId}` : workspaceId
    const url = await spawnLease(leaseKey, () =>
      resolver(workspaceId, attachedProjectIds, {
        anchorProjectId: opts.anchorProjectId,
        readonlyProjectIds: opts.readonlyProjectIds,
      }),
    )
    try {
      const { getWorkspaceKeepWarm } = await import('./workspace-keep-warm')
      getWorkspaceKeepWarm().recordOpened(leaseKey, url)
    } catch {
      // Keep-warm is an optimization and must never fail a runtime resolve.
    }
    return { mode: 'metal', url }
  }

  if (isKubernetes()) {
    // Default to the Knative workspace driver (creates/short-circuits the
    // `workspace-{id}` — or `workspace-proj-<anchor>` when anchored — Service).
    // Lazy import keeps k8s deps off the cold path until the first cloud
    // resolution, mirroring resolve-pod-url.ts.
    const resolver =
      opts._k8sResolver ??
      (await import(new URL('./knative-workspace-manager.ts', import.meta.url).href)).getWorkspacePodUrl
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
        openAttemptId: opts.openAttemptId,
      },
      opts.runtimeManager,
    )
  } else {
    const start = opts._hostStart ?? defaultHostStart
    runtime = await start(
      workspaceId,
      attachedProjectIds,
      opts.runtimeManager,
      { openAttemptId: opts.openAttemptId },
    )
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
