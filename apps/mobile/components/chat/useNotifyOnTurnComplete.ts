// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Fire a system notification when a chat turn finishes streaming AND the user
 * is not currently active in the app. Platform-agnostic — dispatches through
 * the platform-split `chat-notifier` module (web / electron / native).
 *
 * The "stream ended" edge is detected exactly like the post-stream settle
 * effect in ChatPanel: `wasStreamingRef.current && !isStreaming`. This keeps
 * the semantics consistent with `decideMessagesPropagation`'s `streamEnded`
 * (see messages-propagation.ts).
 */

import { useEffect, useRef } from 'react'

import {
  ensureNotificationPermission,
  isUserInactive,
  notifyChatFinished,
} from '../../lib/notifications/chat-notifier'
import { getNotifyOnTurnComplete } from '../../lib/notifications/preferences'

export interface UseNotifyOnTurnCompleteArgs {
  isStreaming: boolean
  isActiveTab: boolean
  wasAborted: boolean
  sessionId: string | null | undefined
  projectId: string | null | undefined
  title: string
  preview: string
}

const PREVIEW_MAX = 140

/**
 * Strip markdown code and normalise whitespace, then truncate to a length
 * suitable for a single-line notification body.
 */
export function cleanPreview(text: string): string {
  if (!text) return ''
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped.length <= PREVIEW_MAX) return stripped
  return stripped.slice(0, PREVIEW_MAX - 1).trimEnd() + '…'
}

/**
 * Pure decision helper: given the stream-end edge + the call-site state,
 * should we attempt to fire a notification? Exported for testing.
 *
 * Note: the runtime "is user inactive?" and permission checks are *not*
 * part of this function — they're async and platform-specific. This
 * function captures only the synchronous gates.
 */
export interface ShouldAttemptArgs {
  prevStreaming: boolean
  nextStreaming: boolean
  isActiveTab: boolean
  wasAborted: boolean
  sessionId: string | null | undefined
  projectId: string | null | undefined
  preferenceEnabled: boolean
}

export function shouldAttemptNotification(a: ShouldAttemptArgs): boolean {
  const streamEnded = a.prevStreaming && !a.nextStreaming
  if (!streamEnded) return false
  if (a.wasAborted) return false
  if (a.isActiveTab) return false
  if (!a.sessionId || !a.projectId) return false
  if (!a.preferenceEnabled) return false
  return true
}

export function useNotifyOnTurnComplete(args: UseNotifyOnTurnCompleteArgs): void {
  const wasStreamingRef = useRef(false)
  // Latest args in a ref so the effect body never re-runs just because the
  // preview text changed mid-stream — we only care about the falling edge.
  const argsRef = useRef(args)
  argsRef.current = args

  useEffect(() => {
    const prev = wasStreamingRef.current
    wasStreamingRef.current = args.isStreaming

    const snapshot = argsRef.current
    const shouldAttempt = shouldAttemptNotification({
      prevStreaming: prev,
      nextStreaming: args.isStreaming,
      isActiveTab: snapshot.isActiveTab,
      wasAborted: snapshot.wasAborted,
      sessionId: snapshot.sessionId,
      projectId: snapshot.projectId,
      preferenceEnabled: getNotifyOnTurnComplete(),
    })
    if (!shouldAttempt) return

    void (async () => {
      try {
        if (!(await isUserInactive())) return
        if (!(await ensureNotificationPermission())) return
        await notifyChatFinished({
          sessionId: snapshot.sessionId as string,
          projectId: snapshot.projectId as string,
          title: snapshot.title,
          preview: cleanPreview(snapshot.preview),
        })
      } catch {
        // Best-effort — never crash the chat on notification failure.
      }
    })()
  }, [args.isStreaming])
}
