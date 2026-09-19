// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useSyncExternalStore } from 'react'

/**
 * The last project the user was inside, so `MobileBottomNav`'s Chat tab can
 * return to it from Tasks/Activity/Canvases instead of always bouncing to
 * Home. Previously a bare module-level `let lastProjectContext = ...`
 * mutated directly from an effect and read straight out of the module in
 * `MobileBottomNav`'s render body — it happened to work because pathname
 * changes always triggered a re-render around the same time, but nothing
 * guaranteed that ordering. `useSyncExternalStore` makes the dependency
 * explicit and the component re-render on every actual change, not just
 * ones that happen to coincide with a route change.
 */
export interface LastProjectContext {
  projectId: string
  chatSessionId?: string
}

let state: LastProjectContext | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): LastProjectContext | null {
  return state
}

/** Update the store; notifies every subscribed `useLastProjectContext()` caller. */
export function setLastProjectContext(next: LastProjectContext | null): void {
  state = next
  for (const listener of listeners) listener()
}

/** Read the last project context, re-rendering the caller whenever it changes. */
export function useLastProjectContext(): LastProjectContext | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
