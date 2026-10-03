// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Team chat home: browse and join channels, start DMs and agent DMs.
 */
import { useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Bot, Hash, Lock, MessageSquarePlus, Plus, Radio, Search } from 'lucide-react-native'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../../hooks/useWorkspaceExperience'
import { teamChatApi, type ConversationSummary } from '../../../lib/team-chat-api'
import { invalidateConversationList, useConversationList, useMentionables, useMyUserId } from '../../../hooks/useTeamChat'
import { NewConversationModal, type NewConversationMode } from '../../../components/team-chat/NewConversationModal'
import { conversationHref } from '../../../components/team-chat/TeamChatSidebarSection'

const api = teamChatApi()

export default function TeamChatHome() {
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const workspaceId: string | null = experience.kind === 'team' ? workspace?.id ?? null : null
  const me = useMyUserId()
  const mentionables = useMentionables(workspaceId)
  const { list, loading, error } = useConversationList(workspaceId)
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState<NewConversationMode | null>(null)
  const [joining, setJoining] = useState<string | null>(null)

  const channels = useMemo(() => {
    const q = filter.trim().toLowerCase().replace(/^#/, '')
    return list
      .filter((c) => (c.kind === 'public' || c.kind === 'private' || c.kind === 'activity') && !c.archivedAt)
      .filter((c) => !q || (c.name ?? '').toLowerCase().includes(q) || (c.topic ?? '').toLowerCase().includes(q))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  }, [list, filter])

  const open = (c: ConversationSummary) => router.push(conversationHref(c.id) as any)
  const join = async (c: ConversationSummary) => {
    if (!workspaceId) return
    setJoining(c.id)
    try {
      await api.join(c.id)
      invalidateConversationList(workspaceId)
      open(c)
    } finally {
      setJoining(null)
    }
  }

  if (experience.resolved && experience.kind !== 'team') {
    return (
      <View className="flex-1 items-center justify-center bg-background px-8">
        <Text className="text-center text-sm text-muted-foreground">Team chat is available in team workspaces.</Text>
      </View>
    )
  }

  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 24, maxWidth: 820, width: '100%', alignSelf: 'center' }}>
      <Text className="text-2xl font-semibold text-foreground">Team chat</Text>
      <Text className="mt-1 text-sm text-muted-foreground">
        Talk with your team and your agents in one place. @mention an agent to hand it work, right in the conversation.
      </Text>

      <View className="mt-5 flex-row flex-wrap gap-2">
        <ActionButton icon={Plus} label="Create channel" onPress={() => setCreating('channel')} primary />
        <ActionButton icon={MessageSquarePlus} label="New message" onPress={() => setCreating('dm')} />
        <ActionButton icon={Bot} label="Message an agent" onPress={() => setCreating('agent')} />
      </View>

      <View className="mt-6 flex-row items-center rounded-md border border-border px-3">
        <Search size={14} className="text-muted-foreground" />
        <TextInput
          value={filter}
          onChangeText={setFilter}
          placeholder="Search channels"
          placeholderTextColor="#8a8a8a"
          className="flex-1 px-2 py-2 text-sm text-foreground"
        />
      </View>

      {loading && !list.length ? (
        <ActivityIndicator className="mt-8" />
      ) : error && !list.length ? (
        <Text className="mt-8 text-center text-sm text-muted-foreground">{error}</Text>
      ) : (
        <View className="mt-3 overflow-hidden rounded-lg border border-border">
          {channels.map((c, i) => {
            const Icon = c.kind === 'activity' ? Radio : c.kind === 'private' ? Lock : Hash
            return (
              <Pressable
                key={c.id}
                onPress={() => open(c)}
                className={`flex-row items-center gap-3 px-4 py-3 active:bg-muted hover:bg-muted/50 ${i ? 'border-t border-border' : ''}`}
              >
                <Icon size={16} className="text-muted-foreground" />
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-medium text-foreground">{c.name}</Text>
                  {c.topic ? <Text className="text-xs text-muted-foreground" numberOfLines={1}>{c.topic}</Text> : null}
                </View>
                {c.joined || c.kind === 'activity' ? (
                  <Text className="text-xs text-muted-foreground">Joined</Text>
                ) : (
                  <Pressable onPress={() => void join(c)} disabled={joining === c.id} className="rounded-md bg-primary px-3 py-1">
                    {joining === c.id ? <ActivityIndicator size="small" /> : <Text className="text-xs font-medium text-primary-foreground">Join</Text>}
                  </Pressable>
                )}
              </Pressable>
            )
          })}
          {!channels.length && <Text className="px-4 py-6 text-center text-sm text-muted-foreground">No channels match.</Text>}
        </View>
      )}

      {creating && workspaceId && (
        <NewConversationModal
          workspaceId={workspaceId}
          mode={creating}
          mentionables={mentionables}
          me={me}
          onClose={() => setCreating(null)}
          onCreated={(c) => {
            setCreating(null)
            invalidateConversationList(workspaceId)
            open(c)
          }}
        />
      )}
    </ScrollView>
  )
}

function ActionButton({ icon: Icon, label, onPress, primary }: { icon: typeof Plus; label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      className={`flex-row items-center gap-1.5 rounded-md px-3 py-2 ${primary ? 'bg-primary' : 'border border-border active:bg-muted'}`}
    >
      <Icon size={14} className={primary ? 'text-primary-foreground' : 'text-foreground'} />
      <Text className={`text-sm font-medium ${primary ? 'text-primary-foreground' : 'text-foreground'}`}>{label}</Text>
    </Pressable>
  )
}
