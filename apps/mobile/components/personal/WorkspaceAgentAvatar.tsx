// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View } from "react-native"
import { useBuddyLook } from "../../contexts/buddy-look"
import { ShogoBuddy } from "../island/buddy/ShogoBuddy"
import type { BuddyState } from "../island/buddy/engine"
import { useIslandAccent } from "../island/island-accent"

interface WorkspaceAgentAvatarProps {
  size?: number
  state?: BuddyState
}

/**
 * A fixed square slot for the workspace companion. ShogoBuddy's canvas is
 * taller than it is wide to leave room for toppers and particles; keeping the
 * slot square lets those details overflow upward without moving the header.
 */
export function WorkspaceAgentAvatar({ size = 48, state = "idle" }: WorkspaceAgentAvatarProps) {
  const { look } = useBuddyLook()
  const color = useIslandAccent()

  return (
    <View
      accessible
      accessibilityLabel="Shogo workspace avatar"
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "flex-end",
        overflow: "visible",
      }}
    >
      <ShogoBuddy
        size={size}
        state={state}
        color={color}
        look={look}
        interactive
        followPointer
        accessibilityLabel="Shogo workspace avatar"
      />
    </View>
  )
}
