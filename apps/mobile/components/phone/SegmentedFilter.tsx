// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { nativeActivePill } from '../../lib/native-active-shadow'

export interface SegmentedFilterOption<T extends string> {
  value: T
  label: string
}

export interface SegmentedFilterProps<T extends string> {
  options: readonly SegmentedFilterOption<T>[]
  value: T
  onChange: (value: T) => void
  equalWidth?: boolean
  className?: string
  style?: StyleProp<ViewStyle>
  testID?: string
}

export function SegmentedFilter<T extends string>({
  options,
  value,
  onChange,
  equalWidth = false,
  className,
  style,
  testID,
}: SegmentedFilterProps<T>) {
  return (
    <View
      testID={testID}
      className={cn('flex-row items-center gap-0.5 rounded-lg bg-muted p-0.5', className)}
      style={style}
    >
      {options.map((option) => {
        const active = option.value === value
        const activePill = nativeActivePill(active)
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            className={cn(
              'items-center rounded-md py-1.5',
              equalWidth && 'flex-1',
              active ? activePill.className : 'active:bg-background/60',
            )}
            style={activePill.style}
          >
            <Text className={cn('text-xs font-medium', active ? 'text-foreground' : 'text-muted-foreground')}>
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
