// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import React from 'react'
import { Pressable, View } from 'react-native'
import { cn } from './cn'

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

export function Switch({ checked, onCheckedChange, disabled, className }: SwitchProps) {
  return (
    <Pressable
      className={cn(
        'rounded-full',
        disabled && 'opacity-50',
        className,
      )}
      disabled={disabled}
      onPress={() => onCheckedChange(!checked)}
      accessibilityRole="switch"
      accessibilityState={{ checked }}
      style={{
        width: 44,
        height: 24,
        borderRadius: 12,
        backgroundColor: checked ? '#3b82f6' : '#d1d5db',
        justifyContent: 'center',
        paddingHorizontal: 2,
      }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: '#ffffff',
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.2,
          shadowRadius: 2,
          elevation: 2,
          transform: [{ translateX: checked ? 20 : 0 }],
        }}
      />
    </Pressable>
  )
}
