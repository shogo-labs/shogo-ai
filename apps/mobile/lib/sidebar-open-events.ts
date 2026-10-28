// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The phone sidebar's one button lives on Home (the workspace avatar), but the
 * drawer itself is owned by the (app) layout. Screens ask for it through this
 * event instead of each growing a menu button of their own.
 */
type SidebarOpenListener = () => void

const listeners = new Set<SidebarOpenListener>()

export const sidebarOpenEvents = {
  subscribeOpenSidebar(listener: SidebarOpenListener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  requestOpenSidebar() {
    listeners.forEach((listener) => listener())
  },
}
