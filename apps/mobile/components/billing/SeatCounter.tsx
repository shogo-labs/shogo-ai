// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { View, Text, Pressable } from 'react-native'
import { Minus, Plus } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

/**
 * Compact seat selector used on the Pro and Business plan cards.
 *
 * Replaces the legacy `TierSelector` (10-tier dropdown). Pricing is per-seat
 * and the included usage scales linearly: $20/seat for Pro, $40/seat for
 * Business.
 */
export function SeatCounter({
  value,
  onChange,
  min = 1,
  max = 1000,
  label = 'Seats',
}: {
  value: number
  onChange: (next: number) => void
  min?: number
  max?: number
  label?: string
}) {
  const dec = () => onChange(Math.max(min, value - 1))
  const inc = () => onChange(Math.min(max, value + 1))

  return (
    <View className="flex-row items-center justify-between border border-border rounded-md bg-background px-3 py-2">
      <Text className="text-sm text-foreground">{label}</Text>
      <View className="flex-row items-center gap-3">
        <Pressable
          onPress={dec}
          disabled={value <= min}
          className={cn(
            'h-8 w-8 items-center justify-center rounded-md border border-border',
            value <= min ? 'opacity-40' : 'active:bg-muted'
          )}
          accessibilityLabel="Decrease seats"
        >
          <Minus size={14} className="text-foreground" />
        </Pressable>
        <Text className="min-w-[2ch] text-center text-base font-semibold text-foreground">
          {value}
        </Text>
        <Pressable
          onPress={inc}
          disabled={value >= max}
          className={cn(
            'h-8 w-8 items-center justify-center rounded-md border border-border',
            value >= max ? 'opacity-40' : 'active:bg-muted'
          )}
          accessibilityLabel="Increase seats"
        >
          <Plus size={14} className="text-foreground" />
        </Pressable>
      </View>
    </View>
  )
}
