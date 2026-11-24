// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The env a workspace runtime's AI-proxy token refresh hands back (SHO-560).
 *
 * Kept out of `workspace-runtime-members.ts` so the boot path (which imports the
 * member derivation in the metal controller / Knative manager / resolver) never
 * pulls `buildWorkspaceEnv` — and with it the token minting, model defaults and
 * project catalog — into a graph that does not need them.
 */

import { buildWorkspaceEnv, type BuildWorkspaceEnvOpts } from './build-workspace-env'
import { workspaceRuntimeRefreshMembers, type WorkspaceRefreshMemberSeams } from './workspace-runtime-members'

export interface WorkspaceRuntimeRefreshEnvSeams extends WorkspaceRefreshMemberSeams {
  /** `buildWorkspaceEnv` seams (tests). */
  envSeams?: BuildWorkspaceEnvOpts
}

/**
 * The env a `/pod-config` refresh returns for a workspace runtime key.
 *
 * Only `AI_PROXY_*` keys: the runtime applies a refresh additively and never
 * unsets, so returning the whole boot env would overwrite the live runtime's
 * topology (`WORKSPACE_PROJECT_IDS`, DB urls, preview URLs) with the values of a
 * boot that may be hours old. The fresh tokens are the whole point — everything
 * else the runtime already has.
 */
export async function buildWorkspaceRuntimeRefreshEnv(
  target: { workspaceId: string; anchorProjectId?: string },
  seams: WorkspaceRuntimeRefreshEnvSeams = {},
): Promise<{ members: string[]; forMetal: boolean; env: Record<string, string> }> {
  const { members, forMetal } = await workspaceRuntimeRefreshMembers(target, seams)
  const bootEnv = await buildWorkspaceEnv(target.workspaceId, members, {
    ...seams.envSeams,
    logPrefix: seams.envSeams?.logPrefix ?? 'pod-config',
    anchorProjectId: target.anchorProjectId,
    forMetal,
    ...(forMetal ? { readonlyProjectIds: [] } : {}),
  })
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(bootEnv)) {
    if (name.startsWith('AI_PROXY_') && typeof value === 'string') env[name] = value
  }
  return { members, forMetal, env }
}
