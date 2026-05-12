// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text, Image, Pressable } from 'react-native'
import { ShieldCheck } from 'lucide-react-native'
import { useRouter } from 'expo-router'

export type CreatorTier = 'newcomer' | 'builder' | 'craftsman' | 'expert' | 'master'

export const TIER_COLORS: Record<CreatorTier, string> = {
  newcomer: '#9ca3af',
  builder: '#3b82f6',
  craftsman: '#22c55e',
  expert: '#a855f7',
  master: '#eab308',
}

export const TIER_BG: Record<CreatorTier, string> = {
  newcomer: 'bg-gray-400',
  builder: 'bg-blue-500',
  craftsman: 'bg-green-500',
  expert: 'bg-purple-500',
  master: 'bg-yellow-500',
}

const TIER_LABEL: Record<CreatorTier, string> = {
  newcomer: 'Newcomer',
  builder: 'Builder',
  craftsman: 'Craftsman',
  expert: 'Expert',
  master: 'Master',
}

interface CreatorChipProps {
  /** Optional creator id — when present the chip becomes pressable and navigates to the profile. */
  creatorId?: string | null
  displayName: string
  tier: CreatorTier
  avatarUrl?: string | null
  verified?: boolean
  /**
   * Visual size:
   *   xs — inside a card or grid tile
   *   sm — inside the detail-page hero subtitle
   *   lg — at the top of the creator profile page
   */
  size?: 'xs' | 'sm' | 'lg'
  /** Optional override — when the parent already navigates, pass `false`. */
  disablePress?: boolean
  /** Layout helpers */
  className?: string
}

const SIZES = {
  xs: { avatar: 16, text: 'text-xs', shield: 11, gap: 'gap-1.5' },
  sm: { avatar: 22, text: 'text-sm', shield: 12, gap: 'gap-2' },
  lg: { avatar: 32, text: 'text-base', shield: 14, gap: 'gap-2.5' },
} as const

/**
 * Creator pill — replaces the old `CreatorBadge` component. The chip
 * carries a creator id so it can navigate to the public profile page
 * and shows a verified shield when appropriate. The tier is rendered as
 * a small colored dot; tap target opens the profile when an id is
 * available.
 */
export function CreatorChip({
  creatorId,
  displayName,
  tier,
  avatarUrl,
  verified,
  size = 'xs',
  disablePress,
  className,
}: CreatorChipProps) {
  const router = useRouter()
  const dims = SIZES[size]

  const content = (
    <View className={`flex-row items-center ${dims.gap} ${className ?? ''}`}>
      {avatarUrl ? (
        <Image
          source={{ uri: avatarUrl }}
          style={{ width: dims.avatar, height: dims.avatar, borderRadius: 999 }}
        />
      ) : (
        <View
          className={`${TIER_BG[tier] ?? TIER_BG.newcomer} rounded-full items-center justify-center`}
          style={{ width: dims.avatar, height: dims.avatar }}
        >
          <Text
            className="font-semibold text-white"
            style={{ fontSize: Math.max(8, Math.round(dims.avatar * 0.45)) }}
          >
            {displayName?.charAt(0).toUpperCase() || '?'}
          </Text>
        </View>
      )}
      <View className="flex-row items-center gap-1 min-w-0">
        <Text
          className={`text-foreground font-medium ${dims.text}`}
          numberOfLines={1}
        >
          {displayName}
        </Text>
        {verified && (
          <ShieldCheck size={dims.shield} color="#3b82f6" />
        )}
      </View>
      {size !== 'xs' && (
        <Text className="text-xs text-muted-foreground ml-0.5">· {TIER_LABEL[tier] ?? 'Newcomer'}</Text>
      )}
    </View>
  )

  if (!creatorId || disablePress) return content

  return (
    <Pressable
      onPress={() => router.push(`/(app)/marketplace/creators/${creatorId}` as any)}
      hitSlop={4}
      className="active:opacity-70"
    >
      {content}
    </Pressable>
  )
}

export { TIER_LABEL }
