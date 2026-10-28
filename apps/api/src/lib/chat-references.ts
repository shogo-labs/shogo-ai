// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Server-side hardening for the chat composer's "@" references.
 *
 * Two kinds carry trust we must verify before forwarding to the runtime:
 *   - workspace refs: the client sends a built `summary`; we re-derive it from
 *     the DB after confirming membership (see `enrichWorkspaceReferences`).
 *   - project refs: the client tags a sibling project by id; that id drives a
 *     durable ProjectAttachment onto the chat's anchor (so the merged-root
 *     runtime mounts it under `WORKSPACE_DIR/<id>/`), so we confirm the acting
 *     user can access the project and only return same-workspace ids as
 *     attachable (see `enrichProjectReferences`).
 *
 * References the user can't access are dropped so another tenant's data can
 * never be injected into the prompt (or attached). File references are left
 * untouched here — the runtime resolves those from disk (already gated by
 * project membership).
 */

import { prisma } from './prisma'
import { accessibleProjectsWhere, loadAccess } from './authz'
import { readWorkspacePlan } from './history-search'
import { readChatTranscript, describeChatForUser } from './chat-mentionables'

/** Max projects to enumerate in a workspace reference summary. */
const MAX_WORKSPACE_PROJECTS = 50

/**
 * Enrich + access-check `parsedBody.references` in place. Returns true when
 * the references array was modified (so the caller can re-serialize the body).
 */
export async function enrichWorkspaceReferences(
  parsedBody: any,
  actingUserId: string | undefined,
): Promise<boolean> {
  if (!actingUserId) return false
  const refs = parsedBody?.references
  if (!Array.isArray(refs) || refs.length === 0) return false

  let changed = false
  const next: any[] = []

  for (const ref of refs) {
    if (!ref || typeof ref !== 'object' || ref.type !== 'workspace' || !ref.id) {
      next.push(ref)
      continue
    }

    try {
      const member = await prisma.member.findFirst({
        where: { userId: actingUserId, workspaceId: ref.id, projectId: null },
        select: { id: true },
      })
      if (!member) {
        // Not a member — drop the reference entirely.
        changed = true
        continue
      }

      const ws = await prisma.workspace.findUnique({
        where: { id: ref.id },
        select: { name: true, slug: true, description: true },
      })
      if (!ws) {
        next.push(ref)
        continue
      }

      const readable = await accessibleProjectsWhere({ userId: actingUserId, via: 'session' }, ref.id)
      const projects = await prisma.project.findMany({
        where: { workspaceId: ref.id, hidden: false, AND: [readable] },
        select: { name: true },
        orderBy: { name: 'asc' },
        take: MAX_WORKSPACE_PROJECTS,
      })

      const lines = [`Workspace: ${ws.name} (slug: ${ws.slug}, id: ${ref.id})`]
      if (ws.description && ws.description.trim()) {
        lines.push(`Description: ${ws.description.trim()}`)
      }
      if (projects.length > 0) {
        lines.push(
          `Projects (${projects.length}): ${projects.map((p) => p.name).join(', ')}`,
        )
      }

      next.push({
        type: 'workspace',
        id: ref.id,
        name: ws.name,
        slug: ws.slug,
        summary: lines.join('\n'),
      })
      changed = true
    } catch (err: any) {
      console.error(
        '[chat-references] Failed to enrich workspace reference:',
        err?.message,
      )
      next.push(ref)
    }
  }

  if (changed) parsedBody.references = next
  return changed
}

/** True when `userId` can read `projectId` (restricted projects included). */
async function userCanAccessProject(userId: string, projectId: string): Promise<boolean> {
  return (await loadAccess({ userId, via: 'session' }, { projectId })).permissions.has('project:read')
}

/**
 * Enrich + access-check `parsedBody.references` project refs in place.
 *
 * For each `type: 'project'` reference we confirm the acting user can access
 * the project and rewrite its `name` from the DB (authoritative). Refs the user
 * can't access — or that don't exist — are dropped. The returned
 * `attachProjectIds` is the set of SAME-workspace project ids the caller should
 * durably attach to the chat's anchor so the merged-root runtime mounts them
 * under `WORKSPACE_DIR/<id>/` (cross-workspace projects can't share a root, so
 * they're kept as references but not attached).
 *
 * @param runtimeWorkspaceId the workspace whose merged-root runtime serves this
 *   chat; used to decide which refs are attachable. Pass `undefined` to treat
 *   all accessible refs as attachable.
 */
