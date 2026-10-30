// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace avatar at the top left of Home. Tapping it opens the workspace
 * switcher sheet, not the full sidebar: Home already lists projects, channels
 * and agents, and preferences and account live behind the profile avatar on the
 * right, so pushing a second copy of the same lists over the screen added
 * nothing.
 */
import { useState } from 'react'
import { Text } from 'react-native'
import { PressableScale } from '@shogo/shared-ui/primitives'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { haptics } from '../../lib/haptics'
import { MobileWorkspaceSwitcherSheet } from './MobileWorkspaceSwitcher'

export function WorkspaceSidebarAvatar({ workspaceName }: { workspaceName?: string }) {
  const workspace = useActiveWorkspace()
  const [open, setOpen] = useState(false)
  const name = workspaceName ?? workspace?.name ?? 'Workspace'
  const initial = name.trim().charAt(0).toUpperCase() || 'S'
  return (
    <>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${name}, switch workspace`}
        testID="home-sidebar-avatar"
        feedback={haptics.selection}
        onPress={() => setOpen(true)}
        className="h-9 w-9 items-center justify-center rounded-full bg-primary/15"
      >
        <Text className="text-sm font-semibold text-primary">{initial}</Text>
      </PressableScale>
      <MobileWorkspaceSwitcherSheet visible={open} onClose={() => setOpen(false)} onSwitched={() => setOpen(false)} />
    </>
  )
}
