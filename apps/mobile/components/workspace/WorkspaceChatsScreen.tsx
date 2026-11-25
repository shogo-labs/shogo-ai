// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Full-screen list of all workspace-agent chats (active + archived). Mounted
 * at `/(app)/chats`; also the destination of "See all" in the sidebar panel
 * and "All chats" in the agent drawer.
 *
 * Data comes from `useWorkspaceChats` — the same hook the drawer and
 * WorkspaceChatsPanel read — so pin/rename/archive/delete made here are
 * immediately visible in both.
 */
import { useCallback } from 'react'
import { FlatList, Pressable, Text, View, useWindowDimensions } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  ChevronRight,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Pin,
  Plus,
} from 'lucide-react-native'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceChats } from '../../hooks/useWorkspaceChats'
import { sideChatLabel, type SideChatItem } from '../../lib/side-chats'
import { Spin } from '@/components/ui/Spin'
import { GlassButton } from '../team-chat/FloatingChrome'
import { PhoneScreenHeader, usePhoneScreenHeaderInset } from '../layout/PhoneScreenHeader'
import { isPhoneLayout } from '../../lib/native-phone-layout'
import { Spinner } from '@/components/ui/spinner'

export const WorkspaceChatsScreen = observer(function WorkspaceChatsScreen() {
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const chats = useWorkspaceChats(workspace?.id)
  const { width, height } = useWindowDimensions()
  const phone = isPhoneLayout(width, height)
  const header = usePhoneScreenHeaderInset()

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
    else router.replace('/(app)/agent' as any)
  }, [router])

  return (
    <View className="flex-1 bg-background">
      {phone ? (
        <PhoneScreenHeader
          title="Chats"
          titleIcon={<MessagesSquare size={14} className="text-muted-foreground" />}
          onBack={goBack}
          onLayout={header.onLayout}
          actions={
            <GlassButton label="New chat" onPress={() => void startNewChat()}>
              {chats.creating ? <Spinner size="small" /> : <Plus size={20} className="text-foreground" />}
            </GlassButton>
          }
        />
      ) : (
        <View className="flex-row items-center gap-2 border-b border-border px-4 py-4">
          <Pressable onPress={goBack} accessibilityLabel="Back" className="-ml-2 rounded-md p-2 active:bg-muted">
            <ArrowLeft size={22} className="text-foreground" />
          </Pressable>
          <View className="min-w-0 flex-1 flex-row items-center gap-2">
            <MessagesSquare size={18} className="shrink-0 text-muted-foreground" />
            <Text className="flex-1 text-lg font-semibold text-foreground" numberOfLines={1}>
              Chats
            </Text>
          </View>
          <Pressable
            onPress={() => void startNewChat()}
            disabled={chats.creating}
            accessibilityLabel="New chat"
            className="rounded-md p-2 active:bg-muted disabled:opacity-50"
          >
            {chats.creating ? <Spinner size="small" /> : <Plus size={22} className="text-foreground" />}
          </Pressable>
        </View>
      )}

      <View className="min-h-0 flex-1" style={phone ? { paddingTop: header.height } : undefined}>
      {chats.loading ? (
        <View className="flex-1 items-center justify-center">
          <Spinner />
        </View>
      ) : chats.sessions.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <MessageSquare size={40} className="mb-3 text-muted-foreground" />
          <Text className="text-center text-base font-medium text-foreground">No chats yet</Text>
          <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">
            Start a conversation with the workspace agent.
          </Text>
          <Pressable
            onPress={() => void startNewChat()}
            disabled={chats.creating}
            className="mt-5 rounded-full bg-muted px-5 py-2.5 active:opacity-80 disabled:opacity-50"
          >
            <Text className="text-base font-medium text-foreground">New chat</Text>
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
              <View className="w-4 items-center justify-center">
                {chats.streamingIds.has(item.id) ? (
                  <Spin>
                    <Loader2
                      size={14}
                      className="text-primary animate-spin"
                      accessibilityLabel="Chat running"
                    />
                  </Spin>
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
    </View>
  )
})
