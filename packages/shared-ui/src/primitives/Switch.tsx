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
        'h-6 w-11 rounded-full border-2 border-transparent',
        checked ? 'bg-primary' : 'bg-input',
        disabled && 'opacity-50',
        className,
      )}
      disabled={disabled}
      onPress={() => onCheckedChange(!checked)}
      accessibilityRole="switch"
      accessibilityState={{ checked }}
    >
      <View
        className={cn(
          'h-5 w-5 rounded-full bg-background shadow',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </Pressable>
  )
}
