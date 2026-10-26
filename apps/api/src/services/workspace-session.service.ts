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

// Coalesce duplicate first requests in one process, keyed by workspace and
// user. A cross-pod race can still create one extra empty chat; both belong
// to the same user and show up in their history.
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
    /**
     * Owner of a personal workspace-agent chat. Ignored when the session is
     * pinned to a project: those chats stay shared, like other project chats.
     */
    createdByUserId?: string
  } = {},
): Promise<{
  id: string
  workspaceId: string
  contextId: string | null
  name: string | null
  inferredName: string | null
  createdAt: string | null
  lastActiveAt: string | null
  attached: AttachedProject[]
}> {
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
      createdByUserId: anchorProjectId ? null : (opts.createdByUserId ?? null),
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
    name: session.name ?? null,
    inferredName: session.inferredName ?? null,
    createdAt: toIsoOrNull(session.createdAt),
    lastActiveAt: toIsoOrNull(session.lastActiveAt),
    attached: (session.attachedProjects ?? []).map(toAttachedProject),
  }
}

function toIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' && value.length > 0) return new Date(value).toISOString()
  return null
}

/**
 * Pin an existing workspace session to `projectId` (set `contextId`) when
 * doing so can't change which runtime its other projects live on: the
 * session must not already be pinned, and must have no attachments besides
 * `projectId`. `pinned` says
 * whether the session is pinned to `projectId` afterwards; `changed` whether
 * this call did the pinning.
 */
export async function pinWorkspaceSessionToProject(
  sessionId: string,
  projectId: string,
): Promise<{ pinned: boolean; changed: boolean }> {
  const session = (await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { contextType: true, contextId: true } as any,
  })) as { contextType?: string; contextId?: string | null } | null
  if (!session || session.contextType !== 'workspace') return { pinned: false, changed: false }
  if (session.contextId) return { pinned: session.contextId === projectId, changed: false }

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
 * Return the caller's most recently active personal workspace chat, creating
 * one when they have none. There is no shared "main" chat: each member lands
 * on their own history, the same way a project opens its latest chat.
 *
 * A race across API pods can create one extra empty chat. That is harmless
 * (both show up in the owner's history), so this does not take a unique index.
 */
export function getOrCreateDefaultWorkspaceSession(workspaceId: string, userId: string): Promise<any> {
  const key = `${workspaceId}:${userId}`
  const inFlight = primarySessionFlights.get(key)
  if (inFlight) return inFlight

  const create = (async () => {
    const existing = await prisma.chatSession.findFirst({
      where: {
        workspaceId,
        contextType: 'workspace',
        createdByUserId: userId,
        contextId: null,
        isArchived: false,
      } as any,
      orderBy: { lastActiveAt: 'desc' },
      include: { attachedProjects: true } as any,
    })
    if (existing) return existing as any

    return await prisma.chatSession.create({
      data: {
        contextType: 'workspace',
        workspaceId,
        createdByUserId: userId,
        name: 'Chat',
        inferredName: 'Chat',
      } as any,
      include: { attachedProjects: true } as any,
    }) as any
  })()

  primarySessionFlights.set(key, create)
  return create.finally(() => {
    if (primarySessionFlights.get(key) === create) {
      primarySessionFlights.delete(key)
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
  const workspaceId = (await loadWorkspaceSession(sessionId)).workspaceId
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
  const session = await loadWorkspaceSession(sessionId)
  if (session.workspaceId !== workspaceId) {
    throw new WorkspaceSessionError(
      'session_not_in_workspace',
      `Chat session ${sessionId} does not belong to workspace ${workspaceId}`,
    )
  }
}

/**
 * Same workspace check as `assertWorkspaceSessionInWorkspace`, plus ownership.
 * A session with an owner is visible only to that user. Sessions with no
 * owner (project-anchored, scheduled, DM, Slack, and legacy shared chats)
 * stay reachable by any workspace member. A foreign owner is reported as
 * not-found so a guessed id does not reveal that the chat exists.
 */
export async function assertWorkspaceSessionAccess(
  workspaceId: string,
  sessionId: string,
  userId: string,
): Promise<void> {
  const session = await loadWorkspaceSession(sessionId)
  if (session.workspaceId !== workspaceId) {
    throw new WorkspaceSessionError(
      'session_not_in_workspace',
      `Chat session ${sessionId} does not belong to workspace ${workspaceId}`,
    )
  }
  if (session.createdByUserId && session.createdByUserId !== userId) {
    throw new WorkspaceSessionError('session_not_found', `Chat session ${sessionId} not found`)
  }
}

/**
 * List the caller's personal workspace chats (most-recent first).
 *
 * `messageCount` is the session's real message count, so a client can tell an
 * empty chat from one that has a conversation in it (the landing reuses an
 * empty chat instead of minting a new one on every cold start).
 */
export async function listWorkspaceSessions(workspaceId: string, userId: string) {
  const rows = (await prisma.chatSession.findMany({
    where: { contextType: 'workspace', workspaceId, createdByUserId: userId } as any,
    orderBy: { lastActiveAt: 'desc' },
    include: { attachedProjects: true, _count: { select: { messages: true } } } as any,
  })) as any[]

  return rows.map(({ _count, ...row }) => ({
    ...row,
    messageCount: _count?.messages ?? 0,
  }))
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

async function loadWorkspaceSession(sessionId: string): Promise<{
  workspaceId: string
  createdByUserId: string | null
}> {
  const session = (await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { contextType: true, workspaceId: true, createdByUserId: true } as any,
  })) as { contextType?: string; workspaceId?: string | null; createdByUserId?: string | null } | null

  if (!session) {
    throw new WorkspaceSessionError('session_not_found', `Chat session ${sessionId} not found`)
  }
  if (session.contextType !== 'workspace' || !session.workspaceId) {
    throw new WorkspaceSessionError(
      'not_workspace_session',
      `Chat session ${sessionId} is not a workspace session`,
    )
  }
  return { workspaceId: session.workspaceId, createdByUserId: session.createdByUserId ?? null }
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
