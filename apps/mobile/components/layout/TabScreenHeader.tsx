// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The top of a phone tab screen: a large title with the profile avatar on the
 * right. Settings, status and notification pausing live behind the avatar, so
 * no tab needs a gear of its own.
 */
import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Plus } from 'lucide-react-native'
import { CreateMenu } from './CreateMenu'
import { ProfileMenu } from './ProfileMenu'

export interface TabScreenHeaderProps {
  title: string
  /** Extra controls left of the avatar. */
  actions?: ReactNode
  /** Replaces the title, e.g. a workspace switcher. */
  titleSlot?: ReactNode
}

export function TabScreenHeader({ title, actions, titleSlot }: TabScreenHeaderProps) {
  const insets = useSafeAreaInsets()
  return (
    <View className="flex-row items-center justify-between px-4 pb-2" style={{ paddingTop: insets.top + 8 }} testID="tab-screen-header">
      <View className="min-w-0 flex-1 pr-3">
        {titleSlot ?? (
          <Text className="text-[28px] font-bold leading-9 text-foreground" accessibilityRole="header" numberOfLines={1}>
            {title}
          </Text>
        )}
      </View>
      <View className="flex-row items-center gap-2">
        {actions}
        <ProfileMenu placement="bottom right" size="md" />
      </View>
    </View>
  )
}

/** The floating "+": ask an agent, start a task or project, or message someone. */
export function FloatingCreate() {
  return (
    <View style={{ position: 'absolute', right: 16, bottom: 28 }} pointerEvents="box-none">
      <CreateMenu placement="top right">
        {({ open, ...props }) => (
          <Pressable
            {...props}
            accessibilityRole="button"
            accessibilityLabel="Create"
            className="h-14 w-14 items-center justify-center rounded-full bg-primary shadow-lg active:opacity-90"
          >
            <Plus size={26} color="#fff" style={{ transform: [{ rotate: open ? '45deg' : '0deg' }] }} />
          </Pressable>
        )}
      </CreateMenu>
    </View>
  )
}

/** A phone tab screen: header, body, and the floating "+". */
export function TabScreen({ testID, children, ...header }: TabScreenHeaderProps & { testID?: string; children: ReactNode }) {
  return (
    <View className="flex-1 bg-background" testID={testID}>
      <TabScreenHeader {...header} />
      <View className="flex-1">{children}</View>
      <FloatingCreate />
    </View>
  )
}
