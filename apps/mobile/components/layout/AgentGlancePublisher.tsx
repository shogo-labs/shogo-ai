// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Keeps the glanceable surfaces (widgets, Live Activity, ongoing notification)
 * current while the app is running. Renders nothing. Phones only: there is no
 * such surface on web or desktop, so it does not even poll there.
 */
import { useEffect, useMemo } from 'react'
import { Platform } from 'react-native'
import { resolveAgentLook } from '@shogo/shared-app/buddy-look'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useAgentActivity } from '../../hooks/useAgentActivity'
import { useAgentRows } from '../../hooks/useAgentRows'
import { buildGlanceSnapshot } from '../../lib/agent-glance'
import { publishGlance } from '../../lib/glance-publisher'
import '../../lib/glance-sinks'
import { buddyAvatarColor } from '../team-chat/BuddyAvatar'
import { useTeamChatNav } from '../team-chat/TeamChatSidebarProvider'

const isPhoneOS = Platform.OS === 'ios' || Platform.OS === 'android'

export function AgentGlancePublisher() {
  if (!isPhoneOS) return null
  return <Publisher />
}

function Publisher() {
  const workspace = useActiveWorkspace()
  const chat = useTeamChatNav()
  const activity = useAgentActivity({ light: true, polling: true })
  const agents = chat.mentionables?.agents
  const { rows } = useAgentRows({
    workspaceId: workspace?.id,
    agents,
    tasks: activity.tasks,
    activeChats: activity.activeChats,
    polling: true,
  })
  const colors = useMemo(() => {
    const out: Record<string, string> = {}
    for (const agent of agents ?? []) out[agent.key] = buddyAvatarColor(resolveAgentLook(agent.buddyLook, agent.projectId))
    return out
  }, [agents])

  useEffect(() => {
    void publishGlance(buildGlanceSnapshot({ rows, colors, workspaceId: workspace?.id ?? null }))
  }, [rows, colors, workspace?.id])

  return null
}
