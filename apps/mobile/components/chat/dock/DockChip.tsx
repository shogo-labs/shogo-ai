// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Composer-toolbar pill for a status dock panel. Tapping toggles the
 * panel's expansion, revealing it first if it was hidden (e.g. the
 * `autoShow: false` context-usage panel). Accepts custom `children` so an
 * existing widget — the `ContextTracker` ring — can be the chip body
 * instead of the default icon/count/dot layout.
 */

import { Pressable, View, Text } from "react-native"
import { useChatDockStore, type DockIconComponent } from "../../../lib/chat-dock-store"

export interface DockChipProps {
  panelId: string
  icon?: DockIconComponent
  count?: number
  dot?: boolean
  isNative?: boolean
  accessibilityLabel: string
  children?: React.ReactNode
}

export function DockChip({ panelId, icon: Icon, count, dot, isNative, accessibilityLabel, children }: DockChipProps) {
  const store = useChatDockStore()

  return (
    <Pressable
      onPress={() => store.toggle(panelId)}
      hitSlop={isNative ? 6 : 4}
      role="button"
      accessibilityLabel={accessibilityLabel}
      className="flex-row items-center justify-center"
    >
      {children ?? (
        <View className="flex-row items-center gap-0.5">
          {Icon && <Icon size={14} className="text-muted-foreground" />}
          {dot && <View className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
          {typeof count === "number" && count > 0 && (
            <Text className="text-[10px] text-muted-foreground">{count}</Text>
          )}
        </View>
      )}
    </Pressable>
  )
}
