// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

type Listener = () => void
const listeners = new Set<Listener>()

/** Refresh signal shared by Tasks, Activity, and the bottom-nav badge. */
export const agentTaskEvents = {
  subscribe(listener: Listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  emit() {
    listeners.forEach((listener) => listener())
  },
}
