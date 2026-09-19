// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Secondary workspace-scoped chats — a place to explore a tangent (e.g.
 * "help me plan a birthday party") without it becoming part of the
 * goal-tracking primary companion thread. Lists every non-primary
 * `ChatSession` for the workspace (see `workspace-session.service.ts`); tap
 * one to open it, or start a new one.
 */
import { useCallback, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { ArrowLeft, ChevronRight, MessageSquare, MessagesSquare, Plus } from 'lucide-react-native'
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { api } from '../../lib/api'

interface SideChatItem {
  id: string
  name?: string | null
  inferredName?: string | null
  lastActiveAt?: string
  createdAt?: string
}

function sideChatLabel(session: SideChatItem): string {
  const name = session.name?.trim()
  if (name) return name
  if (session.inferredName?.trim()) return session.inferredName.trim()
  const created = session.createdAt ? new Date(session.createdAt) : new Date()
  return `Chat · ${created.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

export const SideChatsScreen = observer(function SideChatsScreen() {
  const http = useDomainHttp()
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const [sessions, setSessions] = useState<SideChatItem[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    if (!workspace?.id) return
    try {
      const all = await api.listWorkspaceSessions(http, workspace.id)
      setSessions(all.filter((s) => !s.isPrimary))
    } catch {
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [http, workspace?.id])

  useFocusEffect(useCallback(() => {
    void load()
  }, [load]))

  const sorted = useMemo(
    () =>
      [...sessions].sort(
        (a, b) =>
          new Date(b.lastActiveAt || b.createdAt || 0).getTime() -
          new Date(a.lastActiveAt || a.createdAt || 0).getTime(),
      ),
    [sessions],
  )

  const openChat = useCallback(
    (sessionId: string) => {
      router.push({ pathname: '/(app)/side-chats/[id]', params: { id: sessionId } } as any)
    },
    [router],
  )

  const startNewChat = useCallback(async () => {
    if (!workspace?.id || creating) return
    setCreating(true)
    try {
      const session = await api.createWorkspaceSession(http, workspace.id, {})
      openChat(session.id)
    } catch {
      // Non-fatal — the user can retry.
    } finally {
      setCreating(false)
    }
  }, [creating, http, openChat, workspace?.id])

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
          disabled={creating}
          accessibilityLabel="New side chat"
          className="rounded-md p-2 active:bg-muted disabled:opacity-50"
        >
          {creating ? <ActivityIndicator size="small" /> : <Plus size={22} className="text-foreground" />}
        </Pressable>
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : sorted.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <MessageSquare size={40} className="mb-3 text-muted-foreground" />
          <Text className="text-center text-base font-medium text-foreground">No side chats yet</Text>
          <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">
            Start one for a tangent you don't want mixed into your main conversation.
          </Text>
          <Pressable
            onPress={() => void startNewChat()}
            disabled={creating}
            className="mt-5 rounded-full bg-muted px-5 py-2.5 active:opacity-80 disabled:opacity-50"
          >
            <Text className="text-base font-medium text-foreground">New side chat</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={sorted}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => openChat(item.id)}
              accessibilityRole="button"
              className="flex-row items-center gap-3 border-b border-border/60 px-4 py-4 active:bg-muted/50"
            >
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
