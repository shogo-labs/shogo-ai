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
 * The actual workspace runtime spawn (host) and the Knative workspace
 * service (k8s) land in Phase 2b — they require the agent-runtime to
 * boot in merged-root mode and the warm pool to bind a project SET.
 * Until then this resolver is gated behind `SHOGO_WORKSPACE_RUNTIME`:
 * with the flag off it throws `WorkspaceRuntimeNotEnabledError` so the
 * `/api/workspaces/:id/chat` route can return a clean 501 instead of
 * half-booting a single-project runtime. The branch-selection logic is
 * fully unit-tested today via the `_`-prefixed injection seams.
 */

import type { IProjectRuntime, IRuntimeManager } from './runtime/types'

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
  _k8sResolver?: (workspaceId: string, attachedProjectIds: string[]) => Promise<string>
  _vmResolver?: (workspaceId: string, attachedProjectIds: string[]) => Promise<string>
  _hostStart?: (
    workspaceId: string,
    attachedProjectIds: string[],
    manager?: IRuntimeManager,
  ) => Promise<IProjectRuntime>
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

  if (!workspaceId) {
    throw new Error('[WorkspaceRuntime] resolveWorkspaceRuntimeUrl: workspaceId is required')
  }
  if (!isEnabled()) {
    throw new WorkspaceRuntimeNotEnabledError(workspaceId)
  }

  if (isKubernetes()) {
    const resolver =
      opts._k8sResolver ??
      (async () => {
        throw new Error(
          `[${tag}] k8s workspace runtime not implemented yet (Knative workspace service lands in Phase 2b).`,
        )
      })
    const url = await resolver(workspaceId, attachedProjectIds)
    return { mode: 'k8s', url }
  }

  if (isVMIsolation()) {
    const resolver =
      opts._vmResolver ??
      (async () => {
        throw new Error(
          `[${tag}] VM workspace runtime not implemented yet (workspace VM pool lands in Phase 2b).`,
        )
      })
    const url = await resolver(workspaceId, attachedProjectIds)
    return { mode: 'vm', url }
  }

  // Host mode.
  const start = opts._hostStart ?? defaultHostStart
  const runtime = await start(workspaceId, attachedProjectIds, opts.runtimeManager)

  let host = 'localhost'
  try {
    if (runtime.url) host = new URL(runtime.url).hostname
  } catch {
    // runtime.url isn't a URL; leave host=localhost.
  }
  const agentPort = runtime.agentPort ?? (runtime.port + 1000)
  return { mode: 'host', url: `http://${host}:${agentPort}`, runtime }
}
