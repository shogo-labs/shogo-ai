// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Wipe a deleted chat's *durable* transcript (SHO-137).
 *
 * The runtime keeps every session's messages in `.shogo/sessions.db`, which is
 * S3-synced — deleting the `ChatSession` row only removes the API's copy. The
 * idle TTL that used to clean the runtime's copy now deletes nothing (that is
 * the whole point of SHO-137: idle time must never erase a conversation), so a
 * chat the user deleted would otherwise sit in durable storage forever. The
 * runtime's `DELETE /agent/sessions/:id` is the only path that wipes it.
 *
 * Best-effort by design: the row is already gone and the request must not fail
 * because a runtime could not be reached. A miss is logged — the conversation
 * is unreachable from the app either way, since nothing references its id.
 */

/** The scope a deleted session needs for its runtime to be found. */
export interface DeletedChatScope {
  id: string
  contextType?: string | null
  contextId?: string | null
  workspaceId?: string | null
}

export type PurgeOutcome = {
  purged: boolean
  /** Why it was skipped or failed; absent on success. */
  reason?: string
}

export type PurgeDeps = {
  fetchFromProjectRuntime: (
    projectId: string,
    path: string,
    init?: RequestInit,
  ) => Promise<Response>
  fetchFromWorkspaceRuntime: (
    workspaceId: string,
    attachedProjectIds: string[],
    path: string,
    init?: RequestInit,
    extra?: { anchorProjectId?: string },
  ) => Promise<Response>
}

/** A cold runtime must not hold a delete open; the wipe is not worth a stall. */
const PURGE_TIMEOUT_MS = 5_000

async function defaultDeps(): Promise<PurgeDeps> {
  const { fetchFromProjectRuntime, fetchFromWorkspaceRuntime } = await import('../lib/chat-runtime-fetch')
  return {
    fetchFromProjectRuntime: (projectId, path, init) => fetchFromProjectRuntime(projectId, path, init),
    fetchFromWorkspaceRuntime: (workspaceId, attachedProjectIds, path, init, extra) =>
      fetchFromWorkspaceRuntime(workspaceId, attachedProjectIds, path, init, extra),
  }
}

export async function purgeChatSessionHistory(
  scope: DeletedChatScope,
  deps?: PurgeDeps,
): Promise<PurgeOutcome> {
  const path = `/agent/sessions/${encodeURIComponent(scope.id)}`
  const init: RequestInit = {
    method: 'DELETE',
    signal: AbortSignal.timeout(PURGE_TIMEOUT_MS),
  }

  try {
    const fetchers = deps ?? (await defaultDeps())
    let response: Response | null = null
    let target = ''

    if (scope.contextType === 'project' && scope.contextId) {
      target = `project ${scope.contextId}`
      response = await fetchers.fetchFromProjectRuntime(scope.contextId, path, init)
    } else if (scope.workspaceId) {
      target = `workspace ${scope.workspaceId}`
      // A workspace chat can live on a project-anchored runtime; when the
      // session carried an anchor, ask for that one rather than the
      // workspace-keyed runtime it never ran on.
      response = await fetchers.fetchFromWorkspaceRuntime(
        scope.workspaceId,
        [],
        path,
        init,
        scope.contextId ? { anchorProjectId: scope.contextId } : undefined,
      )
    }

    if (!response) {
      console.warn(`[ChatSession] no runtime to purge history for ${scope.id} (no project or workspace scope)`)
      return { purged: false, reason: 'no_runtime_scope' }
    }
    if (response.ok) {
      // One line per deleted chat: without it a working purge and a purge that
      // never ran look identical in the logs (SHO-137 round 2).
      console.log(`[ChatSession] purged runtime history for ${scope.id} on ${target}`)
    } else {
      console.warn(
        `[ChatSession] history purge for ${scope.id} on ${target} answered ${response.status}; ` +
          'the transcript stays in the runtime\'s sessions.db (unreachable, but retained)',
      )
      return { purged: false, reason: `runtime_${response.status}` }
    }
    return { purged: true }
  } catch (error: any) {
    console.warn(`[ChatSession] history purge for ${scope.id} failed:`, error?.message || error)
    return { purged: false, reason: error?.name === 'TimeoutError' ? 'timeout' : 'error' }
  }
}
