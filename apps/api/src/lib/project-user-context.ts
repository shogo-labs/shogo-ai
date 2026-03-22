// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-project user context tracking.
 *
 * Maps projectId -> userId so that AI proxy requests (which carry a generic
 * 'system' token) can be attributed to the real user who initiated the chat.
 *
 * Both project-chat.ts and ai-proxy.ts run in the same API server process,
 * so an in-memory Map is sufficient. Entries expire after 1 hour of inactivity.
 *
 * For durable attribution (survives API restarts / multi-pod), use
 * {@link getProjectOwnerUserId} which queries the database for the workspace
 * owner — suitable for embedding in long-lived proxy tokens.
 */

const EXPIRY_MS = 60 * 60 * 1000

interface UserContext {
  userId: string
  updatedAt: number
}

const contextMap = new Map<string, UserContext>()

/** Record which user is currently interacting with a project. */
export function setProjectUser(projectId: string, userId: string): void {
  contextMap.set(projectId, { userId, updatedAt: Date.now() })
}

/**
 * Get the most recent authenticated user for a project.
 * Returns undefined if no context is set or it has expired.
 */
export function getProjectUser(projectId: string): string | undefined {
  const ctx = contextMap.get(projectId)
  if (!ctx) return undefined
  if (Date.now() - ctx.updatedAt > EXPIRY_MS) {
    contextMap.delete(projectId)
    return undefined
  }
  return ctx.userId
}

/**
 * Look up the workspace owner's userId for a given project via the database.
 * Falls back to 'system' if the lookup fails (e.g., project not found, DB error).
 *
 * Use this when generating long-lived proxy tokens — it's more reliable than
 * the in-memory map since it survives API restarts and works across replicas.
 */
export async function getProjectOwnerUserId(projectId: string): Promise<string> {
  try {
    const { prisma } = await import('./prisma')
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        workspace: {
          select: {
            members: {
              where: { role: 'owner' },
              select: { userId: true },
              take: 1,
            },
          },
        },
      },
    })
    const ownerId = project?.workspace?.members?.[0]?.userId
    if (ownerId) return ownerId
    console.warn(`[ProjectUserContext] No owner found for project ${projectId}, falling back to 'system'`)
    return 'system'
  } catch (err: any) {
    console.error(`[ProjectUserContext] Failed to look up owner for project ${projectId}:`, err.message)
    return 'system'
  }
}
