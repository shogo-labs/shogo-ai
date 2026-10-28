// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat history for the workspace agent. The same list the project sidebar
 * renders (`ChatSessionList`), flat: no section title, no project headers —
 * just this person's chats, with the running spinner, the relative time and the
 * overflow menu a project chat row has.
 */
import { useCallback, useEffect, useState } from 'react'
import { Platform, View } from 'react-native'
import { useFocusEffect, useLocalSearchParams, usePathname, useRouter } from 'expo-router'
import { Plus } from 'lucide-react-native'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { useWorkspaceChats } from '../../../hooks/useWorkspaceChats'
import { isMainChatPath } from '../../../lib/sidebar-tab'
import { usePhoneLayout } from '../../../lib/native-phone-layout'
import { subscribeCurrentWorkspaceSession } from '../../workspace/workspace-agent-session-bus'
import { ChatSessionList } from './ChatSessionList'

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export function WorkspaceChatsPanel({ onNavPress }: { onNavPress?: () => void }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useLocalSearchParams<{ chatSessionId?: string | string[] }>()
  const workspace = useActiveWorkspace()
  const comfortable = usePhoneLayout()
  const workspacePane = Platform.OS === 'web' && !comfortable
  const chats = useWorkspaceChats(workspace?.id)
  const [knownSessionId, setKnownSessionId] = useState<string | null>(null)

  useFocusEffect(
    useCallback(() => {
      void chats.refresh()
    }, [chats.refresh, pathname]),
  )

  useEffect(() => {
    if (!workspace?.id) return
    return subscribeCurrentWorkspaceSession(workspace.id, setKnownSessionId)
  }, [workspace?.id])

  const onAgent = isMainChatPath(pathname) || /\/agent\/?$/.test(pathname)
  const routeSessionId = firstParam(params.chatSessionId)
  const activeId = onAgent ? routeSessionId || knownSessionId : null
  const { markSeen } = chats

  // The open chat is read the moment it is on screen, so a turn that ends
  // here clears its new-activity dot instead of flagging it.
  useEffect(() => {
    markSeen(activeId)
  }, [activeId, markSeen])

  const openChat = (sessionId: string) => {
    router.push({ pathname: '/(app)/agent', params: { chatSessionId: sessionId } } as any)
    onNavPress?.()
  }

  const startNewChat = async () => {
    const session = await chats.createChat()
    if (session) openChat(session.id)
  }

  return (
    <View className="px-2 pt-1" testID="workspace-chats-panel">
      <ChatSessionList
        sessions={chats.active}
        archivedSessions={chats.archived}
        activeChatId={activeId}
        revealActiveChat
        streamingIds={chats.streamingIds}
        completedIds={chats.completedIds}
        variant={workspacePane ? 'workspacePane' : undefined}
        loaded={!chats.loading}
        loadingLabel="Loading…"
        emptyLabel="Your chats with the workspace agent show up here."
        headerAction={{
          label: 'New chat',
          accessibilityLabel: 'New chat',
          icon: <Plus size={12} className="text-muted-foreground shrink-0" />,
          onPress: () => void startNewChat(),
          busy: chats.creating,
        }}
        onSeeAll={() => {
          router.push('/(app)/side-chats' as any)
          onNavPress?.()
        }}
        onSelect={openChat}
        onTogglePin={(id, next) => void chats.updateChat(id, { isPinned: next })}
        onRename={(id, name) => void chats.updateChat(id, { name })}
        onToggleArchive={(id, next) => void chats.updateChat(id, { isArchived: next })}
        onDeleteChat={(id) => void chats.deleteChat(id)}
      />
    </View>
  )
}
