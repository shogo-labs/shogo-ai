// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "New message" / "Create channel" as a full screen, used on phones instead of
 * a modal. Wide screens keep `NewConversationModal`; both render the same
 * `NewMessagePicker` / `NewChannelForm`.
 */
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft } from 'lucide-react-native'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import { invalidateConversationList, useMentionables, useMyUserId } from '../../hooks/useTeamChat'
import type { ConversationSummary } from '../../lib/team-chat-api'
import { conversationHref } from './ConversationRows'
import { NewChannelForm } from './NewChannelForm'
import { NEW_CONVERSATION_TITLES, type NewConversationMode } from './NewConversationModal'
import { NewMessagePicker } from './NewMessagePicker'

export function parseNewConversationMode(value: string | string[] | undefined): NewConversationMode {
  const mode = Array.isArray(value) ? value[0] : value
  return mode === 'channel' || mode === 'agent' ? mode : 'message'
}

export function NewConversationScreen({ mode }: { mode: NewConversationMode }) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const workspaceId: string | null = experience.kind === 'team' ? workspace?.id ?? null : null
  const me = useMyUserId()
  const mentionables = useMentionables(workspaceId)

  const goBack = () => {
    if (router.canGoBack()) router.back()
    else router.replace('/(app)/c/dms' as any)
  }

  const created = (conversation: ConversationSummary) => {
    if (workspaceId) invalidateConversationList(workspaceId)
    // Replace, so Back from the new conversation returns to where "New message" was started.
    router.replace(conversationHref(conversation.id) as any)
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 8) }}
      testID="new-conversation-screen"
    >
      <View className="flex-row items-center px-2 py-2">
        <Pressable onPress={goBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8} className="h-11 w-11 items-center justify-center rounded-full active:bg-muted">
          <ChevronLeft size={24} className="text-foreground" />
        </Pressable>
        <Text className="ml-1 flex-1 text-lg font-semibold text-foreground" accessibilityRole="header">
          {NEW_CONVERSATION_TITLES[mode]}
        </Text>
      </View>

      <View className="min-h-0 flex-1 px-4 pt-1">
        {!workspaceId ? (
          experience.resolved ? (
            <Text className="mt-8 text-center text-sm text-muted-foreground">Team chat is available in team workspaces.</Text>
          ) : (
            <ActivityIndicator className="mt-8" />
          )
        ) : mode === 'channel' ? (
          <NewChannelForm workspaceId={workspaceId} autoFocus onCreated={created} />
        ) : (
          <NewMessagePicker
            workspaceId={workspaceId}
            mentionables={mentionables}
            me={me}
            initialFilter={mode === 'agent' ? 'agents' : 'all'}
            autoFocus
            className="min-h-0 flex-1"
            onCreated={created}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  )
}
