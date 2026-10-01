// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Muse-style floating identity cluster for the phone companion chat:
 * avatar and bold name, centered at the top of
 * the screen. Unlike `PersonalAgentHeader`, this is an absolute overlay —
 * it has no background bar, border, or divider, and does not reserve its
 * own row in the layout. `MobileWorkspaceShell` still owns the floating
 * menu (left) and notification bell (right); this cluster sits between
 * them and must not overlap either.
 */
import { useState } from "react"
import { Pressable, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { PersonalAgentProfile } from "../../lib/api"
import type { BuddyState } from "../island/buddy/engine"
import { WorkspaceAgentAvatar } from "./WorkspaceAgentAvatar"
import {
  ProfileActionMenu,
  type ProfileActionSheetAction,
} from "./ProfileActionMenu"

interface PersonalAgentMobileHeaderProps {
  profile: PersonalAgentProfile
  /** Dress up Shogo / rename / personality / memory / activity / side-chats. */
  actions: ProfileActionSheetAction[]
  avatarState?: BuddyState
}

export function PersonalAgentMobileHeader({
  profile,
  actions,
  avatarState = "idle",
}: PersonalAgentMobileHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const insets = useSafeAreaInsets()

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
            className="h-12 w-12 items-center justify-end active:opacity-80"
            style={{
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.15,
              shadowRadius: 6,
              elevation: 4,
            }}
          >
            <WorkspaceAgentAvatar size={48} state={avatarState} />
          </Pressable>
        )}
      />
      <Text
        className="mt-1.5 rounded-lg bg-background px-2 py-0.5 text-sm font-bold text-foreground"
        numberOfLines={1}
      >
        {profile.name}
      </Text>
    </View>
  )
}
