// SPDX-License-Identifier: MIT
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

/**
 * Colours come from the theme tokens, never from inline style: an inline
 * `backgroundColor` would win over the class and pin the toggle to one colour
 * for every accent and mode.
 */
export function Switch({ checked, onCheckedChange, disabled, className }: SwitchProps) {
  return (
    <Pressable
      className={cn(
        'rounded-full px-0.5',
        checked ? 'bg-primary' : 'bg-input',
        disabled && 'opacity-50',
        className,
      )}
      disabled={disabled}
      onPress={() => onCheckedChange(!checked)}
      role="switch"
      aria-checked={checked}
      style={{
        width: 44,
        height: 24,
        borderRadius: 12,
        justifyContent: 'center',
      }}
    >
      <View
        className={cn('rounded-full', checked ? 'bg-primary-foreground' : 'bg-background')}
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
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
