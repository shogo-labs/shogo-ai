// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Why an alert did or didn't reach the screen.
 *
 * Every gate in the notifier path used to `return` silently, which made a
 * dropped alert indistinguishable from one that was never sent — there was
 * no log, counter, or status anywhere to tell them apart. Each drop now
 * records a reason and warns once per reason, and
 * `getNotificationDiagnostics()` exposes the tally for the Settings surface.
 */

export type NotificationDropReason =
  /** No `Notification` API here (older browsers, SSR, native shells). */
  | 'unsupported'
  /** Undecided permission; browsers only prompt from a user gesture. */
  | 'permission-prompt'
  /** Blocked in the browser's site settings. */
  | 'permission-denied'
  /** The constructor threw — mobile Safari forbids it outside a worker. */
  | 'show-threw'

const EXPLANATIONS: Record<NotificationDropReason, string> = {
  unsupported: 'this browser has no Notification API',
  'permission-prompt':
    "notification permission was never granted — use “Turn on” in Settings → Account",
  'permission-denied': "notifications are blocked in this browser's site settings",
  'show-threw': 'the browser refused to construct the notification',
}

export interface NotificationDiagnostics {
  shown: number
  dropped: number
  lastDrop: { reason: NotificationDropReason; message: string; at: string } | null
}

let shown = 0
let lastDrop: NotificationDiagnostics['lastDrop'] = null
const droppedByReason = new Map<NotificationDropReason, number>()
const warned = new Set<NotificationDropReason>()

export function recordNotificationShown(): void {
  shown += 1
}

export function recordNotificationDropped(
  reason: NotificationDropReason,
  detail?: string,
): void {
  droppedByReason.set(reason, (droppedByReason.get(reason) ?? 0) + 1)
  const message = detail ? `${EXPLANATIONS[reason]} (${detail})` : EXPLANATIONS[reason]
  lastDrop = { reason, message, at: new Date().toISOString() }
  // Once per reason: a busy channel would otherwise flood the console.
  if (!warned.has(reason)) {
    warned.add(reason)
    console.warn(`[notifications] Alert not shown — ${message}`)
  }
}

export function getNotificationDiagnostics(): NotificationDiagnostics {
  let dropped = 0
  for (const count of droppedByReason.values()) dropped += count
  return { shown, dropped, lastDrop }
}

/** Test seam — the tallies are process-global by design. */
export function resetNotificationDiagnostics(): void {
  shown = 0
  lastDrop = null
  droppedByReason.clear()
  warned.clear()
}
