// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace's agents as a directory: who they are, whether they are
 * working, and what on. Tap one to message it; the info button opens its
 * profile.
 */
import { useMemo, useState } from 'react'
import { Pressable, Text, View, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import { Info, Store } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useAgentActivity } from '../../../hooks/useAgentActivity'
import type { Mentionables } from '../../../lib/team-chat-api'
import { agentWorkingOn } from '../../../lib/agent-directory'
import { useOpenAgentDm } from '../../../lib/use-open-agent-dm'
import { AgentAvatar } from '../AgentAvatar'
import { AgentProfileCard } from '../AgentProfileCard'
import { PanelLink, PanelSection } from '../ConversationRows'
import { useTeamChatNav } from '../TeamChatSidebarProvider'
import { useWorkspaceExperience } from '../../../hooks/useWorkspaceExperience'

type Agent = Mentionables['agents'][number]

export function AgentsPanel({ onNavPress }: { onNavPress?: () => void }) {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const chat = useTeamChatNav()
  const experience = useWorkspaceExperience()
  const activity = useAgentActivity({ light: true })
  const [profile, setProfile] = useState<Agent | null>(null)
  const { openAgentDm, opening } = useOpenAgentDm(chat.workspaceId)
  const [openingKey, setOpeningKey] = useState<string | null>(null)
  const agents = chat.mentionables?.agents ?? []
  const work = useMemo(() => agentWorkingOn(activity.tasks, activity.activeChats), [activity.tasks, activity.activeChats])
  if (!chat.enabled || !chat.workspaceId) return null
  const workspaceId = chat.workspaceId

  const message = async (agent: Agent) => {
    setOpeningKey(agent.key)
    try {
      await openAgentDm(agent.projectId, { navigate: chat.openConversation })
    } finally {
      setOpeningKey(null)
    }
  }

  // The project pane sits beside a conversation, so it needs a wide screen.
  const showInPane = async (projectId: string) => {
    await openAgentDm(projectId, {
      withProjectPane: true,
      navigate: (conversation) => {
        router.push(`/(app)/c/${encodeURIComponent(conversation.id)}?project=${encodeURIComponent(projectId)}` as any)
        onNavPress?.()
      },
    })
  }

  return (
    <View className="px-2" testID="agents-panel">
      <PanelSection label="Agents" addLabel="Message an agent" onAdd={() => chat.startCreate('agent')}>
        {agents.map((agent) => {
          const doing = agent.projectId ? work.get(agent.projectId) : undefined
          return (
            <View key={agent.key} className="flex-row items-center">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Message ${agent.name}${doing ? `, working on ${doing}` : ''}`}
                disabled={opening && openingKey === agent.key}
                onPress={() => void message(agent)}
                className={cn('min-w-0 flex-1 flex-row items-center gap-2.5 rounded-md px-2 py-1.5 active:bg-accent/50', opening && openingKey === agent.key && 'opacity-60')}
              >
                <View>
                  <AgentAvatar name={agent.name} projectId={agent.projectId} workspaceId={workspaceId} iconUrl={agent.image} size={28} />
                  {doing ? <View testID="agent-working" className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary" /> : null}
                </View>
                <View className="min-w-0 flex-1">
                  <Text className="text-sm text-foreground" numberOfLines={1}>{agent.name}</Text>
                  <Text className={cn('text-xs', doing ? 'text-primary' : 'text-muted-foreground')} numberOfLines={1}>
                    {doing ? `Working on ${doing}` : agent.description || 'Idle'}
                  </Text>
                </View>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`${agent.name} profile`} onPress={() => setProfile(agent)} className="rounded-md p-2 active:bg-accent/50">
                <Info size={14} className="text-muted-foreground" />
              </Pressable>
            </View>
          )
        })}
        {agents.length === 0 && <Text className="px-2 py-3 text-xs text-muted-foreground">No agents in this workspace yet.</Text>}
        {experience.showMarketplace && (
          <PanelLink
            icon={Store}
            label="Add agents"
            onPress={() => {
              router.push('/(app)/marketplace' as any)
              onNavPress?.()
            }}
          />
        )}
      </PanelSection>
      {profile && (
        <AgentProfileCard
          workspaceId={workspaceId}
          projectId={profile.projectId}
          name={profile.name}
          iconUrl={profile.image}
          onClose={() => setProfile(null)}
          onOpenProjectPane={width >= 1024 ? (projectId) => void showInPane(projectId) : undefined}
          onOpenChannel={(id) => {
            setProfile(null)
            router.push(`/(app)/c/${encodeURIComponent(id)}` as any)
            onNavPress?.()
          }}
        />
      )}
    </View>
  )
}
