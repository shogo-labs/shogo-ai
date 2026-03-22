// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SurfaceTabBar — horizontal scrollable tab bar for switching between
 * canvas surfaces. Renders as pill-style buttons showing each surface's
 * title. Appears only when multiple surfaces exist.
 */

import { useRef, useEffect } from 'react'
import { View, Pressable, ScrollView } from 'react-native'
import { Text } from '@/components/ui/text'
import { cn } from '@shogo/shared-ui/primitives'
import type { SurfaceState } from '@shogo/shared-app/dynamic-app'

interface SurfaceTabBarProps {
  surfaces: Map<string, SurfaceState>
  activeSurfaceId: string | null
  onSurfaceChange: (surfaceId: string) => void
}

export function SurfaceTabBar({ surfaces, activeSurfaceId, onSurfaceChange }: SurfaceTabBarProps) {
  const scrollRef = useRef<ScrollView>(null)

  const surfaceList = Array.from(surfaces.values()).sort(
    (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''),
  )

  if (surfaceList.length <= 1) return null

  return (
    <View className="border-b border-border bg-background/95">
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 6 }}
      >
        {surfaceList.map((s) => {
          const isActive = s.surfaceId === activeSurfaceId
          return (
            <Pressable
              key={s.surfaceId}
              onPress={() => onSurfaceChange(s.surfaceId)}
              className={cn(
                'rounded-full px-4 py-1.5 border',
                isActive
                  ? 'bg-primary border-primary'
                  : 'bg-muted/50 border-border active:bg-muted',
              )}
            >
              <Text
                className={cn(
                  'text-sm font-medium',
                  isActive ? 'text-primary-foreground' : 'text-muted-foreground',
                )}
                numberOfLines={1}
              >
                {s.title || s.surfaceId}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  )
}
