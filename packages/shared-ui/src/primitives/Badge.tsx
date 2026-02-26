import React from 'react'
import { View, Text } from 'react-native'
import { cn } from './cn'

const variantStyles = {
  default: 'bg-primary',
  secondary: 'bg-secondary',
  destructive: 'bg-destructive',
  outline: 'border border-border',
} as const

const variantTextStyles = {
  default: 'text-primary-foreground',
  secondary: 'text-secondary-foreground',
  destructive: 'text-destructive-foreground',
  outline: 'text-foreground',
} as const

export interface BadgeProps {
  variant?: keyof typeof variantStyles
  className?: string
  children: React.ReactNode
}

export function Badge({ variant = 'default', className, children }: BadgeProps) {
  return (
    <View className={cn(
      'flex-row items-center rounded-full px-2.5 py-0.5',
      variantStyles[variant],
      className,
    )}>
      {typeof children === 'string' ? (
        <Text className={cn('text-xs font-semibold', variantTextStyles[variant])}>
          {children}
        </Text>
      ) : (
        children
      )}
    </View>
  )
}
