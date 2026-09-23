// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ComponentType, ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

export interface SelectableCardProps {
  title: string
  description?: string
  icon?: ComponentType<{ size?: number; className?: string }>
  /** Rendered in place of `icon` (e.g. a remote listing icon). */
  leading?: ReactNode
  badge?: string
  selected: boolean
  onPress: () => void
  /** `radio` for single-select groups, `checkbox` for toggles. */
  role?: 'radio' | 'checkbox'
  className?: string
  testID?: string
}

export function SelectableCard({
  title,
  description,
  icon: Icon,
  leading,
  badge,
  selected,
  onPress,
  role = 'radio',
  className,
  testID,
}: SelectableCardProps) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole={role}
      accessibilityState={{ checked: selected }}
      accessibilityLabel={title}
      className={cn(
        'flex-1 flex-row items-start gap-4 rounded-2xl border p-5 active:opacity-90',
        selected
          ? 'border-primary bg-primary/5'
          : 'border-border bg-card web:hover:border-foreground/30',
        className,
      )}
    >
      {leading ?? (Icon ? (
        <View className="h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Icon size={20} className="text-primary" />
        </View>
      ) : null)}
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
            {title}
          </Text>
          {badge ? (
            <View className="rounded-full bg-muted px-2 py-0.5">
              <Text className="text-[11px] font-medium text-muted-foreground">{badge}</Text>
            </View>
          ) : null}
        </View>
        {description ? (
          <Text className="mt-1 text-sm leading-5 text-muted-foreground">{description}</Text>
        ) : null}
      </View>
      <View
        className={cn(
          'h-5 w-5 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-primary bg-primary' : 'border-border',
        )}
      >
        {selected ? <Check size={12} strokeWidth={3} className="text-primary-foreground" /> : null}
      </View>
    </Pressable>
  )
}
