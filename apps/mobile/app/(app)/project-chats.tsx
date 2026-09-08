// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native project chats page.
 *
 * Opened from the sidebar: tap a project → this list → tap a chat → project workspace.
 * Web keeps the in-sidebar accordion and never lands here.
 *
 * Static route (like search.tsx) so Expo does not confuse `/project-chats/:id`
 * with `/projects/:id`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { ArrowLeft, ChevronRight, Folder, MessageSquare, Plus } from 'lucide-react-native'
import { useProjectCollection, useDomainHttp } from '../../contexts/domain'
import {
  fetchProjectChatSessions,
  PROJECT_CHAT_PAGE_SIZE,
  projectChatLabel,
  visibleProjectChatItems,
  type ProjectChatListItem,
} from '../../lib/project-chat-sessions'

export default observer(function ProjectChatsPage() {
  const router = useRouter()
  const params = useLocalSearchParams<{ id?: string }>()
  const projectId = Array.isArray(params.id) ? params.id[0] : params.id
  const projects = useProjectCollection()
  const http = useDomainHttp()

  const [sessions, setSessions] = useState<ProjectChatListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const project = useMemo(() => {
    try {
      return projects.all.find((p: any) => p.id === projectId)
    } catch {
      return undefined
    }
  }, [projectId, projects.all])

  const load = useCallback(
    async (limit = PROJECT_CHAT_PAGE_SIZE) => {
      if (!http || !projectId) {
        setLoading(false)
        return
      }
      const paging = limit > PROJECT_CHAT_PAGE_SIZE
      if (paging) setLoadingMore(true)
      else setLoading(true)
      try {
        const result = await fetchProjectChatSessions(http, projectId, limit)
        setSessions(result.sessions)
        setHasMore(result.hasMore)
      } catch (e) {
        console.error('[ProjectChats] Failed to load chats:', e)
        setSessions([])
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [http, projectId],
  )

  useEffect(() => {
    if (Platform.OS === 'web') {
      router.replace('/(app)' as any)
    }
  }, [router])

  useEffect(() => {
    if (Platform.OS === 'web') return
    void projects.loadAll().catch(() => undefined)
  }, [projects])

  useEffect(() => {
    if (Platform.OS === 'web') return
    void load()
  }, [load])

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace('/(app)' as any)
  }, [router])

  const openChat = useCallback(
    (sessionId: string) => {
      if (!projectId) return
      router.push({
        pathname: '/(app)/projects/[id]',
        params: { id: projectId, chatSessionId: sessionId },
      } as any)
    },
    [projectId, router],
  )

  const openNewChat = useCallback(() => {
    if (!projectId) return
    router.push({
      pathname: '/(app)/projects/[id]',
      params: { id: projectId, newChat: '1', newChatNonce: String(Date.now()) },
    } as any)
  }, [projectId, router])

  const loadMore = useCallback(() => {
    if (hasMore && !loadingMore) void load(sessions.length + PROJECT_CHAT_PAGE_SIZE)
  }, [hasMore, load, loadingMore, sessions.length])

  const renderChat = useCallback(
    ({ item }: { item: ProjectChatListItem }) => {
      const label = projectChatLabel(item)
      return (
        <Pressable
          onPress={() => openChat(item.id)}
          accessibilityRole="button"
          accessibilityLabel={label}
          className="flex-row items-center gap-3 px-4 py-3.5 active:bg-muted/60"
        >
          <View className="h-11 w-11 items-center justify-center rounded-2xl bg-muted">
            <MessageSquare size={18} className="text-foreground" />
          </View>
          <Text className="min-w-0 flex-1 text-[16px] font-medium text-foreground" numberOfLines={1}>
            {label}
          </Text>
          <ChevronRight size={18} className="text-muted-foreground shrink-0" />
        </Pressable>
      )
    },
    [openChat],
  )

  const activeSessions = useMemo(
    () => visibleProjectChatItems(sessions),
    [sessions],
  )

  if (Platform.OS === 'web') return null

  const title = project?.name || 'Project'

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2 border-b border-border px-4 py-4">
        <Pressable
          onPress={goBack}
          accessibilityLabel="Back"
          className="rounded-md p-2 -ml-2 active:bg-muted"
        >
          <ArrowLeft size={24} className="text-foreground" />
        </Pressable>
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <Folder size={18} className="text-muted-foreground shrink-0" />
          <Text className="flex-1 text-xl font-semibold text-foreground" numberOfLines={1}>
            {title}
          </Text>
        </View>
        <Pressable
          onPress={openNewChat}
          accessibilityLabel={`New chat in ${title}`}
          className="rounded-md p-2 active:bg-muted"
        >
          <Plus size={22} className="text-foreground" />
        </Pressable>
      </View>

      {loading && sessions.length === 0 ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : activeSessions.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <MessageSquare size={44} className="text-muted-foreground" />
          <Text className="text-center text-lg font-semibold text-foreground">No chats yet</Text>
          <Text className="max-w-[280px] text-center text-base text-muted-foreground">
            Start a chat in this project to see it here.
          </Text>
          <Pressable
            onPress={openNewChat}
            className="mt-2 rounded-full bg-muted px-5 py-2.5 active:opacity-80"
          >
            <Text className="text-base font-medium text-foreground">New chat</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={activeSessions}
          keyExtractor={(item) => item.id}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <View className="items-center py-4">
                <ActivityIndicator />
              </View>
            ) : null
          }
          renderItem={renderChat}
        />
      )}
    </View>
  )
})
