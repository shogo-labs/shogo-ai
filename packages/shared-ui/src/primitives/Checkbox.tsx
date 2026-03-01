import React from 'react'
import { Pressable, View, Text } from 'react-native'
import { cn } from './cn'

export interface CheckboxProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
  label?: string
}

export function Checkbox({ checked, onCheckedChange, disabled, className, label }: CheckboxProps) {
  return (
    <Pressable
      className={cn('flex-row items-center gap-2', disabled && 'opacity-50')}
      disabled={disabled}
      onPress={() => onCheckedChange(!checked)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
    >
      <View
        className={cn(
          'h-4 w-4 items-center justify-center rounded-sm border border-primary',
          checked && 'bg-primary',
          className,
        )}
      >
        {checked && (
          <Text className="text-xs text-primary-foreground">✓</Text>
        )}
      </View>
      {label && (
        <Text className="text-sm font-medium text-foreground">{label}</Text>
      )}
    </Pressable>
  )
}
