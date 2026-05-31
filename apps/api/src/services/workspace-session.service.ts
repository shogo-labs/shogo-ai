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

function normalizeAttachMode(mode: string | undefined | null): AttachMode {
  return mode === 'readonly' ? 'readonly' : 'readwrite'
}

/**
 * Create a workspace-scoped chat session, optionally attaching an
 * initial set of projects. Project ids that don't belong to the
 * workspace are rejected (the whole call fails) to avoid a session that
 * silently drops attachments.
 */
export async function createWorkspaceSession(
  workspaceId: string,
  opts: {
    name?: string
    inferredName?: string
    attachProjectIds?: string[]
    attachMode?: AttachMode
  } = {},
): Promise<{ id: string; workspaceId: string; attached: AttachedProject[] }> {
  const attachIds = dedupe(opts.attachProjectIds ?? [])
  if (attachIds.length > 0) {
    await assertProjectsInWorkspace(workspaceId, attachIds)
  }

  const mode = normalizeAttachMode(opts.attachMode)
  const session = await prisma.chatSession.create({
    data: {
      contextType: 'workspace',
      workspaceId,
      name: opts.name ?? null,
      inferredName: opts.inferredName ?? opts.name ?? 'Workspace chat',
      attachedProjects: attachIds.length
        ? { create: attachIds.map((projectId) => ({ projectId, attachMode: mode })) }
        : undefined,
    } as any,
    include: { attachedProjects: true } as any,
  }) as any

  return {
    id: session.id,
    workspaceId,
    attached: (session.attachedProjects ?? []).map(toAttachedProject),
  }
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
  | 'project_not_in_workspace'

export class WorkspaceSessionError extends Error {
  constructor(public code: WorkspaceSessionErrorCode, message: string) {
    super(message)
    this.name = 'WorkspaceSessionError'
  }
}
