// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

type Listener = () => void

const listeners = new Set<Listener>()

/**
 * Lightweight pub/sub so that Inbox (AppSidebar) and Settings > People >
 * Invitations stay in sync after accept / decline on either surface.
 */
export const invitationEvents = {
  subscribe(fn: Listener) {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },

  emit() {
    listeners.forEach((fn) => fn())
  },
}
