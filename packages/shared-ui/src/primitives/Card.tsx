// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import React from 'react'
import { View, Text } from 'react-native'
import { cn } from './cn'

export interface CardProps {
  className?: string
  children: React.ReactNode
  /**
   * Forwarded to the underlying `View` so tests can use `getByTestId`.
   * react-native-web only emits `data-testid` for a `testID` that actually
   * lands on a host component, so a `testID` swallowed here is invisible to
   * Playwright and to `tsc` (which rejects it at the call site).
   */
  testID?: string
}

export function Card({ className, children, testID }: CardProps) {
  return (
    <View
      className={cn('rounded-lg border border-border bg-card shadow-sm', className)}
      testID={testID}
    >
      {children}
    </View>
  )
}

export function CardHeader({ className, children }: CardProps) {
  return <View className={cn('flex flex-col gap-1.5 p-6', className)}>{children}</View>
}

export function CardTitle({ className, children }: CardProps) {
  return (
    <Text className={cn('text-2xl font-semibold text-card-foreground', className)}>
      {typeof children === 'string' ? children : ''}
    </Text>
  )
}

export function CardDescription({ className, children }: CardProps) {
  return (
    <Text className={cn('text-sm text-muted-foreground', className)}>
      {typeof children === 'string' ? children : ''}
    </Text>
  )
}

export function CardContent({ className, children }: CardProps) {
  return <View className={cn('p-6 pt-0', className)}>{children}</View>
}

export function CardFooter({ className, children }: CardProps) {
  return <View className={cn('flex-row items-center p-6 pt-0', className)}>{children}</View>
}
