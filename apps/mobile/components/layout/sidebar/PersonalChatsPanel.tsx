// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Home panel of a personal workspace on desktop: the main chat with the
 * workspace's other (side) chats under it. Meetings, Goals and Activity are
 * pages the rail already names, so they are not repeated here.
 */
import { useCallback, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { useFocusEffect, usePathname, useRouter } from 'expo-router'
import { MessageCircle, MessageSquare, Plus } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../../contexts/domain'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { api } from '../../../lib/api'
import { isMainChatPath } from '../../../lib/sidebar-tab'
import { sideChatLabel, sortSideChats, type SideChatItem } from '../../../lib/side-chats'

const ROW = 'flex-row items-center gap-2.5 rounded-md px-2 py-2 active:bg-accent/50'

export function PersonalChatsPanel({ onNavPress }: { onNavPress?: () => void }) {
  const http = useDomainHttp()
  const router = useRouter()
  const pathname = usePathname()
  const workspace = useActiveWorkspace()
  const [sessions, setSessions] = useState<SideChatItem[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    if (!workspace?.id) return
    try {
      const all = await api.listWorkspaceSessions(http, workspace.id)
      setSessions(all.filter((s: any) => !s.isPrimary))
    } catch {
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [http, workspace?.id])

  // Reload when the route changes so a chat started elsewhere shows up.
  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load, pathname]),
  )

  const sorted = useMemo(() => sortSideChats(sessions), [sessions])

  const go = (href: any) => {
    router.push(href)
    onNavPress?.()
  }

  const startNewChat = async () => {
    if (!workspace?.id || creating) return
    setCreating(true)
    try {
      const session = await api.createWorkspaceSession(http, workspace.id, {})
      go({ pathname: '/(app)/side-chats/[id]', params: { id: session.id } })
    } catch {
      // Non-fatal: the person can try again.
    } finally {
      setCreating(false)
    }
  }

  return (
    <View className="px-2 pt-1" testID="personal-chats-panel">
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Chat"
        aria-current={isMainChatPath(pathname) ? 'page' : undefined}
        onPress={() => go('/(app)')}
        className={cn(ROW, isMainChatPath(pathname) && 'bg-accent')}
      >
        <MessageCircle size={16} className="text-muted-foreground" />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>Chat</Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>Your main conversation</Text>
        </View>
      </Pressable>

      <View className="mt-3 flex-row items-center justify-between px-2 pb-1">
        <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Other chats</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New side chat"
          disabled={creating}
          onPress={() => void startNewChat()}
          className="h-6 w-6 items-center justify-center rounded-md active:bg-accent disabled:opacity-50"
        >
          {creating ? <ActivityIndicator size="small" /> : <Plus size={14} className="text-muted-foreground" />}
        </Pressable>
      </View>

      {loading ? (
        <View className="items-center py-4">
          <ActivityIndicator size="small" />
        </View>
      ) : sorted.length === 0 ? (
        <Text className="px-2 py-2 text-xs leading-4 text-muted-foreground">
          Side chats are for tangents you do not want mixed into your main conversation.
        </Text>
      ) : (
        sorted.map((chat) => {
          const active = pathname.includes(`/side-chats/${chat.id}`)
          return (
            <Pressable
              key={chat.id}
              accessibilityRole="link"
              accessibilityLabel={sideChatLabel(chat)}
              aria-current={active ? 'page' : undefined}
              onPress={() => go({ pathname: '/(app)/side-chats/[id]', params: { id: chat.id } })}
              className={cn(ROW, active && 'bg-accent')}
            >
              <MessageSquare size={14} className="text-muted-foreground" />
              <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>{sideChatLabel(chat)}</Text>
            </Pressable>
          )
        })
      )}
    </View>
  )
}
