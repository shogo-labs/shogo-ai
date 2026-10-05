// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An agent's full profile: its Shogo buddy (live), what it is for, who owns it,
 * the channels it works in, and quick links to message it or open its project.
 * Owners and workspace admins can change how the agent looks.
 */
import { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft, FolderOpen, MessageSquare, PanelRight, Palette } from 'lucide-react-native'
import { teamChatApi } from '../../lib/team-chat-api'
import { invalidateConversationList, useAgentLook } from '../../hooks/useTeamChat'
import { ShogoBuddy } from '../island/buddy/ShogoBuddy'
import { BuddyLookSheet } from '../personal/BuddyLookSheet'
import { AgentProfileBody, useAgentCard } from './AgentProfileBody'
import { buddyAvatarColor } from './BuddyAvatar'
import { useAgentLookEditor } from './useAgentLookEditor'

const api = teamChatApi()
const SIDE_PANE_MIN_WIDTH = 1024

/** `ws` is the workspace agent; anything else is a project id (or its `p:` mention key). */
export function agentKeyProjectId(key: string | undefined): string | null {
  if (!key || key === 'ws') return null
  return key.startsWith('p:') ? key.slice(2) : key
}

export function AgentProfileScreen({ workspaceId, agentKey }: { workspaceId: string; agentKey: string | undefined }) {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const projectId = agentKeyProjectId(agentKey)
  const { card, failed, toggleMute } = useAgentCard(workspaceId, projectId)
  const look = useAgentLook(workspaceId, projectId)
  const [customizing, setCustomizing] = useState(false)
  const [opening, setOpening] = useState(false)

  const { save, error } = useAgentLookEditor(workspaceId, projectId, look, card?.buddyLook ?? null)

  const name = card?.name ?? 'Agent'
  const color = buddyAvatarColor(look)
  const canEdit = !!card?.canEdit

  const message = async () => {
    setOpening(true)
    try {
      const conversation = await api.openAgentDm(workspaceId, projectId)
      invalidateConversationList(workspaceId)
      router.push({ pathname: '/(app)/c/[conversationId]', params: { conversationId: conversation.id } } as any)
    } finally {
      setOpening(false)
    }
  }
  const showInPane = async () => {
    if (!projectId) return
    setOpening(true)
    try {
      const conversation = await api.openAgentDm(workspaceId, projectId)
      invalidateConversationList(workspaceId)
      router.push({ pathname: '/(app)/c/[conversationId]', params: { conversationId: conversation.id, project: projectId } } as any)
    } finally {
      setOpening(false)
    }
  }
  const goBack = () => {
    if (router.canGoBack()) router.back()
    else router.replace('/(app)/c' as any)
  }

  return (
    <SafeAreaView className="flex-1 bg-background" testID="agent-profile-screen">
      <View className="flex-row items-center px-2 py-2">
        <Pressable onPress={goBack} accessibilityRole="button" accessibilityLabel="Back" className="rounded-lg p-2 active:bg-muted">
          <ChevronLeft size={22} className="text-foreground" />
        </Pressable>
      </View>
      <ScrollView contentContainerClassName="items-center px-5 pb-10">
        <View className="w-full max-w-[560px] gap-5">
          <View className="items-center gap-2">
            <View style={{ width: 160, height: 160, alignItems: 'center', justifyContent: 'flex-end', overflow: 'visible' }}>
              <ShogoBuddy size={150} state="idle" color={color} look={look} interactive followPointer accessibilityLabel={`${name} avatar`} />
            </View>
            <Text className="text-2xl font-semibold text-foreground" numberOfLines={2}>{name}</Text>
            <View className="rounded bg-primary/10 px-1.5 py-px">
              <Text className="text-[10px] font-medium text-primary">AGENT</Text>
            </View>
          </View>

          <View className="flex-row flex-wrap justify-center gap-2">
            <ActionButton label="Message" icon={<MessageSquare size={14} className="text-foreground" />} onPress={() => void message()} disabled={opening} />
            {projectId ? (
              <ActionButton
                label="Open project"
                icon={<FolderOpen size={14} className="text-foreground" />}
                onPress={() => router.push({ pathname: '/(app)/projects/[id]', params: { id: projectId } } as any)}
              />
            ) : null}
            {projectId && width >= SIDE_PANE_MIN_WIDTH ? (
              <ActionButton label="Show in side panel" icon={<PanelRight size={14} className="text-foreground" />} onPress={() => void showInPane()} disabled={opening} />
            ) : null}
            {canEdit ? (
              <ActionButton label="Customize look" icon={<Palette size={14} className="text-foreground" />} onPress={() => setCustomizing(true)} />
            ) : null}
          </View>

          {!card && !failed ? <ActivityIndicator /> : null}
          {failed ? <Text className="text-center text-sm text-muted-foreground">Couldn’t load this agent’s details.</Text> : null}
          {card ? (
            <View className="rounded-xl border border-border bg-card p-4">
              <AgentProfileBody
                card={card}
                onToggleMute={toggleMute}
                onOpenChannel={(id) => router.push({ pathname: '/(app)/c/[conversationId]', params: { conversationId: id } } as any)}
              />
            </View>
          ) : null}
        </View>
      </ScrollView>

      {canEdit && (
        <BuddyLookSheet
          visible={customizing}
          onClose={() => setCustomizing(false)}
          target={{
            look,
            onChange: save,
            error,
            title: `Dress up ${name}`,
            onReset: () => save(null),
          }}
        />
      )}
    </SafeAreaView>
  )
}

function ActionButton({ label, icon, onPress, disabled }: { label: string; icon: React.ReactNode; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={`flex-row items-center gap-1.5 rounded-lg border border-border px-3 py-2 active:bg-muted ${disabled ? 'opacity-60' : ''}`}
    >
      {icon}
      <Text className="text-sm font-medium text-foreground">{label}</Text>
    </Pressable>
  )
}
