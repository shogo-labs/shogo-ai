// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Composer-toolbar pill for a status dock panel. Tapping toggles the
 * panel's expansion, revealing it first if it was hidden (e.g. the
 * `autoShow: false` context-usage panel). The chip body is supplied as
 * `children` — e.g. the `ContextTracker` ring.
 */

import { Pressable } from "react-native"
import { useChatDockStore } from "../../../lib/chat-dock-store"

export interface DockChipProps {
  panelId: string
  isNative?: boolean
  accessibilityLabel: string
  children: React.ReactNode
}

export function DockChip({ panelId, isNative, accessibilityLabel, children }: DockChipProps) {
  const store = useChatDockStore()

  return (
    <Pressable
      onPress={() => store.toggle(panelId)}
      hitSlop={isNative ? 6 : 4}
      role="button"
      accessibilityLabel={accessibilityLabel}
      className="flex-row items-center justify-center"
    >
      {children}
    </Pressable>
  )
}
