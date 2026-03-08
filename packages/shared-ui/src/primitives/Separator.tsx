// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import React from 'react'
import { View } from 'react-native'
import { cn } from './cn'

export interface SeparatorProps {
  orientation?: 'horizontal' | 'vertical'
  className?: string
}

export function Separator({ orientation = 'horizontal', className }: SeparatorProps) {
  return (
    <View
      className={cn(
        'bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
    />
  )
}
