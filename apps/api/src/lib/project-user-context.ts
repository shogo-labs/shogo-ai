/**
 * Per-project user context tracking.
 *
 * Maps projectId -> userId so that AI proxy requests (which carry a generic
 * 'system' token) can be attributed to the real user who initiated the chat.
 *
 * Both project-chat.ts and ai-proxy.ts run in the same API server process,
 * so an in-memory Map is sufficient. Entries expire after 1 hour of inactivity.
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
