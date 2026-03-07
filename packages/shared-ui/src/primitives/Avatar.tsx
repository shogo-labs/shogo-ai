// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import React, { useState } from 'react'
import { View, Text, Image } from 'react-native'
import { cn } from './cn'

export interface AvatarProps {
  src?: string | null
  alt?: string
  fallback: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizeStyles = {
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'h-12 w-12',
} as const

const textSizeStyles = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base',
} as const

export function Avatar({ src, alt, fallback, size = 'md', className }: AvatarProps) {
  const [imgError, setImgError] = useState(false)
  const showFallback = !src || imgError

  return (
    <View className={cn(
      'overflow-hidden rounded-full',
      sizeStyles[size],
      className,
    )}>
      {showFallback ? (
        <View className="flex-1 items-center justify-center bg-muted">
          <Text className={cn('font-medium text-muted-foreground', textSizeStyles[size])}>
            {fallback}
          </Text>
        </View>
      ) : (
        <Image
          className="h-full w-full"
          source={{ uri: src! }}
          accessibilityLabel={alt || fallback}
          onError={() => setImgError(true)}
          resizeMode="cover"
        />
      )}
    </View>
  )
}
