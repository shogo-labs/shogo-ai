// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import React from 'react'
import { Pressable, Text, type PressableProps } from 'react-native'
import { cn } from './cn'

const variantStyles = {
  default: 'bg-primary',
  /** Shogo landing / marketing accent — see `brand.landing` in tailwind + `--color-brand-landing` */
  brand: 'bg-brand-landing',
  destructive: 'bg-destructive',
  outline: 'border border-input bg-background',
  secondary: 'bg-secondary',
  ghost: '',
  link: '',
} as const

const variantTextStyles = {
  default: 'text-primary-foreground',
  brand: 'text-white',
  destructive: 'text-destructive-foreground',
  outline: 'text-foreground',
  secondary: 'text-secondary-foreground',
  ghost: 'text-foreground',
  link: 'text-primary underline',
} as const

const sizeStyles = {
  default: 'h-10 px-4 py-2',
  sm: 'h-9 px-3',
  lg: 'h-11 px-8',
  icon: 'h-10 w-10',
} as const

export interface ButtonProps {
  variant?: keyof typeof variantStyles
  size?: keyof typeof sizeStyles
  className?: string
  disabled?: boolean
  onPress?: () => void
  children: React.ReactNode
  /** Forwarded to the underlying Pressable so tests can use `getByTestId`. */
  testID?: string
  accessibilityLabel?: string
}

export function Button({
  variant = 'default',
  size = 'default',
  className,
  disabled,
  onPress,
  children,
  testID,
  accessibilityLabel,
}: ButtonProps) {
  return (
    <Pressable
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      className={cn(
        'flex-row items-center justify-center rounded-md',
        variantStyles[variant],
        sizeStyles[size],
        disabled && 'opacity-50',
        className,
      )}
      disabled={disabled}
      onPress={onPress}
    >
      {typeof children === 'string' ? (
        <Text className={cn('text-sm font-medium', variantTextStyles[variant])}>
          {children}
        </Text>
      ) : (
        children
      )}
    </Pressable>
  )
}
