// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace Chat Session Service
 *
 * CRUD for workspace-scoped chat sessions (contextType='workspace') and
 * the set of projects attached to them (ChatSessionProject). A workspace
 * session lets Shogo operate across several projects in a workspace at
 * once; the attached set drives which subfolders the workspace runtime
 * mounts (see build-workspace-env.ts / resolve-workspace-runtime-url.ts).
 *
 * This is the pure data layer — runtime resolution and chat proxying
 * live in routes/workspace-chat.ts. Every project attach is validated to
 * belong to the same workspace as the session.
 */

import { prisma } from '../lib/prisma'

export type AttachMode = 'readwrite' | 'readonly'

export interface AttachedProject {
  id: string
  projectId: string
  attachMode: AttachMode
}

// Coalesce duplicate first requests in one process. The partial unique index
// introduced in `20260921092000_enforce_workspace_primary_session` is the
// authoritative cross-pod guard; this map merely avoids needless DB races in
// a single API process.
const primarySessionFlights = new Map<string, Promise<any>>()

function normalizeAttachMode(mode: string | undefined | null): AttachMode {
  return mode === 'readonly' ? 'readonly' : 'readwrite'
}

/**
 * Create a workspace-scoped chat session, optionally attaching an
 * initial set of projects. Project ids that don't belong to the
 * workspace are rejected (the whole call fails) to avoid a session that
 * silently drops attachments.
 *
 * `anchorProjectId` pins the session to a project (`contextId`), so chat
 * resolves the same `ws:proj:<anchor>` runtime that serves that project's
 * canvas preview. The anchor is always attached read-write.
 */
export async function createWorkspaceSession(
  workspaceId: string,
  opts: {
    name?: string
    inferredName?: string
    attachProjectIds?: string[]
    attachMode?: AttachMode
    anchorProjectId?: string
  } = {},
): Promise<{ id: string; workspaceId: string; contextId: string | null; attached: AttachedProject[] }> {
  const anchorProjectId = opts.anchorProjectId || undefined
  const attachIds = dedupe([...(anchorProjectId ? [anchorProjectId] : []), ...(opts.attachProjectIds ?? [])])
  if (attachIds.length > 0) {
    await assertProjectsInWorkspace(workspaceId, attachIds)
  }

  const mode = normalizeAttachMode(opts.attachMode)
  const session = await prisma.chatSession.create({
    data: {
      contextType: 'workspace',
      workspaceId,
      contextId: anchorProjectId ?? null,
      name: opts.name ?? null,
      inferredName: opts.inferredName ?? opts.name ?? 'Workspace chat',
      attachedProjects: attachIds.length
        ? {
            create: attachIds.map((projectId) => ({
              projectId,
              attachMode: projectId === anchorProjectId ? 'readwrite' : mode,
            })),
          }
        : undefined,
    } as any,
    include: { attachedProjects: true } as any,
  }) as any

  return {
    id: session.id,
    workspaceId,
    contextId: anchorProjectId ?? null,
    attached: (session.attachedProjects ?? []).map(toAttachedProject),
  }
}

/**
 * Pin an existing workspace session to `projectId` (set `contextId`) when
 * doing so can't change which runtime its other projects live on: the
 * session must not be the workspace's primary chat, must not already be
 * pinned, and must have no attachments besides `projectId`. `pinned` says
 * whether the session is pinned to `projectId` afterwards; `changed` whether
 * this call did the pinning.
 */
export async function pinWorkspaceSessionToProject(
  sessionId: string,
  projectId: string,
): Promise<{ pinned: boolean; changed: boolean }> {
  const session = (await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { contextType: true, contextId: true, isPrimary: true } as any,
  })) as { contextType?: string; contextId?: string | null; isPrimary?: boolean } | null
  if (!session || session.contextType !== 'workspace') return { pinned: false, changed: false }
  if (session.contextId) return { pinned: session.contextId === projectId, changed: false }
  if (session.isPrimary) return { pinned: false, changed: false }

  const attached = await getAttachedProjects(sessionId)
  if (attached.some((a) => a.projectId !== projectId)) return { pinned: false, changed: false }

  const res = (await prisma.chatSession.updateMany({
    where: { id: sessionId, contextType: 'workspace', contextId: null } as any,
    data: { contextId: projectId } as any,
  })) as { count: number }
  return { pinned: res.count > 0, changed: res.count > 0 }
}

