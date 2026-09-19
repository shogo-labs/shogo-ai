// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let openSheetCount = 0

function notify() {
  listeners.forEach((listener) => listener())
}

/** Register a visible phone sheet and return its idempotent release function. */
export function acquireNativePhoneSheetLock(): () => void {
  openSheetCount += 1
  notify()
  let released = false

  return () => {
    if (released) return
    released = true
    openSheetCount = Math.max(0, openSheetCount - 1)
    notify()
  }
}

export function useNativePhoneSheetOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => openSheetCount > 0,
    () => false,
  )
}
