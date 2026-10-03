// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A team chat conversation (channel, DM, or agent DM). Threads open from
 * `?thread=<rootId>`: beside the timeline on wide screens, in its place on
 * narrow ones.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { teamChatApi, type ChatMessage, type ConversationDetail } from '../../../lib/team-chat-api'
import { useTeamChatEvents } from '../../../lib/team-chat-connection'
import {
  invalidateConversationList,
  setActiveConversation,
  useMentionables,
  useMyUserId,
} from '../../../hooks/useTeamChat'
import { useStatusFeed } from '../../../hooks/useChatPrefs'
import { useDraftsFeed, useSavedFeed } from '../../../hooks/useChatItems'
import { useCustomEmojiFeed } from '../../../hooks/useCustomEmoji'
import { ConversationHeader } from '../../../components/team-chat/ConversationHeader'
import { TimelinePane } from '../../../components/team-chat/TimelinePane'

const api = teamChatApi()
const THREAD_SIDE_PANE_MIN_WIDTH = 1024

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default function ConversationScreen() {
  const params = useLocalSearchParams<{ conversationId: string; thread?: string }>()
  const conversationId = first(params.conversationId) ?? null
  const threadRootId = first(params.thread) ?? null
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const me = useMyUserId()
  const { width } = useWindowDimensions()
  const [conversation, setConversation] = useState<ConversationDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [focused, setFocused] = useState(true)
  const [foreground, setForeground] = useState(AppState.currentState === 'active')

  const workspaceId = conversation?.workspaceId ?? workspace?.id ?? null
  const mentionables = useMentionables(workspaceId)
  const sidePane = width >= THREAD_SIDE_PANE_MIN_WIDTH
  useStatusFeed(workspaceId)
  useSavedFeed(workspaceId)
  useDraftsFeed(workspaceId)
  useCustomEmojiFeed(workspaceId)

  useEffect(() => {
    if (workspaceId && threadRootId) void api.markInboxRead(workspaceId, { threadRootId }).catch(() => {})
  }, [workspaceId, threadRootId])

  const load = useCallback(async () => {
    if (!conversationId) return
    try {
      setConversation(await api.get(conversationId))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open this conversation')
    }
  }, [conversationId])

  useEffect(() => {
    setConversation(null)
    void load()
  }, [load])

  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      setActiveConversation(conversationId)
      return () => {
        setFocused(false)
        setActiveConversation(null)
      }
    }, [conversationId]),
  )

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setForeground(s === 'active'))
    return () => sub.remove()
  }, [])

  useTeamChatEvents(workspaceId, (event) => {
    if (!conversationId) return
    if (event.type === 'ready') return void load()
    if (
      (event.type === 'conversation.updated' || event.type === 'member.joined' || event.type === 'member.left') &&
      event.conversationId === conversationId
    ) {
      void load()
    }
  })

  const openThread = useCallback(
    (message: ChatMessage) => {
      router.setParams({ thread: message.threadRootId ?? message.id } as any)
    },
    [router],
  )
  const closeThread = useCallback(() => router.setParams({ thread: undefined } as any), [router])
  const openSession = useCallback(
    (message: ChatMessage) => {
      const projectId = message.authorAgent?.projectId
      if (!projectId || !message.agentSessionId) return
      router.push({ pathname: '/(app)/project-chat/[id]', params: { id: projectId, chatSessionId: message.agentSessionId } } as any)
    },
    [router],
  )
  const onChanged = useCallback(() => {
    void load()
    if (workspaceId) invalidateConversationList(workspaceId)
  }, [load, workspaceId])
  const onJoin = useCallback(async () => {
    if (!conversationId) return
    await api.join(conversationId).catch(() => {})
    onChanged()
  }, [conversationId, onChanged])

  if (error) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-background px-8">
        <Text className="text-center text-sm text-muted-foreground">{error}</Text>
        <Pressable onPress={() => router.replace('/(app)/c' as any)} className="rounded-md bg-muted px-3 py-1.5">
          <Text className="text-sm text-foreground">Browse channels</Text>
        </Pressable>
      </View>
    )
  }
  if (!conversation || !workspaceId) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    )
  }

  const visible = focused && foreground
  const showMain = sidePane || !threadRootId
  const header = (
    <ConversationHeader
      conversation={conversation}
      mentionables={mentionables}
      me={me}
      onChanged={onChanged}
      onLeft={() => router.replace('/(app)/c' as any)}
    />
  )

  return (
    <KeyboardAvoidingView className="flex-1 bg-background" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View className="flex-1 flex-row">
        {showMain && (
          <View className="flex-1">
            {header}
            <TimelinePane
              key={conversation.id}
              workspaceId={workspaceId}
              conversation={conversation}
              me={me}
              mentionables={mentionables}
              visible={visible && !(threadRootId && !sidePane)}
              onOpenThread={openThread}
              onOpenSession={openSession}
              onJoin={onJoin}
            />
          </View>
        )}
        {threadRootId && (
          <View className={sidePane ? 'w-[420px] border-l border-border' : 'flex-1'}>
            <TimelinePane
              key={`${conversation.id}:${threadRootId}`}
              workspaceId={workspaceId}
              conversation={conversation}
              threadRootId={threadRootId}
              me={me}
              mentionables={mentionables}
              visible={visible}
              onOpenSession={openSession}
              onClose={closeThread}
            />
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  )
}
