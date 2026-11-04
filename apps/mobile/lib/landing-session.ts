// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The empty chat the team landing (`/`) opens.
 *
 * A cold start must show a *fresh* conversation, not the previous one — but
 * creating the session on every landing leaves an empty row behind in the
 * sidebar history for each reload. So the landing reuses the empty chat it
 * opened last time, and only mints a new one once that chat has a message
 * in it (or the user has none).
 *
 * Only landing chats are candidates: the landing stamps them with
 * `LANDING_SESSION_NAME`, which no other surface uses (the sidebar's
 * "+ new chat" gets the API default, the notch uses "New chat", new-project
 * chats use "Untitled"), so an empty chat a user created deliberately is
 * never hijacked.
 */

/** `inferredName` the landing stamps on the chat it opens. */
export const LANDING_SESSION_NAME = 'Chat'

/** What `ensureLandingSession` needs to know about a listed session. */
export interface LandingSessionCandidate {
  id: string
  inferredName?: string | null
  isArchived?: boolean
  /** Messages in the chat; missing means the API did not report a count. */
  messageCount?: number
}

/**
 * The newest empty landing chat in `sessions` (the API lists newest first),
 * or `null` when every landing chat has a conversation in it.
 */
export function pickReusableLandingSession(
  sessions: readonly LandingSessionCandidate[],
): string | null {
  for (const session of sessions) {
    if (session.isArchived) continue
    if (session.inferredName !== LANDING_SESSION_NAME) continue
    // An unknown count is treated as "has messages": reusing a chat that may
    // hold the previous conversation would be worse than one extra empty row.
    if ((session.messageCount ?? 1) > 0) continue
    return session.id
  }
  return null
}

export interface EnsureLandingSessionDeps {
  list: (workspaceId: string) => Promise<readonly LandingSessionCandidate[]>
  create: (workspaceId: string) => Promise<{ id: string }>
}

/**
 * The landing session for `workspaceId`: the existing empty landing chat when
 * there is one, otherwise a newly created one. A failed list falls back to
 * creating, so a listing hiccup cannot leave the landing with no chat at all.
 *
 * Single-flight per workspace for the whole JS session, not per caller. The
 * landing screen can legitimately remount (a workspace switch, a route change,
 * a key that moved), and a guard held in a component ref dies with it: the new
 * instance lists before the first create has landed, sees nothing, and mints a
 * second empty chat for the same workspace (SHO-309, caught in CI as two empty
 * landing chats 30 ms apart). The map outlives the component, so the second
 * caller joins the first one's answer instead of racing it.
 *
 * It holds only the *in-flight* attempt, and is dropped as soon as it settles:
 * this is a guard against a race, not a memory. A later landing must list
 * again, because the chat it opened last time may have a conversation in it by
 * then and the landing owes the person a fresh one.
 */
const landingSessions = new Map<string, Promise<{ id: string }>>()

export function ensureLandingSession(
  workspaceId: string,
  deps: EnsureLandingSessionDeps,
): Promise<{ id: string }> {
  const inFlight = landingSessions.get(workspaceId)
  if (inFlight) return inFlight
  const promise = (async () => {
    let reusable: string | null = null
    try {
      reusable = pickReusableLandingSession(await deps.list(workspaceId))
    } catch {
      reusable = null
    }
    if (reusable) return { id: reusable }
    return deps.create(workspaceId)
  })()
  landingSessions.set(workspaceId, promise)
  const settle = () => {
    if (landingSessions.get(workspaceId) === promise) landingSessions.delete(workspaceId)
  }
  promise.then(settle, settle)
  return promise
}

/** Forget any in-flight landing attempt (tests, and a sign-out). */
export function resetLandingSessions(): void {
  landingSessions.clear()
}
