// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Registers a panel descriptor with the chat dock for the lifetime of the
 * calling component.
 *
 * Pass `null` to omit registration (e.g. "no queued messages right now") —
 * any previously registered panel with this id is removed and the dock
 * drops it from the stack.
 *
 * Registration is an upsert: calling this again with a new descriptor
 * object (same `id`) updates the stored fields (title, summary, render,
 * ...) without resetting the panel's visible/expanded state — that state
 * only gets its initial value the *first* time a given id is registered.
 * Callers don't need to memoize the descriptor for correctness, only for
 * render performance (an unmemoized descriptor just means every render
 * re-upserts the same fields).
 *
 * `storeOverride`: pass the store instance directly when the calling
 * component is the SAME component that renders
 * `<ChatDockStoreContext.Provider value={store}>` (e.g. `ChatPanel` itself,
 * for its handful of inline blocking/status descriptors — see the comment
 * above `permissionDockDescriptor` there). A component can't `useContext`
 * its own Provider: the context value a component reads is whatever its
 * *ancestors* provided, not whatever it renders further down in its own
 * returned JSX. Without this override, those calls silently fell back to
 * the module-level `getFallbackStore()` singleton instead of the real
 * per-`ChatPanel` store `<ChatDock>` actually reads from, so the panel
 * registered but never appeared above the composer. Components rendered AS
 * CHILDREN inside the Provider (every extracted `*DockPanel.tsx`) don't
 * need this — their own `useContext` call correctly sees the ancestor
 * Provider.
 */

import { useEffect, useRef } from "react"
import { useChatDockStore, type ChatDockStore, type DockPanelDescriptor } from "../../../lib/chat-dock-store"

export function useDockPanel(descriptor: DockPanelDescriptor | null, storeOverride?: ChatDockStore): void {
  const contextStore = useChatDockStore()
  const store = storeOverride ?? contextStore
  const registeredIdRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (descriptor) {
      registeredIdRef.current = descriptor.id
      store.registerPanel(descriptor)
    } else if (registeredIdRef.current) {
      store.unregisterPanel(registeredIdRef.current)
      registeredIdRef.current = undefined
    }
    // descriptor is compared by reference — see doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, descriptor])

  useEffect(() => {
    return () => {
      if (registeredIdRef.current) store.unregisterPanel(registeredIdRef.current)
    }
    // Unmount-only cleanup; intentionally excludes `descriptor`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])
}
