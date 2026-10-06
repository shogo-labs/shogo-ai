// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Which waiting agents deserve an OS notification, and what it says. Pure, so
// it can be tested without Electron. `island-pending-notification.ts` shows
// them and `IslandWindow` routes the buttons through the same action path the
// island itself uses.

import { islandSessionKey, type IslandSnapshot } from './island-protocol'

export interface PendingNotice {
  requestId: string
  kind: 'permission' | 'question'
  projectId: string
  sessionId: string
  title: string
  body: string
}

export interface PendingNotificationPlan {
  /** Requests to announce now. */
  notify: PendingNotice[]
  /** Announced earlier and no longer pending: take their notifications down. */
  resolved: string[]
  /** What `announced` should be after this plan. */
  announced: Set<string>
}

const BODY_MAX = 180

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > BODY_MAX ? `${flat.slice(0, BODY_MAX - 1)}…` : flat
}

/** The one param worth showing: the command, or the file about to change. */
function paramSummary(params: Record<string, unknown>): string {
  for (const key of ['command', 'cmd', 'path', 'file_path', 'filePath', 'url']) {
    const value = params[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

/**
 * Plans notifications for a merged snapshot.
 *
 * - A request in the chat the user is looking at is marked announced without a
 *   notification: they can already see it.
 * - Each request is announced once.
 * - `islandPresent` means the island is on screen and pops open for it, so a
 *   banner would be a second prompt for the same thing.
 */
export function planPendingNotifications(
  snapshot: IslandSnapshot,
  announced: ReadonlySet<string>,
  opts: { islandPresent: boolean },
): PendingNotificationPlan {
  const live = new Set<string>()
  const next = new Set<string>()
  const notify: PendingNotice[] = []

  for (const session of snapshot.sessions) {
    const pending = session.pending
    if (!pending) continue
    const requestId = pending.request.id
    live.add(requestId)
    if (announced.has(requestId)) {
      next.add(requestId)
      continue
    }
    const inFocusedChat = islandSessionKey(session.projectId, session.sessionId) === snapshot.focusedSessionKey
    next.add(requestId)
    // Already in front of the user, or the island is showing it: no banner.
    if (inFocusedChat || opts.islandPresent) continue

    if (pending.kind === 'permission') {
      const { toolName, reason, params } = pending.request
      const detail = paramSummary(params) || reason
      notify.push({
        requestId,
        kind: 'permission',
        projectId: session.projectId,
        sessionId: session.sessionId,
        title: `${session.projectName || 'Agent'} needs permission`,
        body: clip(detail ? `${toolName}: ${detail}` : toolName),
      })
    } else {
      notify.push({
        requestId,
        kind: 'question',
        projectId: session.projectId,
        sessionId: session.sessionId,
        title: `${session.projectName || 'Agent'} has a question`,
        body: clip(pending.request.prompt),
      })
    }
  }

  const resolved = [...announced].filter((id) => !live.has(id))
  return { notify, resolved, announced: next }
}

/** Buttons on a notice. Only a permission can be answered from the banner. */
export function noticeActions(notice: PendingNotice): Array<{ type: 'button'; text: string }> {
  return notice.kind === 'permission' ? [{ type: 'button', text: 'Allow' }, { type: 'button', text: 'Deny' }] : []
}

/** The island action a button press stands for; null opens the chat instead. */
export function noticeActionFor(notice: PendingNotice, index: number) {
  if (notice.kind !== 'permission') return null
  if (index === 0) return { type: 'permission' as const, requestId: notice.requestId, decision: 'allow_once' as const }
  if (index === 1) return { type: 'permission' as const, requestId: notice.requestId, decision: 'deny' as const }
  return null
}
