// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A single side chat: the same workspace-scoped `ChatPanel` the primary
 * companion chat uses (same merged-root runtime, same tools), just pointed
 * at a non-primary `ChatSession`. See `SideChatsScreen` for the list this
 * is opened from.
 */
import { useCallback } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { ArrowLeft } from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import { ChatPanel } from '../chat/ChatPanel'

export const SideChatScreen = observer(function SideChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { user } = useAuth()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace('/(app)/side-chats' as any)
  }, [router])

  if (!workspace?.id || !id) return null

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2 border-b border-border px-4 py-4">
        <Pressable onPress={goBack} accessibilityLabel="Back" className="-ml-2 rounded-md p-2 active:bg-muted">
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
        <Text className="flex-1 text-lg font-semibold text-foreground" numberOfLines={1}>
          Side chat
        </Text>
      </View>
      <View className="min-h-0 flex-1">
        <ChatPanel
          featureId={null}
          featureName="Side chat"
          phase={null}
          workspaceId={workspace.id}
          userId={user?.id}
          chatScope="workspace"
          chatSessionId={id}
          onChatSessionChange={() => {}}
          composer={experience.composer}
          className="flex-1"
          isActive
        />
      </View>
    </View>
  )
})
