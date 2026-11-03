// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What to do when the workspace agent chat is opened from a shared file link
 * (`/agent?workspace=<id>&file=<path>`, SHO-284).
 *
 * A deep link can name a workspace other than the one on screen, a workspace
 * the viewer is not a member of, or nothing at all (a cold boot before the
 * workspace list has loaded). None of those may silently open the wrong
 * workspace, so the decision is made here, from data the screen already has.
 */

export type FileLinkStep =
  /** Nothing to do: no file link, or this arrival already opened it. */
  | 'idle'
  /** The workspace on screen or the member list is not known yet. */
  | 'wait'
  /** The link's workspace is the one on screen: open the file. */
  | 'open'
  /** The link names another workspace this account is a member of: switch. */
  | 'adopt'
  /** The link names a workspace this account cannot see. */
  | 'denied'

export interface FileLinkArrivalInput {
  /** The `?file=` path, when the link carried one. */
  path: string | null
  /** The `?workspace=` id, when the link carried one. */
  linkWorkspaceId: string | null
  /** The workspace the chat is on. */
  workspaceId: string | null
  /** Every workspace id this account can see; `null` while the list loads. */
  memberWorkspaceIds: readonly string[] | null
  /** This arrival already opened (or refused) its file. */
  handled: boolean
}

export function planFileLinkArrival(input: FileLinkArrivalInput): FileLinkStep {
  const { path, linkWorkspaceId, workspaceId, memberWorkspaceIds, handled } = input
  if (!path) return 'idle'
  if (handled) return 'idle'
  if (!workspaceId) return 'wait'
  if (!linkWorkspaceId || linkWorkspaceId === workspaceId) return 'open'
  // Another workspace: only a member may be moved into it. An unloaded list is
  // unknown, not a refusal — wait for it rather than guess either way.
  if (memberWorkspaceIds === null) return 'wait'
  return memberWorkspaceIds.includes(linkWorkspaceId) ? 'adopt' : 'denied'
}
