// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Resolve a project's agent runtime.
 *
 * Projects no longer have a second legacy runtime topology. Every project is
 * an anchor in a merged-root workspace runtime, matching the metal and
 * Kubernetes workspace drivers. Keeping this adapter small is important:
 * `/sandbox/url`, project chat, runtime routes, and agent-proxy all converge
 * on the same resolver and therefore the same `ws:proj:<anchor>` process.
 */
import type { IProjectRuntime, IRuntimeManager } from './runtime/types'
import type { KnativeStatusProbe } from './metal-drain'
import type { ResolveWorkspaceRuntimeOpts } from './resolve-workspace-runtime-url'

export type PodMode = 'k8s' | 'host' | 'metal'

export type AnchoredProjectRuntimeArgs = {
  workspaceId: string
  attachedProjectIds: string[]
  localFolders: string[]
  readonlyProjectIds: string[]
}

export type ResolvedPod =
  | { mode: 'k8s'; url: string }
  | { mode: 'metal'; url: string }
  | { mode: 'host'; url: string; runtime: IProjectRuntime }

export interface ResolvePodUrlOpts {
  logTag?: string
  metalWaitMs?: number
  metalRetryDelayMs?: number
  runtimeManager?: IRuntimeManager
  openAttemptId?: string
  _k8sResolver?: (projectId: string) => Promise<string>
  _isKubernetes?: () => boolean
  /** @deprecated Host warm pools are not part of the workspace topology. */
  _isHostWarmPoolEnabled?: () => boolean
  /** @deprecated Host warm pools are not part of the workspace topology. */
  _hostPoolResolver?: (projectId: string, openAttemptId?: string) => Promise<string>
  _isMetalEnabled?: () => boolean
  _isMetalEligible?: (projectId: string) => boolean
  _isMetalOnly?: () => boolean
  _metalResolver?: (projectId: string) => Promise<string>
  _isMetalDrainMode?: () => boolean
  _knativeStatus?: KnativeStatusProbe
  _loadAnchoredArgs?: (projectId: string) => Promise<AnchoredProjectRuntimeArgs | null>
  _spawnLease?: <T>(leaseKey: string, fn: () => Promise<T>) => Promise<T>
  _workspaceK8sResolver?: ResolveWorkspaceRuntimeOpts['_k8sResolver']
  _workspaceMetalResolver?: ResolveWorkspaceRuntimeOpts['_metalResolver']
  _hostStartProject?: ResolveWorkspaceRuntimeOpts['_hostStartProject']
}

async function defaultLoadAnchoredProjectRuntimeArgs(
  projectId: string,
): Promise<AnchoredProjectRuntimeArgs | null> {
  const { getRuntimeManager } = await import('./runtime/index')
  const manager = getRuntimeManager() as {
    resolveAnchorSpawnOpts?: (id: string) => Promise<AnchoredProjectRuntimeArgs | null>
  }
  if (typeof manager.resolveAnchorSpawnOpts !== 'function') return null
  return manager.resolveAnchorSpawnOpts(projectId)
}

async function resolveAnchoredProject(
  projectId: string,
  opts: ResolvePodUrlOpts,
): Promise<ResolvedPod> {
  const load = opts._loadAnchoredArgs ?? defaultLoadAnchoredProjectRuntimeArgs
  const args = await load(projectId)
  if (!args) {
    throw new Error(
      `[PodResolver] project ${projectId} has no workspace spawn options; ` +
        'workspace-runtime is the only supported project runtime topology',
    )
  }

  const { resolveWorkspaceRuntimeUrl } =
    await import('./resolve-workspace-runtime-url')
  const spawnLease =
    opts._spawnLease ??
    (async <T>(leaseKey: string, fn: () => Promise<T>) => {
      const { withWorkspaceSpawnLease } = await import('./runtime/workspace-spawn-lease')
      return withWorkspaceSpawnLease(leaseKey, fn, { logTag: opts.logTag ?? 'PodResolver' })
    })

  const resolved = await resolveWorkspaceRuntimeUrl(args.workspaceId, {
    attachedProjectIds: args.attachedProjectIds,
    anchorProjectId: projectId,
    localFolders: args.localFolders,
    readonlyProjectIds: args.readonlyProjectIds,
    logTag: opts.logTag ?? 'PodResolver',
    runtimeManager: opts.runtimeManager,
    _isKubernetes: opts._isKubernetes,
    _isMetalEnabled: opts._isMetalEnabled,
    _k8sResolver: opts._workspaceK8sResolver,
    _metalResolver: opts._workspaceMetalResolver,
    _hostStartProject: opts._hostStartProject,
    openAttemptId: opts.openAttemptId,
    _spawnLease: spawnLease,
  })

  if (resolved.mode === 'host') {
    return { mode: 'host', url: resolved.url, runtime: resolved.runtime }
  }
  return { mode: resolved.mode, url: resolved.url }
}

/**
 * Compatibility error retained for imports from older rollout tests. The
 * resolver is unconditional and does not throw this error in production.
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

export async function resolveProjectPodUrl(
  projectId: string,
  opts: ResolvePodUrlOpts = {},
): Promise<ResolvedPod> {
  return resolveAnchoredProject(projectId, opts)
}
