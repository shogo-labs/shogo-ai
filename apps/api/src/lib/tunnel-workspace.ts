// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace ids on tunnel-authenticated requests.
 *
 * A call arriving from the cloud may carry the cloud-side `workspaceId`, which
 * this machine has never heard of — that id has to be remapped to a local
 * workspace or the FK constraint fails. But since SHO-54 a machine workspace
 * picked in Studio sends its *own* local id, which must be honoured: the
 * desktop has more than one workspace now, so blindly taking the first one
 * returns the wrong workspace's projects and files new ones into it.
 */

/**
 * Keep `workspaceId` when this machine knows it, otherwise fall back to the
 * machine's first workspace (the cloud id case). Returns the original id when
 * both miss, preserving the previous behaviour when no workspace exists yet.
 */
export function resolveTunnelWorkspaceId(prisma: any, workspaceId: string): Promise<string>
export function resolveTunnelWorkspaceId(
  prisma: any,
  workspaceId?: string | null,
): Promise<string | undefined>
export async function resolveTunnelWorkspaceId(
  prisma: any,
  workspaceId?: string | null,
): Promise<string | undefined> {
  if (workspaceId) {
    const known = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    })
    if (known) return workspaceId
  }

  const localWs = await prisma.workspace.findFirst({ select: { id: true } })
  return localWs?.id ?? workspaceId ?? undefined
}
