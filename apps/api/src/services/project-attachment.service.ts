// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project Attachment Service
 *
 * Persistent project-to-project attachments (`ProjectAttachment`) and the
 * per-project PINNED workspace chat session that materializes them.
 *
 * Model: every project is the ANCHOR of an anchor-keyed merged-root
 * workspace runtime (see apps/api/src/lib/runtime/manager.ts
 * `startProjectWorkspace`). The Folders panel writes durable attachments on
 * the Project; this service keeps a single workspace `ChatSession`
 * (contextType='workspace', `contextId`=anchor) in lockstep with those
 * attachments so opening the project boots the merged runtime mounting
 * `[anchor + attached projects + linked folders]`.
 *
 * Attachments are validated to live in the same org workspace as the anchor
 * (reuse of `assertProjectsInWorkspace` semantics), and self-attach is
 * rejected.
 */

import { prisma } from '../lib/prisma'
import type { AttachMode } from './workspace-session.service'

export interface ProjectAttachmentRow {
  id: string
  attachedProjectId: string
  attachedProjectName: string | null
  attachMode: AttachMode
}

function normalizeAttachMode(mode: string | undefined | null): AttachMode {
  return mode === 'readonly' ? 'readonly' : 'readwrite'
}

export type ProjectAttachmentErrorCode =
  | 'project_not_found'
  | 'self_attach'
  | 'cross_workspace'

export class ProjectAttachmentError extends Error {
  constructor(public code: ProjectAttachmentErrorCode, message: string) {
    super(message)
    this.name = 'ProjectAttachmentError'
  }
}

/** List the persistent attachments on an anchor project. */
export async function listAttachments(anchorProjectId: string): Promise<ProjectAttachmentRow[]> {
  const rows = (await prisma.projectAttachment.findMany({
    where: { projectId: anchorProjectId },
    orderBy: { createdAt: 'asc' },
    include: { attached: { select: { id: true, name: true } } } as any,
  })) as any[]
  return rows.map((r) => ({
    id: r.id,
    attachedProjectId: r.attachedProjectId,
    attachedProjectName: r.attached?.name ?? null,
    attachMode: normalizeAttachMode(r.attachMode),
  }))
}

/**
 * Attach `attachedProjectId` to `anchorProjectId` (idempotent — a repeat
 * attach updates the attachMode). Validates both projects exist in the same
 * workspace and rejects self-attach, then re-syncs the pinned session.
 */
export async function attachProjectToProject(
  anchorProjectId: string,
  attachedProjectId: string,
  attachMode: AttachMode = 'readwrite',
): Promise<ProjectAttachmentRow> {
  if (anchorProjectId === attachedProjectId) {
    throw new ProjectAttachmentError('self_attach', 'A project cannot be attached to itself')
  }
  const anchor = await prisma.project.findUnique({
    where: { id: anchorProjectId },
    select: { id: true, workspaceId: true },
  })
  if (!anchor) {
    throw new ProjectAttachmentError('project_not_found', `Anchor project ${anchorProjectId} not found`)
  }
  const attached = await prisma.project.findUnique({
    where: { id: attachedProjectId },
    select: { id: true, workspaceId: true },
  })
  if (!attached) {
    throw new ProjectAttachmentError('project_not_found', `Attached project ${attachedProjectId} not found`)
  }
  if (attached.workspaceId !== anchor.workspaceId) {
    throw new ProjectAttachmentError(
      'cross_workspace',
      `Project ${attachedProjectId} is not in the same workspace as ${anchorProjectId}`,
    )
  }

  const mode = normalizeAttachMode(attachMode)
  const row = (await prisma.projectAttachment.upsert({
    where: { projectId_attachedProjectId: { projectId: anchorProjectId, attachedProjectId } } as any,
    create: { projectId: anchorProjectId, attachedProjectId, attachMode: mode },
    update: { attachMode: mode },
    include: { attached: { select: { id: true, name: true } } } as any,
  })) as any

  await syncPinnedSessionAttachments(anchorProjectId)

  return {
    id: row.id,
    attachedProjectId: row.attachedProjectId,
    attachedProjectName: row.attached?.name ?? null,
    attachMode: normalizeAttachMode(row.attachMode),
  }
}

