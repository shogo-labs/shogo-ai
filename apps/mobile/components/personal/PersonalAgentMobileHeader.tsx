// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Muse-style floating identity cluster for the phone companion chat:
 * avatar, bold name, and a tappable status line, centered at the top of
 * the screen. Unlike `PersonalAgentHeader`, this is an absolute overlay —
 * it has no background bar, border, or divider, and does not reserve its
 * own row in the layout. `MobileWorkspaceShell` still owns the floating
 * menu (left) and notification bell (right); this cluster sits between
 * them and must not overlap either.
 */
import { useState } from 'react'
import { Image, Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { PersonalAgentProfile } from '../../lib/api'
import { ProfileActionMenu, type ProfileActionSheetAction } from './ProfileActionMenu'

interface PersonalAgentMobileHeaderProps {
  profile: PersonalAgentProfile
  /** Change avatar / rename / personality / memory / activity / side-chats. */
  actions: ProfileActionSheetAction[]
  /** Tapping the status line opens Activity, mirroring Muse's status -> activity affordance. */
  onStatusPress: () => void
}

export function PersonalAgentMobileHeader({
  profile,
  actions,
  onStatusPress,
}: PersonalAgentMobileHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const insets = useSafeAreaInsets()
  const initial = profile.name.trim().charAt(0).toUpperCase() || 'S'

  return (
    <View
      pointerEvents="box-none"
      className="absolute left-0 right-0 z-10 items-center px-16"
      style={{ top: insets.top + 6 }}
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
            className="h-12 w-12 overflow-hidden rounded-full border border-border bg-muted active:opacity-80"
            style={{
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.15,
              shadowRadius: 6,
              elevation: 4,
            }}
          >
            {profile.avatarUrl ? (
              <Image source={{ uri: profile.avatarUrl }} className="h-full w-full" />
            ) : (
              <View className="h-full w-full items-center justify-center bg-primary/10">
                <Text className="text-lg font-semibold text-primary">{initial}</Text>
              </View>
            )}
          </Pressable>
        )}
      />
      <Text
        className="mt-1.5 text-sm font-bold text-foreground"
        numberOfLines={1}
      >
        {profile.name}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`View ${profile.name}'s activity`}
        onPress={onStatusPress}
        className="mt-0.5 active:opacity-70"
      >
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {profile.statusText || profile.tagline || 'Ready when you are'}
        </Text>
      </Pressable>
    </View>
  )
}
