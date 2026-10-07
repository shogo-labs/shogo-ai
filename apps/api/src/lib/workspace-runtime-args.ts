// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Runtime resolution inputs for a workspace chat session, read without side
 * effects. The chat routes first upgrade/sync the session (see
 * `loadRuntimeArgs` in routes/workspace-chat.ts); background callers such as
 * the metal re-warm job must not mutate sessions and use this directly.
 */

import { prisma } from './prisma'
import { getAnchorLocalFolders } from '../services/project-attachment.service'
import {
  assertWorkspaceSessionInWorkspace,
  getAttachedProjects,
  type AttachMode,
} from '../services/workspace-session.service'

export interface WorkspaceRuntimeExtra {
  anchorProjectId?: string
  localFolders?: string[]
  readonlyProjectIds?: string[]
}

export interface WorkspaceSessionRuntimeArgs {
  attachedProjectIds: string[]
  extra: WorkspaceRuntimeExtra
}

/**
 * Anchor-aware runtime resolution opts for a session.
 *
 * A workspace session can be PROJECT-PINNED: its `contextId` is the anchor
 * project of an anchor-keyed merged-root runtime (the universal "every
 * project runs on the workspace runtime" path). When pinned we tell the
 * resolver the anchor (so it keys `ws:proj:<anchor>` + adds the anchor's
 * linked folders) and which attached projects are read-only. Home/workspace
 * sessions (no `contextId`) resolve the workspace-keyed runtime as before.
 */
export async function anchorRuntimeOpts(
  sessionId: string,
  attached: { projectId: string; attachMode: AttachMode }[],
): Promise<WorkspaceRuntimeExtra> {
  let anchorProjectId: string | undefined
  try {
    const session = (await prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: { contextId: true } as any,
    })) as { contextId?: string | null } | null
    anchorProjectId = session?.contextId ?? undefined
  } catch {
    anchorProjectId = undefined
  }
  if (!anchorProjectId) return {}

  const readonlyProjectIds = attached
    .filter((a) => a.attachMode === 'readonly')
    .map((a) => a.projectId)

  let localFolders: string[] = []
  try {
    localFolders = await getAnchorLocalFolders(anchorProjectId)
  } catch {
    localFolders = []
  }

  return { anchorProjectId, localFolders, readonlyProjectIds }
}

/** The attached project ids plus anchor-aware extras for a session. */
export async function readWorkspaceSessionRuntimeArgs(
  workspaceId: string,
  sessionId: string,
): Promise<WorkspaceSessionRuntimeArgs> {
  await assertWorkspaceSessionInWorkspace(workspaceId, sessionId)
  const attached = await getAttachedProjects(sessionId)
  const attachedProjectIds = attached.map((a) => a.projectId)
  const extra = await anchorRuntimeOpts(sessionId, attached)
  return { attachedProjectIds, extra }
}
