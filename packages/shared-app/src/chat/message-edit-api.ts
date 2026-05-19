// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat message edit helpers.
 *
 * Thin wrappers around the `/api/chat-messages` extension endpoints
 * (see `apps/api/src/routes/chat-message-edits.ts`) and the existing
 * `/api/projects/:id/checkpoints/:cid/rollback` endpoint. Living in
 * shared-app — instead of the auto-generated domain-stores collection
 * — keeps the codegen output untouched while letting both the web
 * and native chat UIs share one implementation.
 *
 * The helpers go through the SDK HttpClient bound to a passed-in MST
 * collection node (`getEnv(collection).http`). That HttpClient is the
 * SAME one the auto-generated CRUD uses, so the remote-aware
 * interceptor (see `remote-http-interceptor.ts`) still proxies the
 * request to the desktop instance when one is connected.
 *
 * Events:
 *   - `SHOGO_FILES_REVERTED_EVENT` — dispatched on `window` after a
 *     successful `rollbackProjectToCheckpoint`. Editors / file-tree
 *     views can listen for this and refetch. We do NOT bind any
 *     consumers here — same hands-off pattern as `FIX_IN_AGENT_EVENT`
 *     in `apps/mobile/components/project/panels/ide/agentFixProvider.ts`.
 */

import { getEnv } from 'mobx-state-tree'
import type {
  IChatMessageCollection,
  ISDKEnvironment,
} from '@shogo/domain-stores'

export interface TruncateFromResult {
  ok: true
  sessionId: string
  deletedCount: number
}

/**
 * Reason codes returned alongside `checkpoint: null` from the
 * preceding-checkpoint endpoint. None of these are errors — they're
 * expected "no rollback available" branches the dialog can render
 * as a soft hint instead of a failure.
 */
export type PrecedingCheckpointReason =
  | 'no_project_context' // ChatSession was scoped to a Feature, not a Project
  | 'external_mode' // Folder-linked project — Shogo doesn't manage its git
  | 'no_checkpoint' // No prior checkpoint exists for this project

export interface PrecedingCheckpoint {
  id: string
  name: string | null
  commitMessage: string
  filesChanged: number
  additions: number
  deletions: number
  isAutomatic: boolean
  includesDb: boolean
  createdAt: string
}

export interface PrecedingCheckpointResult {
  ok: true
  checkpoint: PrecedingCheckpoint | null
  projectId?: string
  reason?: PrecedingCheckpointReason
}

/**
 * Window event name dispatched after a successful project rollback.
 * Listeners (e.g. the Monaco editor or the file tree) should
 * refetch their view of the workspace because files on disk just
 * moved underneath them. The event carries the projectId +
 * checkpointId so listeners can filter to the relevant project
 * when several are open.
 */
export const SHOGO_FILES_REVERTED_EVENT = 'shogo:files-reverted'

export interface FilesRevertedDetail {
  projectId: string
  checkpointId: string
  /** When the source checkpoint was created (ISO 8601). */
  checkpointCreatedAt: string
}

/**
 * Delete a chat message and every message that follows it in the same
 * session, atomically on the server.
 *
 * Used by the in-place edit flow (edit a previously sent user message,
 * confirm, then re-send) and by "Retry from here" — both want the
 * message to vanish from history so the subsequent `sendMessage` call
 * can re-create it cleanly.
 *
 * Also removes any matching items from the local MST collection so
 * UIs hydrating from the cache (e.g. the `Load earlier messages`
 * footer) don't display ghosts until the next `loadPage`.
 */
export async function truncateMessagesFrom(
  collection: IChatMessageCollection,
  messageId: string,
): Promise<TruncateFromResult> {
  const env = getEnv<ISDKEnvironment>(collection)
  const response = await env.http.post<TruncateFromResult>(
    `/api/chat-messages/${messageId}/truncate-from`,
    {},
  )

  if (!response.data?.ok) {
    throw new Error('Failed to truncate messages')
  }

  // Mirror the deletion locally. The auto-generated collection has
  // no concept of "delete many by cutoff" so we walk the cache and
  // drop everything at-or-after the target's createdAt. Failing to
  // mirror here is non-fatal — the next `loadPage` would reconcile.
  // We still do it so that any view reading from `collection.all`
  // (e.g. `handleSaveToolOutput` in ChatPanel) doesn't see a row
  // that was deleted server-side.
  const target = collection.get(messageId)
  if (target) {
    const cutoff = target.createdAt
    const sessionId = target.sessionId
    const toRemove: string[] = []
    for (const item of collection.all) {
      if (item.sessionId === sessionId && item.createdAt >= cutoff) {
        toRemove.push(item.id)
      }
    }
    for (const id of toRemove) {
      collection.removeItem(id)
    }
  }

  return response.data
}

