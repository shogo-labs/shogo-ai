// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phone project chats page.
 *
 * Opened from the sidebar: tap a project → this list → tap a chat → project workspace.
 * Wide web keeps the in-sidebar accordion and never lands here.
 *
 * Static route (like search.tsx) so Expo does not confuse `/project-chats/:id`
 * with `/projects/:id`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  FlatList,
  Pressable,
  Text,
  View,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { observer } from 'mobx-react-lite'
import { ChevronRight, Folder, MessageSquare, Plus } from 'lucide-react-native'
import { useProjectCollection, useDomainHttp } from '../../contexts/domain'
import {
  PhoneListEmpty,
  PhoneListRow } from "../../components/phone/PhoneListRow"
import { usePhoneOnlyRoute } from "../../lib/use-phone-only-route";
import { GlassButton } from "../../components/team-chat/FloatingChrome";
import {
  PhoneScreenHeader,
  usePhoneScreenHeaderInset,
} from "../../components/layout/PhoneScreenHeader";
import {
  fetchProjectChatSessions,
  PROJECT_CHAT_PAGE_SIZE,
  projectChatLabel,
  visibleProjectChatItems,
  type ProjectChatListItem,
} from '../../lib/project-chat-sessions'
import { Spinner } from '@/components/ui/spinner'

export default observer(function ProjectChatsPage() {
  const router = useRouter()
  const params = useLocalSearchParams<{ id?: string }>()
  const projectId = Array.isArray(params.id) ? params.id[0] : params.id
  const projects = useProjectCollection()
  const http = useDomainHttp()
  const isSupportedPlatform = usePhoneOnlyRoute()
  const header = usePhoneScreenHeaderInset()
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
    if (!isSupportedPlatform) return
    void projects.loadAll().catch(() => undefined)
  }, [isSupportedPlatform, projects])

  useEffect(() => {
    if (!isSupportedPlatform) return
    void load()
  }, [isSupportedPlatform, load])

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
        <View className="mx-4 mt-2 overflow-hidden rounded-2xl border border-border/70 bg-card">
          <PhoneListRow
            onPress={() => openChat(item.id)}
            title={label}
            icon={
            <MessageSquare size={18} className="text-orange-600 dark:text-orange-300" />}
            trailing={
            <ChevronRight size={18} className="text-muted-foreground" />
            }
          />
        </View>
      )
    },
    [openChat],
  )

  const activeSessions = useMemo(
    () => visibleProjectChatItems(sessions),
    [sessions],
  )

  if (!isSupportedPlatform) return null

  const title = project?.name || 'Project'

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['left', 'right']}>
      <PhoneScreenHeader
        title={title}
        subtitle="Project chats"
        titleIcon={<Folder size={14} className="text-orange-600 dark:text-orange-300" />}
        onBack={goBack}
        onLayout={header.onLayout}
        actions={
          <GlassButton label={`New chat in ${title}`} onPress={openNewChat}>
            <Plus size={20} className="text-foreground" />
          </GlassButton>
        }
      />

      <View className="min-h-0 flex-1" style={{ paddingTop: header.height }}>
      {loading && sessions.length === 0 ? (
        <View className="flex-1 items-center justify-center">
          <Spinner />
        </View>
      ) : activeSessions.length === 0 ? (
        <PhoneListEmpty
          icon={
          <MessageSquare size={44} className="text-muted-foreground" />}
          title="No chats yet"
          message="Start a chat in this project to see it here."
          action={
          <Pressable
            onPress={openNewChat}
            className="rounded-xl bg-orange-500 px-5 py-2.5 active:bg-orange-600"
          >
            <Text className="text-base font-medium text-white">New chat</Text>
          </Pressable>
          }
        />
      ) : (
        <FlatList
          data={activeSessions}
          keyExtractor={(item) => item.id}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          contentContainerClassName="pb-8 pt-2"
          showsVerticalScrollIndicator={false}
          ListFooterComponent={
            loadingMore ? (
              <View className="items-center py-4">
                <Spinner />
              </View>
            ) : null
          }
          renderItem={renderChat}
        />
      )}
      </View>
    </SafeAreaView>
  )
})
