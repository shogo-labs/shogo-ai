// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Labels for chat alerts, so a banner says why it appeared ("Direct message",
 * "Mentioned you", "Thread reply") and not only who sent it.
 */

export type ChatAlertReason = 'dm' | 'mention' | 'broadcast' | 'thread' | 'keyword' | 'message' | 'reminder' | string

const LABELS: Record<string, string> = {
  dm: 'Direct message',
  mention: 'Mentioned you',
  broadcast: 'Mentioned you',
  thread: 'Thread reply',
}

/** The short label for a reason, or `null` when the reason has none. */
export function alertReasonLabel(reason: ChatAlertReason | null | undefined): string | null {
  if (!reason) return null
  return LABELS[reason] ?? null
}

/** Prefixes a title with its reason label: "Direct message · ada". */
export function alertTitleFor(reason: ChatAlertReason | null | undefined, title: string): string {
  const label = alertReasonLabel(reason)
  return label ? `${label} · ${title}` : title
}

/**
 * The tag that groups alerts. Replies in one thread share a tag, so with
 * `renotify` each new reply in that thread re-alerts and replaces the last
 * banner instead of stacking up.
 */
export function alertTagFor(p: { conversationId: string; threadRootId: string | null }): string {
  return p.threadRootId ? `thread:${p.threadRootId}` : `channel:${p.conversationId}`
}
