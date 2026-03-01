import React from 'react'
import { View, Text } from 'react-native'
import { cn } from './cn'

const variantStyles = {
  default: 'bg-background border-border',
  destructive: 'border-destructive bg-destructive/10',
} as const

export interface AlertProps {
  variant?: keyof typeof variantStyles
  className?: string
  children: React.ReactNode
}

export function Alert({ variant = 'default', className, children }: AlertProps) {
  return (
    <View
      className={cn(
        'w-full rounded-lg border p-4',
        variantStyles[variant],
        className,
      )}
      accessibilityRole="alert"
    >
      {children}
    </View>
  )
}

export function AlertTitle({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <Text className={cn('mb-1 font-medium text-foreground', className)}>
      {typeof children === 'string' ? children : ''}
    </Text>
  )
}

export function AlertDescription({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <Text className={cn('text-sm text-muted-foreground', className)}>
      {typeof children === 'string' ? children : ''}
    </Text>
  )
}
