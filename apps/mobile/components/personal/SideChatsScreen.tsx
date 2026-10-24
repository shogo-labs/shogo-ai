// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Secondary workspace-scoped chats — a place to explore a tangent (e.g.
 * "help me plan a birthday party") without it becoming part of the
 * goal-tracking primary companion thread. Lists every non-primary
 * `ChatSession` for the workspace (see `workspace-session.service.ts`); tap
 * one to open it, or start a new one. Data comes from `useWorkspaceChats`, the
 * same path Home and the phone drawer read.
 */
import { useCallback } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { ArrowLeft, ChevronRight, Loader2, MessageSquare, MessagesSquare, Pin, Plus } from 'lucide-react-native'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceChats } from '../../hooks/useWorkspaceChats'
import { sideChatLabel, type SideChatItem } from '../../lib/side-chats'

export const SideChatsScreen = observer(function SideChatsScreen() {
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const chats = useWorkspaceChats(workspace?.id)

  // Re-read on focus: a chat archived or renamed from Home must be gone from
  // (or renamed in) this screen too.
  useFocusEffect(
    useCallback(() => {
      void chats.refresh()
    }, [chats.refresh]),
  )

  const openChat = useCallback(
    (sessionId: string) => {
      chats.markSeen(sessionId)
      router.push({ pathname: '/(app)/agent', params: { chatSessionId: sessionId } } as any)
    },
    [chats.markSeen, router],
  )

  const startNewChat = useCallback(async () => {
    const session = await chats.createChat()
    if (session) openChat(session.id)
  }, [chats.createChat, openChat])

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace('/(app)' as any)
  }, [router])

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2 border-b border-border px-4 py-4">
        <Pressable onPress={goBack} accessibilityLabel="Back" className="-ml-2 rounded-md p-2 active:bg-muted">
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <MessagesSquare size={18} className="shrink-0 text-muted-foreground" />
          <Text className="flex-1 text-lg font-semibold text-foreground" numberOfLines={1}>
            Side chats
          </Text>
        </View>
        <Pressable
          onPress={() => void startNewChat()}
          disabled={chats.creating}
          accessibilityLabel="New side chat"
          className="rounded-md p-2 active:bg-muted disabled:opacity-50"
        >
          {chats.creating ? <ActivityIndicator size="small" /> : <Plus size={22} className="text-foreground" />}
        </Pressable>
      </View>

      {chats.loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : chats.sessions.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <MessageSquare size={40} className="mb-3 text-muted-foreground" />
          <Text className="text-center text-base font-medium text-foreground">No side chats yet</Text>
          <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">
            Start one for a tangent you don't want mixed into your main conversation.
          </Text>
          <Pressable
            onPress={() => void startNewChat()}
            disabled={chats.creating}
            className="mt-5 rounded-full bg-muted px-5 py-2.5 active:opacity-80 disabled:opacity-50"
          >
            <Text className="text-base font-medium text-foreground">New side chat</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList<SideChatItem>
          data={[...chats.active, ...chats.archived]}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => openChat(item.id)}
              accessibilityRole="button"
              className="flex-row items-center gap-3 border-b border-border/60 px-4 py-4 active:bg-muted/50"
            >
              {/* Same leading slot as the sidebar row: running › unread › pinned. */}
              <View className="w-4 items-center justify-center">
                {chats.streamingIds.has(item.id) ? (
                  <Loader2
                    size={14}
                    className="text-primary animate-spin"
                    accessibilityLabel="Chat running"
                  />
                ) : chats.completedIds.has(item.id) ? (
                  <View
                    className="h-1.5 w-1.5 rounded-full bg-primary"
                    accessibilityLabel="Chat has new activity"
                  />
                ) : item.isPinned ? (
                  <Pin
                    size={13}
                    className="text-muted-foreground"
                    accessibilityLabel="Pinned"
                  />
                ) : null}
              </View>
              <View className="h-9 w-9 items-center justify-center rounded-xl bg-muted">
                <MessageSquare size={16} className="text-foreground" />
              </View>
              <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
                {sideChatLabel(item)}
              </Text>
              <ChevronRight size={18} className="text-muted-foreground" />
            </Pressable>
          )}
        />
      )}
    </View>
  )
})
