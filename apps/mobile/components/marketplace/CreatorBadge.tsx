// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text, Image } from 'react-native'

export type CreatorTier = 'newcomer' | 'builder' | 'craftsman' | 'expert' | 'master'

interface CreatorBadgeProps {
  tier: CreatorTier
  displayName: string
  avatarUrl?: string | null
}

const TIER_COLORS: Record<CreatorTier, string> = {
  newcomer: '#9ca3af',
  builder: '#3b82f6',
  craftsman: '#22c55e',
  expert: '#a855f7',
  master: '#eab308',
}

const TIER_BG: Record<CreatorTier, string> = {
  newcomer: 'bg-gray-400',
  builder: 'bg-blue-500',
  craftsman: 'bg-green-500',
  expert: 'bg-purple-500',
  master: 'bg-yellow-500',
}

export function CreatorBadge({ tier, displayName, avatarUrl }: CreatorBadgeProps) {
  const dotClass = TIER_BG[tier] ?? TIER_BG.newcomer

  return (
    <View className="flex-row items-center gap-1.5">
      {avatarUrl ? (
        <Image
          source={{ uri: avatarUrl }}
          className="w-4 h-4 rounded-full"
        />
      ) : (
        <View className={`w-2 h-2 rounded-full ${dotClass}`} />
      )}
      <Text className="text-xs text-muted-foreground" numberOfLines={1}>
        {displayName}
      </Text>
    </View>
  )
}

export { TIER_COLORS, TIER_BG }
