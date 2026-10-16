// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo's face in team chat, for the messages Shogo itself posts (huddle
 * notices, card movements, agent notes). It shows the signed-in user's own
 * Shogo buddy — the companion they dressed — still, never animated. The
 * workspace agent's uploaded picture, when it has one, wins, exactly as it does
 * on Shogo's own messages.
 */
import { Image } from 'react-native'
import { absoluteApiUrl } from '../../lib/team-chat-api'
import { useMentionables } from '../../hooks/useTeamChat'
import { useBuddyLook } from '../../contexts/buddy-look'
import { BuddyAvatar } from './BuddyAvatar'

export interface ShogoAvatarProps {
  workspaceId?: string | null
  name?: string
  size?: number
}

export function ShogoAvatar({ workspaceId, name = 'Shogo', size = 32 }: ShogoAvatarProps) {
  const { look } = useBuddyLook()
  const iconUrl = (useMentionables(workspaceId)?.agents ?? []).find((agent) => agent.projectId === null)?.image ?? null
  if (iconUrl) {
    return (
      <Image
        source={{ uri: absoluteApiUrl(iconUrl) }}
        style={{ width: size, height: size, borderRadius: 8 }}
        accessibilityLabel={`${name} avatar`}
        accessibilityIgnoresInvertColors
      />
    )
  }
  return <BuddyAvatar look={look} size={size} accessibilityLabel={`${name} avatar`} />
}
