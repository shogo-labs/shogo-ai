// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

type Listener = () => void

const listeners = new Set<Listener>()

/**
 * Lightweight pub/sub so the notification bell badge (AppHeader / AppSidebar)
 * refreshes its unread count immediately after the notifications screen marks
 * something read, without waiting for the next focus/poll.
 */
export const notificationEvents = {
  subscribe(fn: Listener) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },

  emit() {
    listeners.forEach((fn) => fn())
  },
}
