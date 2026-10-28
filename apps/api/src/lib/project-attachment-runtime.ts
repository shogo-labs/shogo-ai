// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Anchor-runtime restart helpers for attachment changes.
 *
 * Extracted from `routes/local-projects.ts` so the cloud/public attachments
 * route and the desktop-only local router share one implementation: an
 * attach/detach changes the anchor's merged-root member set, which the runtime
 * only reads at boot, so the set takes effect after a restart.
 *
 * The anchored workspace runtime is the only project runtime topology, so
 * attachment changes always restart the same merged-root process.
 */

import { isMetalEnabled } from './metal-eligibility'

async function restartAnchorRuntime(anchorProjectId: string, hint: string): Promise<void> {
  const [{ getRuntimeManager, projectWorkspaceRuntimeKey }, resolveMod] = await Promise.all([
    import('./runtime/manager'),
    import('./resolve-workspace-runtime-url'),
  ])

  const manager: any = getRuntimeManager()

  // Single source of truth for the anchor's merged-root spawn options
  // (workspaceId + the current attachment / linked-folder / readonly sets).
  // Shared with `RuntimeManager.start()`'s dedup path so a restart rebuilds
  // the exact same root the bare-key callers would. Returns null when the
  // project has no workspaceId (nothing to anchor).
  const spawnOpts = await manager.resolveAnchorSpawnOpts(anchorProjectId)
  if (!spawnOpts) return

  try {
    await manager.stop(projectWorkspaceRuntimeKey(anchorProjectId))
  } catch {
    /* not running — nothing to tear down */
  }

  // Await the resolve so the new boot (with the updated READONLY_ROOTS /
  // member set) is actually up by the time this resolves — that's what makes
  // the runtime-status generation bump observable to a polling client.
  await resolveMod
    .resolveWorkspaceRuntimeUrl(spawnOpts.workspaceId, {
      anchorProjectId,
      attachedProjectIds: spawnOpts.attachedProjectIds,
      localFolders: spawnOpts.localFolders,
      readonlyProjectIds: spawnOpts.readonlyProjectIds,
      logTag: 'AnchorRestart',
      runtimeManager: manager,
    })
    .catch((err: any) => {
      if (err instanceof resolveMod.WorkspaceRuntimeNotEnabledError) return
      console.warn(
        `[local-projects] anchor restart (${hint}) for ${anchorProjectId} failed: ${err?.message ?? err}`,
      )
    })
}

/**
 * Metal never mounts attached projects into the anchor runtime (each project
 * is online only in its own `ws:proj:<id>`), so attaching there is a durable
 * record only and must not restart the anchor.
 */
export function attachmentsMount(): boolean {
  return process.env.SHOGO_LOCAL_MODE === 'true' || !isMetalEnabled()
}

export function restartAnchorRuntimeBackground(anchorProjectId: string, hint: string): void {
  void restartAnchorRuntime(anchorProjectId, hint).catch((err: any) => {
    console.warn(
      `[local-projects] anchor restart (${hint}) for ${anchorProjectId} threw: ${err?.message ?? err}`,
    )
  })
}
