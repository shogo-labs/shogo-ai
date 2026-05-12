// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text, Pressable, Platform } from 'react-native'
import { ChevronRight } from 'lucide-react-native'

interface SectionHeaderProps {
  title: string
  subtitle?: string
  /** When provided, a "See all →" affordance shows on the right. */
  onSeeAll?: () => void
  seeAllLabel?: string
  /** Apply horizontal padding (defaults to true). */
  padded?: boolean
  /** Display heading uses Skema Pro Display on web; ignored on native. */
  display?: boolean
}

/**
 * Editorial section header used between rails on browse, category
 * landing pages, and creator profiles. Notion-style: generous margin
 * below, large display title, muted single-line subtitle, optional
 * `See all →` affordance on the right.
 */
export function SectionHeader({
  title,
  subtitle,
  onSeeAll,
  seeAllLabel = 'See all',
  padded = true,
  display = true,
}: SectionHeaderProps) {
  const titleStyle: any = display && Platform.OS === 'web'
    ? { fontFamily: 'Skema Pro Display, ui-serif, Georgia, serif', letterSpacing: -0.4 }
    : undefined

  return (
    <View className={`flex-row items-end justify-between mb-4 ${padded ? 'px-5' : ''}`}>
      <View className="flex-1 min-w-0 mr-4">
        <Text
          className="text-xl font-bold text-foreground"
          style={titleStyle}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle && (
          <Text
            className="text-sm text-muted-foreground mt-0.5"
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        )}
      </View>
      {onSeeAll && (
        <Pressable
          onPress={onSeeAll}
          hitSlop={6}
          className="flex-row items-center gap-1 active:opacity-60"
        >
          <Text className="text-sm font-medium text-primary">{seeAllLabel}</Text>
          <ChevronRight size={14} color="#e27927" />
        </Pressable>
      )}
    </View>
  )
}
