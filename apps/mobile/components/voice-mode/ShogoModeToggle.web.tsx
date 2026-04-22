// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ShogoModeToggle (web) — small inline trigger that flips the chat
 * column into Shogo Mode.
 *
 * Intentionally minimal so it can be dropped next to existing chat
 * chrome (e.g. the chat tab bar). Pulls `toggleShogoMode` + the current
 * `shogoModeActive` from the `ChatBridge` so the same button works for
 * both enter + exit.
 */

import { Pressable, View } from 'react-native'
import { Text } from '@/components/ui/text'
import { Sparkles } from 'lucide-react-native'
import { useChatBridge } from './ChatBridgeContext'

export interface ShogoModeToggleProps {
  /** Extra classes merged onto the outer wrapper (for positioning). */
  className?: string
}

export function ShogoModeToggle({ className }: ShogoModeToggleProps) {
  const { shogoModeActive, toggleShogoMode } = useChatBridge()

  const pillClass = shogoModeActive
    ? 'bg-primary'
    : 'bg-muted hover:bg-muted/80 border border-border'
  const textClass = shogoModeActive
    ? 'text-primary-foreground'
    : 'text-foreground'

  return (
    <View className={className} pointerEvents="box-none">
      <Pressable
        onPress={toggleShogoMode}
        className={`flex-row items-center gap-1.5 rounded-full px-3 py-1.5 ${pillClass}`}
        accessibilityLabel={
          shogoModeActive ? 'Exit Shogo Mode' : 'Enter Shogo Mode'
        }
      >
        <Sparkles size={12} className={textClass} />
        <Text className={`text-[11px] font-semibold ${textClass}`}>
          {shogoModeActive ? 'Shogo Mode · On' : 'Shogo Mode'}
        </Text>
      </Pressable>
    </View>
  )
}
