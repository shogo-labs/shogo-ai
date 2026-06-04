// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Server-side hardening for the chat composer's "@" workspace references.
 *
 * The web composer sends a client-built `summary` for each tagged org/team
 * workspace. Before forwarding the chat body to the agent runtime we:
 *   1. verify the acting user is actually a member of that workspace, and
 *   2. replace the client summary with authoritative DB metadata plus the
 *      live project list.
 *
 * References the user can't access are dropped so another tenant's data can
 * never be injected into the prompt. File references are intentionally left
 * untouched here — the runtime resolves those from the project's own
 * workspace on disk (already gated by project membership).
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
