// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shown at the top of an agent's DM while that agent is busy somewhere else,
 * so an empty thread still leads to the channel or session it is working in.
 */
import { useMemo } from 'react'
import { Pressable, Text } from 'react-native'
import { useRouter } from 'expo-router'
import { useAgentActivity } from '../../hooks/useAgentActivity'
import { agentWorkingOn } from '../../lib/agent-directory'
import { openAgentWork } from '../../lib/open-active-chat'

export function AgentWorkingBanner({
  projectId,
  agentName,
  conversationId,
  polling,
}: {
  projectId: string
  agentName: string
  conversationId: string
  polling: boolean
}) {
  const router = useRouter()
  const activity = useAgentActivity({ light: true, polling })
  const work = useMemo(
    () => agentWorkingOn(activity.tasks, activity.activeChats).get(projectId) ?? null,
    [activity.tasks, activity.activeChats, projectId],
  )
  if (!work) return null
  if (work.target.kind === 'conversation' && work.target.conversationId === conversationId) return null

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`View what ${agentName} is working on`}
      onPress={() => openAgentWork(router, work.target)}
      className="mx-3 mt-2 flex-row items-center gap-2 rounded-xl border border-primary/30 bg-primary/10 px-3 py-2 active:bg-primary/15"
      testID="agent-working-banner"
    >
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {agentName} is working {work.relation} {work.place}
      </Text>
      <Text className="text-sm font-medium text-primary">View</Text>
    </Pressable>
  )
}
