// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Image, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Activity, ChevronRight, Sparkles } from 'lucide-react-native'
import type { PersonalAgentProfile } from '../../lib/api'

interface PersonalAgentHeaderProps {
  profile: PersonalAgentProfile
  onAvatarPress: () => void
  onActivityPress: () => void
}

export function PersonalAgentHeader({
  profile,
  onAvatarPress,
  onActivityPress,
}: PersonalAgentHeaderProps) {
  const initial = profile.name.trim().charAt(0).toUpperCase() || 'S'
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const needsOverlayClearance = Platform.OS !== 'web' || width < 768

  return (
    <View
      className="w-full border-b border-border/60 bg-background/95 px-4 pb-3 pt-3"
      style={needsOverlayClearance ? { paddingTop: insets.top + 58 } : undefined}
    >
      <View className="mx-auto w-full max-w-2xl flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Change ${profile.name}'s avatar`}
          onPress={onAvatarPress}
          className="h-12 w-12 overflow-hidden rounded-full border border-border bg-muted active:opacity-80"
        >
          {profile.avatarUrl ? (
            <Image source={{ uri: profile.avatarUrl }} className="h-full w-full" />
          ) : (
            <View className="h-full w-full items-center justify-center bg-primary/10">
              <Text className="text-lg font-semibold text-primary">{initial}</Text>
            </View>
          )}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="View companion activity"
          onPress={onActivityPress}
          className="min-w-0 flex-1 active:opacity-70"
        >
          <View className="flex-row items-center gap-1.5">
            <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
              {profile.name}
            </Text>
            <Activity size={14} className="text-muted-foreground" />
          </View>
          <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={2}>
            {profile.statusText || profile.tagline || 'Ready when you are'}
          </Text>
        </Pressable>
        <ChevronRight size={17} className="text-muted-foreground" />
      </View>
      <View className="mx-auto mt-2 w-full max-w-2xl flex-row items-center gap-1.5">
        <Sparkles size={13} className="text-primary" />
        <Text className="text-[11px] text-muted-foreground">
          Tap the avatar to change how I look
        </Text>
      </View>
    </View>
  )
}