/**
 * Convert a legacy project-scoped chat (`contextType='project'`,
 * `contextId=<project>`) into a workspace session pinned to that project, in
 * place, so the chat keeps its id and message history. Clients restore these
 * sessions from saved tabs and send them to the workspace chat routes once the
 * workspace runtime is on. Only converts when the project belongs to
 * `workspaceId`. Returns the anchor project id when this call converted the
 * session, otherwise null.
 */
export async function upgradeProjectSessionToWorkspace(
  workspaceId: string,
  sessionId: string,
): Promise<string | null> {
  const session = (await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { contextType: true, contextId: true } as any,
  })) as { contextType?: string; contextId?: string | null } | null
  if (!session || session.contextType !== 'project' || !session.contextId) return null

  const project = (await prisma.project.findUnique({
    where: { id: session.contextId },
    select: { workspaceId: true },
  })) as { workspaceId?: string | null } | null
  if (!project || project.workspaceId !== workspaceId) return null

  const res = (await prisma.chatSession.updateMany({
    where: { id: sessionId, contextType: 'project', contextId: session.contextId } as any,
    data: { contextType: 'workspace', workspaceId } as any,
  })) as { count: number }
  return res.count > 0 ? session.contextId : null
}

/** Undo `pinWorkspaceSessionToProject` (used to roll back a failed attach). */
export async function unpinWorkspaceSession(sessionId: string, projectId: string): Promise<void> {
  await prisma.chatSession.updateMany({
    where: { id: sessionId, contextId: projectId } as any,
    data: { contextId: null } as any,
  })
}

/**
 * Return the stable main chat for a workspace, creating it once. This is a
 * universal workspace primitive — any workspace runtime can have a primary
 * session — but today only personal workspaces auto-create one eagerly (see
 * `routes/workspace-chat.ts`); team workspaces let users create/select
 * sessions explicitly.
 */
export function getOrCreatePrimaryWorkspaceSession(workspaceId: string): Promise<any> {
  const inFlight = primarySessionFlights.get(workspaceId)
  if (inFlight) return inFlight

  const create = (async () => {
    const existing = await prisma.chatSession.findFirst({
      where: { workspaceId, contextType: 'workspace', isPrimary: true } as any,
      orderBy: { createdAt: 'asc' },
      include: { attachedProjects: true } as any,
    })
    if (existing) return existing as any

    try {
      return await prisma.chatSession.create({
        data: {
          contextType: 'workspace',
          workspaceId,
          isPrimary: true,
          name: 'Chat',
          inferredName: 'Chat',
        } as any,
        include: { attachedProjects: true } as any,
      }) as any
    } catch (err: any) {
      // A second API pod may have won the partial-unique-index race between
      // our lookup and create. Re-read the singleton rather than surfacing a
      // false failure to the client.
      if (err?.code === 'P2002') {
        const raced = await prisma.chatSession.findFirst({
          where: { workspaceId, contextType: 'workspace', isPrimary: true } as any,
          orderBy: { createdAt: 'asc' },
          include: { attachedProjects: true } as any,
        })
        if (raced) return raced as any
      }
      throw err
    }
  })()

  primarySessionFlights.set(workspaceId, create)
  return create.finally(() => {
    if (primarySessionFlights.get(workspaceId) === create) {
      primarySessionFlights.delete(workspaceId)
    }
  })
}

/**
 * Attach a project to an existing workspace session. Idempotent: a
 * repeat attach updates the attachMode rather than failing on the
 * unique (sessionId, projectId) constraint.
 */
