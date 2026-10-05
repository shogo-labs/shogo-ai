// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An agent's avatar in team chat: its Shogo buddy, so each agent looks like
 * itself. Agents nobody has customised get a look generated from their id.
 * The workspace agent's uploaded picture, if it has one, wins over its buddy.
 */
import { Image } from 'react-native'
import { absoluteApiUrl } from '../../lib/team-chat-api'
import { useAgentLook } from '../../hooks/useTeamChat'
import { BuddyAvatar } from './BuddyAvatar'

export interface AgentAvatarProps {
  name: string
  /** The agent's project; null for the workspace agent. */
  projectId: string | null
  workspaceId?: string | null
  /** Only the workspace agent's uploaded picture is shown; project agents show their buddy. */
  iconUrl?: string | null
  size?: number
}

export function AgentAvatar({ name, projectId, workspaceId, iconUrl, size = 32 }: AgentAvatarProps) {
  const look = useAgentLook(workspaceId, projectId)
  if (projectId === null && iconUrl) {
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
