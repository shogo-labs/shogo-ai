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
        where: { userId: actingUserId, workspaceId: ref.id },
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

      const projects = await prisma.project.findMany({
        where: { workspaceId: ref.id },
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

/**
 * True when `userId` can access `projectId`. Workspace membership grants access
 * to every project in that workspace; otherwise a project-scoped membership row
 * is required. Mirrors `verifyProjectAccess` in server.ts.
 */
async function userCanAccessProject(
  userId: string,
  projectId: string,
  workspaceId: string,
): Promise<boolean> {
  const wsMember = await prisma.member.findFirst({
    where: { userId, workspaceId },
    select: { id: true },
  })
  if (wsMember) return true
  const projMember = await prisma.member.findFirst({
    where: { userId, projectId },
    select: { id: true },
  })
  return !!projMember
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

      const allowed = await userCanAccessProject(actingUserId, ref.id, project.workspaceId)
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