export async function attachProject(
  sessionId: string,
  projectId: string,
  attachMode: AttachMode = 'readwrite',
): Promise<AttachedProject> {
  const workspaceId = await getSessionWorkspaceId(sessionId)
  await assertProjectsInWorkspace(workspaceId, [projectId])

  const mode = normalizeAttachMode(attachMode)
  const row = (await prisma.chatSessionProject.upsert({
    where: { sessionId_projectId: { sessionId, projectId } } as any,
    create: { sessionId, projectId, attachMode: mode },
    update: { attachMode: mode },
  })) as any

  return toAttachedProject(row)
}

/**
 * Detach a project from a workspace session. No-op if it wasn't
 * attached. Returns whether a row was removed.
 */
export async function detachProject(sessionId: string, projectId: string): Promise<boolean> {
  const res = (await prisma.chatSessionProject.deleteMany({
    where: { sessionId, projectId },
  })) as { count: number }
  return res.count > 0
}

/** List the projects attached to a workspace session. */
export async function getAttachedProjects(sessionId: string): Promise<AttachedProject[]> {
  const rows = (await prisma.chatSessionProject.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  })) as any[]
  return rows.map(toAttachedProject)
}

/**
 * Ensure a workspace-scoped session belongs to the workspace named in the
 * route. Route-level membership alone is not sufficient: without this check,
 * a member who guessed another session id could read or mutate its project
 * attachments through their own workspace URL.
 */
export async function assertWorkspaceSessionInWorkspace(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const sessionWorkspaceId = await getSessionWorkspaceId(sessionId)
  if (sessionWorkspaceId !== workspaceId) {
    throw new WorkspaceSessionError(
      'session_not_in_workspace',
      `Chat session ${sessionId} does not belong to workspace ${workspaceId}`,
    )
  }
}

/** List workspace-scoped sessions for a workspace (most-recent first). */
export async function listWorkspaceSessions(workspaceId: string) {
  return prisma.chatSession.findMany({
    where: { contextType: 'workspace', workspaceId } as any,
    orderBy: { lastActiveAt: 'desc' },
    include: { attachedProjects: true } as any,
  }) as any
}

// ──────────────────────────────────────────────────────────────────
// internals
// ──────────────────────────────────────────────────────────────────

function dedupe(ids: string[]): string[] {
  return [...new Set(ids.filter((x) => typeof x === 'string' && x.length > 0))]
}

function toAttachedProject(row: any): AttachedProject {
  return {
    id: row.id,
    projectId: row.projectId,
    attachMode: normalizeAttachMode(row.attachMode),
  }
}

async function getSessionWorkspaceId(sessionId: string): Promise<string> {
  const session = (await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { contextType: true, workspaceId: true } as any,
  })) as { contextType?: string; workspaceId?: string | null } | null

  if (!session) {
    throw new WorkspaceSessionError('session_not_found', `Chat session ${sessionId} not found`)
  }
  if (session.contextType !== 'workspace' || !session.workspaceId) {
    throw new WorkspaceSessionError(
      'not_workspace_session',
      `Chat session ${sessionId} is not a workspace session`,
    )
  }
  return session.workspaceId
}

/**
 * Verify every project id belongs to `workspaceId`. Throws
 * WorkspaceSessionError('project_not_in_workspace') listing the
 * offending ids otherwise.
 */
async function assertProjectsInWorkspace(workspaceId: string, projectIds: string[]): Promise<void> {
  const found = (await prisma.project.findMany({
    where: { id: { in: projectIds }, workspaceId },
    select: { id: true },
  })) as Array<{ id: string }>

  const foundIds = new Set(found.map((p) => p.id))
  const missing = projectIds.filter((id) => !foundIds.has(id))
  if (missing.length > 0) {
    throw new WorkspaceSessionError(
      'project_not_in_workspace',
      `Project(s) not in workspace ${workspaceId}: ${missing.join(', ')}`,
    )
  }
}

export type WorkspaceSessionErrorCode =
  | 'session_not_found'
  | 'not_workspace_session'
  | 'session_not_in_workspace'
  | 'project_not_in_workspace'

export class WorkspaceSessionError extends Error {
  constructor(public code: WorkspaceSessionErrorCode, message: string) {
    super(message)
    this.name = 'WorkspaceSessionError'
  }
}
