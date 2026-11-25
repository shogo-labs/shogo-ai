// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The project set a workspace runtime mounts.
 *
 * A workspace runtime is addressed by its runtime key — `ws:<workspaceId>` for
 * a workspace-session runtime, `ws:proj:<anchor>` for a project canvas — and
 * mounts exactly the projects that key implies. Boot (`getMetalWorkspaceUrl`,
 * `KnativeWorkspaceManager.createWorkspace`) and the `/pod-config` AI-proxy
 * token refresh both need that same set: the refresh mints the tokens the
 * runtime will send to the proxy, so a set derived differently from boot would
 * rotate a runtime onto tokens for projects it does not serve (SHO-560).
 *
 * `workspaceRuntimeMembers` is the one definition. `buildWorkspaceEnv` keeps its
 * own metal narrowing as a guard against a caller that passes foreign members —
 * passing the result of this function always satisfies it.
 */

import { isMetalEnabled } from '../metal-eligibility'

export interface WorkspaceRuntimeMemberArgs {
  /** Anchor project of a project-canvas runtime; absent for a workspace session. */
  anchorProjectId?: string
  /** Projects attached by the session that opened the runtime. */
  attachedProjectIds?: string[]
  /**
   * Firecracker guest: the anchor alone, or nothing for a workspace session.
   * A metal runtime reaches the workspace's other projects over the
   * remote-tool channel and never mounts them.
   */
  forMetal?: boolean
}

/** The member set a workspace runtime mounts, in boot order, deduped. */
export function workspaceRuntimeMembers(args: WorkspaceRuntimeMemberArgs): string[] {
  const { anchorProjectId, attachedProjectIds = [], forMetal } = args
  if (forMetal) return anchorProjectId ? [anchorProjectId] : []
  const members = anchorProjectId ? [anchorProjectId, ...attachedProjectIds] : [...attachedProjectIds]
  return members.filter((id, i, arr) => !!id && arr.indexOf(id) === i)
}

/**
 * Whether THIS api's workspace runtimes boot on the metal substrate.
 *
 * `resolveWorkspaceRuntimeUrl` picks metal for every workspace runtime whenever
 * the substrate is enabled at all (there is no per-project choice on the
 * workspace path), so the refresh has to make the same call — a metal guest
 * booted with the anchor alone, and handing it a session's attachment set would
 * be an env the runtime never had. Desktop counts as neither.
 */
export function workspaceRuntimesUseMetal(): boolean {
  return process.env.SHOGO_LOCAL_MODE !== 'true' && isMetalEnabled()
}

export interface WorkspaceRefreshMemberSeams {
  /** Test seam for the substrate probe. */
  useMetal?: () => boolean
  /**
   * The members the live runtime booted with, when the substrate bakes them
   * (Knative bakes the Service env once). null when it cannot be read.
   */
  bootedMembers?: (workspaceId: string, anchorProjectId?: string) => Promise<string[] | null>
}

/**
 * The member set a `/pod-config` refresh must mint tokens for.
 *
 * Metal: the anchor alone (or nothing), exactly what the guest booted with.
 * Otherwise (Knative, or a desktop host runtime) the baked member set is the
 * only faithful answer; when it cannot be read the refresh falls back to the
 * anchor alone, which is what a canvas runtime booted with and what a
 * session-less `ws:` runtime degrades to anyway. A missing member only costs a
 * `workspace`-scoped token — never a token for another workspace.
 */
export async function workspaceRuntimeRefreshMembers(
  target: { workspaceId: string; anchorProjectId?: string },
  seams: WorkspaceRefreshMemberSeams = {},
): Promise<{ members: string[]; forMetal: boolean }> {
  const useMetal = seams.useMetal ?? workspaceRuntimesUseMetal
  if (useMetal()) {
    return { members: workspaceRuntimeMembers({ anchorProjectId: target.anchorProjectId, forMetal: true }), forMetal: true }
  }
  const readBooted =
    seams.bootedMembers ??
    (async (workspaceId: string, anchorProjectId?: string) => {
      if (process.env.SHOGO_LOCAL_MODE === 'true' || !process.env.KUBERNETES_SERVICE_HOST) return null
      const { readWorkspaceRuntimeMembers } = await import('../knative-workspace-manager')
      return readWorkspaceRuntimeMembers(workspaceId, anchorProjectId)
    })
  const booted = await readBooted(target.workspaceId, target.anchorProjectId).catch(() => null)
  return {
    members: workspaceRuntimeMembers({
      anchorProjectId: target.anchorProjectId,
      attachedProjectIds: booted ?? [],
    }),
    forMetal: false,
  }
}

