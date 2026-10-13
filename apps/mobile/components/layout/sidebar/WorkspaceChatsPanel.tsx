// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat history for the workspace agent. Every row is a chat the signed-in
 * user owns. New chat, rename, pin, archive and delete live here; the open
 * chat is the main panel.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Platform, Pressable, Text, View } from 'react-native'
import { useFocusEffect, useLocalSearchParams, usePathname, useRouter } from 'expo-router'
import { ChevronRight, Plus } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  useChatSessionCollection,
  useDomainActions,
  useDomainHttp,
} from '../../../contexts/domain'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { api } from '../../../lib/api'
import { chatSessionEvents } from '../../../lib/chat-session-events'
import { isMainChatPath } from '../../../lib/sidebar-tab'
import { sortSideChats, type SideChatItem } from '../../../lib/side-chats'
import { subscribeCurrentWorkspaceSession } from '../../workspace/workspace-agent-session-bus'
import { ChatTreeItem } from './ChatTreeItem'

interface WorkspaceChat extends SideChatItem {
  isPinned?: boolean
  isArchived?: boolean
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export function WorkspaceChatsPanel({ onNavPress }: { onNavPress?: () => void }) {
  const http = useDomainHttp()
  const actions = useDomainActions()
  const chatSessions = useChatSessionCollection()
  const router = useRouter()
  const pathname = usePathname()
  const params = useLocalSearchParams<{ chatSessionId?: string | string[] }>()
  const workspace = useActiveWorkspace()
  const [sessions, setSessions] = useState<WorkspaceChat[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [knownSessionId, setKnownSessionId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!workspace?.id) return
    try {
      const all = await api.listWorkspaceSessions(http, workspace.id)
      setSessions(all)
    } catch {
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [http, workspace?.id])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load, pathname]),
  )

  useEffect(() => {
    if (!workspace?.id) return
    return subscribeCurrentWorkspaceSession(workspace.id, setKnownSessionId)
  }, [workspace?.id])

  useEffect(() => {
    return chatSessionEvents.subscribe((event) => {
      if (!event.refresh || !workspace?.id || event.workspaceId !== workspace.id) return
      void load()
    })
  }, [load, workspace?.id])

  const active = useMemo(
    () => sortSideChats(sessions.filter((session) => !session.isArchived)),
    [sessions],
  )
  const archived = useMemo(
    () => sortSideChats(sessions.filter((session) => session.isArchived)),
    [sessions],
  )

  const onAgent = isMainChatPath(pathname) || /\/agent\/?$/.test(pathname)
  const routeSessionId = firstParam(params.chatSessionId)
  const activeId = onAgent ? routeSessionId || knownSessionId : null

  const openChat = (sessionId: string) => {
    router.push({ pathname: '/(app)/agent', params: { chatSessionId: sessionId } } as any)
    onNavPress?.()
  }

  const startNewChat = async () => {
    if (!workspace?.id || creating) return
    setCreating(true)
    try {
      const session = await api.createWorkspaceSession(http, workspace.id, {})
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)])
      openChat(session.id)
    } catch {
      // The person can try again.
    } finally {
      setCreating(false)
    }
  }

  const ensureLoaded = async (sessionId: string) => {
    if (!chatSessions.get(sessionId)) await chatSessions.loadById(sessionId)
  }

  const updateChat = async (
    sessionId: string,
    changes: { name?: string; isPinned?: boolean; isArchived?: boolean },
  ) => {
    const previous = sessions
    setSessions((current) =>
      current.map((session) => (session.id === sessionId ? { ...session, ...changes } : session)),
    )
    try {
      await ensureLoaded(sessionId)
      await actions.updateChatSession(sessionId, changes)
    } catch {
      setSessions(previous)
    }
  }

  const deleteChat = async (sessionId: string) => {
    const previous = sessions
    setSessions((current) => current.filter((session) => session.id !== sessionId))
    try {
      await actions.deleteChatSession(sessionId)
      if (activeId === sessionId) router.replace('/(app)/agent' as any)
    } catch {
      setSessions(previous)
    }
  }

  const requestDelete = (sessionId: string) => {
    const run = () => void deleteChat(sessionId)
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      if (window.confirm('Delete this chat? This cannot be undone.')) run()
      return
    }
    Alert.alert('Delete chat', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: run },
    ])
  }

  const renderChat = (chat: WorkspaceChat) => (
    <ChatTreeItem
      key={chat.id}
      session={chat}
      active={chat.id === activeId}
      onSelect={openChat}
      onTogglePin={(id, next) => void updateChat(id, { isPinned: next })}
      onRename={(id, name) => void updateChat(id, { name })}
      onToggleArchive={(id, next) => void updateChat(id, { isArchived: next })}
      onRequestDelete={requestDelete}
    />
  )

  return (
    <View className="px-2 pt-1" testID="workspace-chats-panel">
      <View className="mb-1 flex-row items-center justify-between px-2">
        <Text className="text-[13px] font-medium text-sidebar-foreground">Workspace agent</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New chat"
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
      ) : active.length === 0 && archived.length === 0 ? (
        <Text className="px-2 py-2 text-xs leading-4 text-muted-foreground">
          Your chats with the workspace agent show up here.
        </Text>
      ) : (
        active.map(renderChat)
      )}

      {archived.length > 0 ? (
        <View className="mt-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Archived chats"
            onPress={() => setArchivedOpen((open) => !open)}
            className="flex-row items-center gap-1.5 rounded-lg px-2 py-2 active:bg-sidebar-accent/60"
          >
            <ChevronRight
              size={14}
              className={cn('text-muted-foreground', archivedOpen && 'rotate-90')}
            />
            <Text className="text-[13px] font-medium text-sidebar-muted-foreground">
              Archived
            </Text>
            <Text className="text-xs text-muted-foreground">{archived.length}</Text>
          </Pressable>
          {archivedOpen ? archived.map(renderChat) : null}
        </View>
      ) : null}
    </View>
  )
}
