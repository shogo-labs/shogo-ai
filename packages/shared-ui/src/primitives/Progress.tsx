import React from 'react'
import { View } from 'react-native'
import { cn } from './cn'

export interface ProgressProps {
  value: number
  max?: number
  className?: string
}

export function Progress({ value, max = 100, className }: ProgressProps) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100))
  return (
    <View className={cn('relative h-4 w-full overflow-hidden rounded-full bg-secondary', className)}>
      <View
        className="h-full bg-primary"
        style={{ width: `${pct}%` }}
      />
    </View>
  )
}
