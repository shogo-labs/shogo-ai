// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState } from 'react'
import { Platform, Pressable, Text, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Activity, ChevronDown, Sparkles } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { PersonalAgentProfile } from '../../lib/api'
import type { BuddyState } from '../island/buddy/engine'
import { isPhoneLayout } from '../../lib/native-phone-layout'
import { ChatColumn } from '../chat/ChatColumn'
import { WorkspaceAgentAvatar } from './WorkspaceAgentAvatar'
import { ProfileActionMenu, type ProfileActionSheetAction } from './ProfileActionMenu'

interface PersonalAgentHeaderProps {
  profile: PersonalAgentProfile
  /** Dress up Shogo / rename / personality / memory / activity / side-chats. */
  actions: ProfileActionSheetAction[]
  avatarState?: BuddyState
  /** A parent mobile chat shell already owns the safe-area header. */
  compact?: boolean
}

export function PersonalAgentHeader({
  profile,
  actions,
  avatarState = 'idle',
  compact = false,
}: PersonalAgentHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const insets = useSafeAreaInsets()
  const { width, height: windowHeight } = useWindowDimensions()
  const needsOverlayClearance = Platform.OS !== 'web' || width < 768
  const phone = isPhoneLayout(width, windowHeight)

  return (
    <View
      className="w-full border-b border-border/60 bg-background/95 pb-3 pt-3"
      style={needsOverlayClearance && !compact ? { paddingTop: insets.top + 58 } : undefined}
    >
      <ProfileActionMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        title={profile.name}
        subtitle={profile.tagline || undefined}
        actions={actions}
        trigger={(triggerProps) => (
          <ChatColumn presentation="agent" phone={phone}>
            <Pressable
              {...triggerProps}
              accessibilityRole="button"
              accessibilityLabel={`${profile.name} profile and settings`}
              accessibilityState={{ expanded: menuOpen }}
              className="w-full flex-row items-center gap-3 active:opacity-80"
            >
              <WorkspaceAgentAvatar size={48} state={avatarState} />
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
          </ChatColumn>
        )}
      />
      {!compact ? (
        <ChatColumn presentation="agent" phone={phone} style={{ marginTop: 8 }}>
          <View className="w-full flex-row items-center gap-1.5">
            <Sparkles size={13} className="text-primary" />
            <Text className="text-[11px] text-muted-foreground">
              Tap to dress up your Shogo, rename it, or see what it remembers
            </Text>
          </View>
        </ChatColumn>
      ) : null}
    </View>
  )
}
