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
 */

import { useEffect, useRef } from "react"
import { useChatDockStore, type DockPanelDescriptor } from "../../../lib/chat-dock-store"

export function useDockPanel(descriptor: DockPanelDescriptor | null): void {
  const store = useChatDockStore()
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