export async function enrichProjectReferences(
  parsedBody: any,
  actingUserId: string | undefined,
  runtimeWorkspaceId: string | undefined,
): Promise<{ changed: boolean; attachProjectIds: string[] }> {
  const refs = parsedBody?.references
  if (!Array.isArray(refs) || refs.length === 0) {
    return { changed: false, attachProjectIds: [] }
  }

  let changed = false
  const attachProjectIds: string[] = []
  const next: any[] = []

  for (const ref of refs) {
    if (!ref || typeof ref !== 'object' || ref.type !== 'project' || !ref.id) {
      next.push(ref)
      continue
    }

    // No acting user → can't validate. Drop rather than trust a client id that
    // would gate a filesystem mount.
    if (!actingUserId) {
      changed = true
      continue
    }

    try {
      const project = await prisma.project.findUnique({
        where: { id: ref.id },
        select: { name: true, workspaceId: true },
      })
      if (!project) {
        changed = true
        continue
      }

      const allowed = await userCanAccessProject(actingUserId, ref.id)
      if (!allowed) {
        changed = true
        continue
      }

      if (!runtimeWorkspaceId || project.workspaceId === runtimeWorkspaceId) {
        attachProjectIds.push(ref.id)
      }

      // Normalize to the authoritative name; strip any stray client fields.
      if (ref.name !== project.name) changed = true
      next.push({ type: 'project', id: ref.id, name: project.name, label: ref.label })
    } catch (err: any) {
      console.error('[chat-references] Failed to enrich project reference:', err?.message)
      next.push(ref)
    }
  }

  if (changed) parsedBody.references = next
  return { changed, attachProjectIds: Array.from(new Set(attachProjectIds)) }
}

/**
 * Validate history references and inline bounded data before it reaches a
 * runtime that may not have the referenced project's files mounted.
 *
 * Chat references resolve across every workspace the acting user can open, so
 * a chat in another workspace can be attached as context; refs the user
 * cannot open are dropped. Plan references stay workspace-scoped (a plan is a
 * file in one workspace's tree).
 *
 * `mode: 'pointer'` (the workspace chat, SHO-191) names the chat and how to
 * read it instead of inlining its transcript: there, tagging a chat is context,
 * not a send, so the agent goes and reads it itself with `read_history`.
 */
export interface EnrichChatReferencesOptions {
  mode?: 'inline' | 'pointer'
}

export async function enrichChatReferences(
  parsedBody: any,
  actingUserId: string | undefined,
  runtimeWorkspaceId: string | undefined,
  options: EnrichChatReferencesOptions = {},
): Promise<boolean> {
  const refs = parsedBody?.references
  if (!Array.isArray(refs) || !refs.length || !actingUserId) return false
  let changed = false
  const next: any[] = []
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object' || (ref.type !== 'chat' && ref.type !== 'plan')) {
      next.push(ref)
      continue
    }
    try {
      if (ref.type === 'chat' && typeof ref.id === 'string') {
        if (options.mode === 'pointer') {
          const chat = await describeChatForUser(actingUserId, ref.id)
          if (!chat) {
            changed = true
            continue
          }
          const pointer = {
            type: 'chat',
            id: chat.id,
            name: chat.title,
            label: ref.label || chat.title,
            ...(chat.projectId ? { projectId: chat.projectId, projectName: chat.projectName } : {}),
            workspaceId: chat.workspaceId,
            workspaceName: chat.workspaceName,
            messageCount: chat.messageCount,
            lastActivityAt: chat.lastActivityAt,
            pointer: true,
          }
          next.push(pointer)
          if (JSON.stringify(pointer) !== JSON.stringify(ref)) changed = true
          continue
        }
        const transcript = await readChatTranscript(actingUserId, ref.id, { limit: 100, maxBytes: 64 * 1024 })
        if (!transcript) {
          changed = true
          continue
        }
        next.push({
          type: 'chat',
          id: ref.id,
          name: transcript.title,
          label: ref.label || transcript.title,
          ...(transcript.projectId ? { projectId: transcript.projectId } : {}),
          transcript: transcript.messages.map((message) => `${message.role}: ${message.text}`).join('\n'),
        })
        if (JSON.stringify(next[next.length - 1]) !== JSON.stringify(ref)) changed = true
      } else if (ref.type === 'plan') {
        const id = typeof ref.planId === 'string' ? ref.planId : typeof ref.id === 'string' ? ref.id : ''
        const plan = id && runtimeWorkspaceId
          ? await readWorkspacePlan(id, { workspaceId: runtimeWorkspaceId, userId: actingUserId })
          : null
        if (!plan) {
          changed = true
          continue
        }
        next.push({
          type: 'plan',
          planId: plan.id,
          filename: plan.filename,
          name: plan.name,
          label: ref.label || plan.name,
          projectId: plan.projectId,
          content: plan.content,
        })
        if (JSON.stringify(next[next.length - 1]) !== JSON.stringify(ref)) changed = true
      }
    } catch (error: any) {
      console.error('[chat-references] Failed to enrich history reference:', error?.message)
      changed = true
    }
  }
  if (changed) parsedBody.references = next
  return changed
}
