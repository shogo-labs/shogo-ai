// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tells an agent that its workspace's work is not reaching durable storage.
 *
 * The host owns the durable repo, so the guest cannot see the host's view of
 * durability — but it does see every export the host asks for, and that is the
 * save. When those start failing, the agent is the one still writing files, and
 * it should know that a cold boot would restore an older copy (SHO-442).
 *
 * One line, only while a save is actually failing: a healthy workspace gets no
 * block at all, and the block goes after the cache boundary because it changes
 * per turn.
 */

export interface RepoExportFailure {
  /** When the failing export was answered (ms epoch). */
  at: number
  /** `auth` | `timeout` | `missing-objects` | `network` | `presign` | `other`. */
  reason: string
  /** The guest's own message, already trimmed for a prompt. */
  detail?: string
}

let lastFailure: RepoExportFailure | null = null
let lastSuccessAt: number | null = null

/** Record a failed repo export (the host's save). */
export function noteRepoExportFailed(reason: string, detail?: string, at = Date.now()): void {
  lastFailure = { at, reason, ...(detail ? { detail: detail.slice(0, 200) } : {}) }
}

/** Record a repo export that reached the host. Clears the failure. */
export function noteRepoExportSucceeded(at = Date.now()): void {
  lastFailure = null
  lastSuccessAt = at
}

/** Test hook. */
export function _resetRepoDurabilityForTests(): void {
  lastFailure = null
  lastSuccessAt = null
}

export function repoDurabilityState(): { failing: RepoExportFailure | null; lastSuccessAt: number | null } {
  return { failing: lastFailure, lastSuccessAt }
}

function ago(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 1) return 'less than a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function buildRepoDurabilitySection(now = Date.now()): string | null {
  if (!lastFailure) return null
  const since = ago(now - lastFailure.at)
  return [
    '## Your Changes Are Not Backed Up',
    '',
    `The last save of this workspace's git history failed ${since} ago (${lastFailure.reason}${lastFailure.detail ? `: ${lastFailure.detail}` : ''}). The files are on disk here, but a cold boot restores the last copy that reached durable storage, so anything since then would be lost.`,
    '',
    'Keep working — do not stop or restart the workspace, and do not try to "fix" it by resetting the repo. If the user asks, say their latest changes are not backed up yet and that the platform is retrying.',
  ].join('\n')
}
