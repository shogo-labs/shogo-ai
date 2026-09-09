// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'

export interface PhoneListRowProps {
  icon: ReactNode
  title: string
  subtitle?: string
  trailing?: ReactNode
  onPress?: () => void
  iconVariant?: 'tile' | 'bare'
  testID?: string
}

export function PhoneListRow({
  icon,
  title,
  subtitle,
  trailing,
  onPress,
  iconVariant = 'tile',
  testID,
}: PhoneListRowProps) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={!onPress}
      className={cn(
        'min-h-14 flex-row items-center gap-3 px-4 py-3',
        onPress && 'active:bg-muted/60',
      )}
    >
      <View
        className={cn(
          'items-center justify-center',
          iconVariant === 'tile' && 'h-10 w-10 rounded-xl bg-muted',
        )}
      >
        {icon}
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-base font-medium text-foreground" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text className="mt-0.5 text-sm text-muted-foreground" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
    </Pressable>
  )
}

export interface PhoneListEmptyProps {
  icon?: ReactNode
  title?: string
  message: string
  action?: ReactNode
}

export function PhoneListEmpty({ icon, title, message, action }: PhoneListEmptyProps) {
  return (
    <View className="flex-1 items-center justify-center px-6 py-12">
      {icon ? <View className="mb-3">{icon}</View> : null}
      {title ? <Text className="text-base font-semibold text-foreground">{title}</Text> : null}
      <Text className="mt-1 text-center text-sm text-muted-foreground">{message}</Text>
      {action ? <View className="mt-4">{action}</View> : null}
    </View>
  )
}
