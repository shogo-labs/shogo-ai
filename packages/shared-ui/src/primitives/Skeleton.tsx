import React from 'react'
import { View } from 'react-native'
import { cn } from './cn'

export interface SkeletonProps {
  className?: string
}

export function Skeleton({ className }: SkeletonProps) {
  return <View className={cn('rounded-md bg-muted opacity-50', className)} />
}