/** Detach a project. No-op if it wasn't attached. Returns whether removed. */
export async function detachProjectFromProject(
  anchorProjectId: string,
  attachedProjectId: string,
): Promise<boolean> {
  const res = (await prisma.projectAttachment.deleteMany({
    where: { projectId: anchorProjectId, attachedProjectId },
  })) as { count: number }
  if (res.count > 0) {
    await syncPinnedSessionAttachments(anchorProjectId)
  }
  return res.count > 0
}

/** Linked local host folders on the anchor (reused `ProjectFolder` rows). */
export async function getAnchorLocalFolders(anchorProjectId: string): Promise<string[]> {
  const rows = (await prisma.projectFolder.findMany({
    where: { projectId: anchorProjectId },
    select: { path: true },
  })) as Array<{ path: string }>
  return rows.map((r) => r.path).filter((p) => typeof p === 'string' && p.length > 0)
}

/**
 * Find (or create) the project-pinned workspace session for an anchor —
 * a `contextType='workspace'` ChatSession whose `contextId` is the anchor.
 * Seeds its attached-project set on creation.
 */
export async function getOrCreatePinnedWorkspaceSession(
  anchorProjectId: string,
): Promise<{ id: string; workspaceId: string }> {
  const anchor = await prisma.project.findUnique({
    where: { id: anchorProjectId },
    select: { id: true, workspaceId: true, name: true },
  })
  if (!anchor) {
    throw new ProjectAttachmentError('project_not_found', `Anchor project ${anchorProjectId} not found`)
  }

  const existing = (await prisma.chatSession.findFirst({
    where: { contextType: 'workspace', contextId: anchorProjectId } as any,
    select: { id: true },
  })) as { id: string } | null

  if (existing) {
    return { id: existing.id, workspaceId: anchor.workspaceId }
  }

  const session = (await prisma.chatSession.create({
    data: {
      contextType: 'workspace',
      contextId: anchorProjectId,
      workspaceId: anchor.workspaceId,
      inferredName: anchor.name ?? 'Project workspace',
    } as any,
    select: { id: true },
  })) as { id: string }

  await syncPinnedSessionAttachments(anchorProjectId, session.id)
  return { id: session.id, workspaceId: anchor.workspaceId }
}

/**
 * Reconcile the pinned session's `ChatSessionProject` rows to exactly
 * `[anchor (readwrite), ...ProjectAttachment (mode)]`. Called on create and
 * on every attach/detach so "every chat opened in this project includes the
 * attached projects/folders".
 */
export async function syncPinnedSessionAttachments(
  anchorProjectId: string,
  sessionId?: string,
): Promise<void> {
  const sid = sessionId ?? (await getOrCreatePinnedWorkspaceSession(anchorProjectId)).id

  const attachments = (await prisma.projectAttachment.findMany({
    where: { projectId: anchorProjectId },
    select: { attachedProjectId: true, attachMode: true },
  })) as Array<{ attachedProjectId: string; attachMode: string }>

  // Desired set: anchor first (always read-write), then attachments.
  const desired = new Map<string, AttachMode>()
  desired.set(anchorProjectId, 'readwrite')
  for (const a of attachments) {
    desired.set(a.attachedProjectId, normalizeAttachMode(a.attachMode))
  }

  const current = (await prisma.chatSessionProject.findMany({
    where: { sessionId: sid },
    select: { projectId: true, attachMode: true },
  })) as Array<{ projectId: string; attachMode: string }>
  const currentMap = new Map(current.map((c) => [c.projectId, normalizeAttachMode(c.attachMode)]))

  // Remove rows no longer desired.
  const toRemove = current.filter((c) => !desired.has(c.projectId)).map((c) => c.projectId)
  if (toRemove.length > 0) {
    await prisma.chatSessionProject.deleteMany({
      where: { sessionId: sid, projectId: { in: toRemove } },
    })
  }

  // Upsert desired rows (create missing / update changed attachMode).
  for (const [projectId, mode] of desired) {
    if (currentMap.get(projectId) === mode) continue
    await prisma.chatSessionProject.upsert({
      where: { sessionId_projectId: { sessionId: sid, projectId } } as any,
      create: { sessionId: sid, projectId, attachMode: mode },
      update: { attachMode: mode },
    })
  }
}
