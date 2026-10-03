// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * App icon badge for unread team chat (native). The web/desktop variant
 * lives in `team-chat-badge.ts`.
 */
import * as Notifications from 'expo-notifications'

let last = -1

export function setChatBadgeCount(count: number): void {
  const n = Math.max(0, Math.floor(count))
  if (n === last) return
  last = n
  Notifications.setBadgeCountAsync(n).catch(() => {})
}
