// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace avatar at the top left of Home. It is the phone sidebar's only
 * button (Slack mobile): switching workspace, preferences and account all live
 * behind it, and no other screen grows a menu button of its own.
 */
import { Pressable, Text } from 'react-native'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { sidebarOpenEvents } from '../../lib/sidebar-open-events'

export function WorkspaceSidebarAvatar({ workspaceName }: { workspaceName?: string }) {
  const workspace = useActiveWorkspace()
  const name = workspaceName ?? workspace?.name ?? 'Workspace'
  const initial = name.trim().charAt(0).toUpperCase() || 'S'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, open workspace sidebar`}
      testID="home-sidebar-avatar"
      onPress={() => sidebarOpenEvents.requestOpenSidebar()}
      className="h-9 w-9 items-center justify-center rounded-full bg-primary/15 active:opacity-80"
    >
      <Text className="text-sm font-semibold text-primary">{initial}</Text>
    </Pressable>
  )
}
