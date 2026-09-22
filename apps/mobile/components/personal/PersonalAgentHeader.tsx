// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState } from 'react'
import { Image, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Activity, ChevronDown, Sparkles } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { PersonalAgentProfile } from '../../lib/api'
import { ProfileActionMenu, type ProfileActionSheetAction } from './ProfileActionMenu'

interface PersonalAgentHeaderProps {
  profile: PersonalAgentProfile
  /** Change avatar / rename / personality / memory / activity / side-chats. */
  actions: ProfileActionSheetAction[]
  /** A parent mobile chat shell already owns the safe-area header. */
  compact?: boolean
}

export function PersonalAgentHeader({
  profile,
  actions,
  compact = false,
}: PersonalAgentHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const initial = profile.name.trim().charAt(0).toUpperCase() || 'S'
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const needsOverlayClearance = Platform.OS !== 'web' || width < 768

  return (
    <View
      className="w-full border-b border-border/60 bg-background/95 px-4 pb-3 pt-3"
      style={needsOverlayClearance && !compact ? { paddingTop: insets.top + 58 } : undefined}
    >
      <ProfileActionMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        title={profile.name}
        subtitle={profile.tagline || undefined}
        actions={actions}
        trigger={(triggerProps) => (
          <Pressable
            {...triggerProps}
            accessibilityRole="button"
            accessibilityLabel={`${profile.name} profile and settings`}
            accessibilityState={{ expanded: menuOpen }}
            className="mx-auto w-full max-w-2xl flex-row items-center gap-3 active:opacity-80"
          >
            <View className="h-12 w-12 overflow-hidden rounded-full border border-border bg-muted">
              {profile.avatarUrl ? (
                <Image source={{ uri: profile.avatarUrl }} className="h-full w-full" />
              ) : (
                <View className="h-full w-full items-center justify-center bg-primary/10">
                  <Text className="text-lg font-semibold text-primary">{initial}</Text>
                </View>
              )}
            </View>
            <View className="min-w-0 flex-1">
              <View className="flex-row items-center gap-1.5">
                <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
                  {profile.name}
                </Text>
                <Activity size={14} className="text-muted-foreground" />
              </View>
              <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={2}>
                {profile.statusText || profile.tagline || 'Ready when you are'}
              </Text>
            </View>
            <ChevronDown
              size={17}
              className={cn('text-muted-foreground', menuOpen && 'rotate-180')}
            />
          </Pressable>
        )}
      />
      {!compact ? (
        <View className="mx-auto mt-2 w-full max-w-2xl flex-row items-center gap-1.5">
          <Sparkles size={13} className="text-primary" />
          <Text className="text-[11px] text-muted-foreground">
            Tap to change my avatar, name, personality, or see what I remember
          </Text>
        </View>
      ) : null}
    </View>
  )
}