/**
 * Look up the most recent `ProjectCheckpoint` whose `createdAt` is
 * strictly less than the target message's `createdAt`, for the
 * project that owns the message's session.
 *
 * This is the rollback target offered alongside the "Edit & Discard"
 * confirmation. Returns `{ checkpoint: null, reason }` for the
 * perfectly expected zero-match cases (no project context, external
 * mode, no prior checkpoint at all) so the dialog can render an
 * inline hint instead of treating these as errors.
 *
 * Like `truncateMessagesFrom`, this goes through the SDK HttpClient
 * so the remote-aware interceptor proxies to the desktop instance
 * when connected.
 */
export async function getPrecedingCheckpoint(
  collection: IChatMessageCollection,
  messageId: string,
): Promise<PrecedingCheckpointResult> {
  const env = getEnv<ISDKEnvironment>(collection)
  const response = await env.http.get<PrecedingCheckpointResult>(
    `/api/chat-messages/${messageId}/preceding-checkpoint`,
  )
  if (!response.data?.ok) {
    throw new Error('Failed to look up preceding checkpoint')
  }
  return response.data
}

export interface RollbackResult {
  projectId: string
  checkpointId: string
}

/**
 * Roll the project workspace back to a known checkpoint and fire
 * `SHOGO_FILES_REVERTED_EVENT` on success so editor views can
 * refetch.
 *
 * The server endpoint (defined in `apps/api/src/routes/checkpoints.ts`)
 * does the destructive work in a single transaction: auto-saves any
 * uncommitted workspace changes into a fresh "Pre-rollback auto-save"
 * checkpoint, then `git checkout -f` to the target SHA, then writes a
 * marker checkpoint. We don't try to mirror any of that state here —
 * the file tree component is the right place to react to the event
 * and refetch.
 *
 * `includeDatabase` only takes effect if the target checkpoint was
 * itself created with `includesDb: true`; otherwise the server
 * silently ignores the flag.
 */
export async function rollbackProjectToCheckpoint(
  collection: IChatMessageCollection,
  args: {
    projectId: string
    checkpointId: string
    checkpointCreatedAt: string
    includeDatabase?: boolean
  },
): Promise<RollbackResult> {
  const env = getEnv<ISDKEnvironment>(collection)
  const response = await env.http.post<{ ok: boolean }>(
    `/api/projects/${args.projectId}/checkpoints/${args.checkpointId}/rollback`,
    { includeDatabase: args.includeDatabase ?? false },
  )
  if (!response.data?.ok) {
    throw new Error('Rollback failed')
  }

  // Best-effort notify-the-world. `window` is undefined on native
  // (Hermes), so we guard. Native consumers that want to react to a
  // rollback should subscribe via a future shared event-bus helper
  // — for now the file-revert UX is primarily a web/desktop story
  // and that's where the event fires.
  const win = (globalThis as { window?: Window }).window
  if (win && typeof CustomEvent !== 'undefined') {
    const detail: FilesRevertedDetail = {
      projectId: args.projectId,
      checkpointId: args.checkpointId,
      checkpointCreatedAt: args.checkpointCreatedAt,
    }
    try {
      win.dispatchEvent(
        new CustomEvent<FilesRevertedDetail>(SHOGO_FILES_REVERTED_EVENT, {
          detail,
        }),
      )
    } catch {
      // CustomEvent may be unconstructable in some test envs;
      // failing to dispatch is non-fatal — rollback already succeeded.
    }
  }

  return { projectId: args.projectId, checkpointId: args.checkpointId }
}
