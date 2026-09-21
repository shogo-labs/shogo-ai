// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A single side chat: the same workspace-scoped `ChatPanel` the primary
 * companion chat uses (same merged-root runtime, same tools), just pointed
 * at a non-primary `ChatSession`. See `SideChatsScreen` for the list this
 * is opened from.
 */
import { useCallback, useState } from 'react'
import { Platform, Pressable, Text, View, useWindowDimensions } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { ArrowLeft } from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import { ChatPanel } from '../chat/ChatPanel'
import { NativePhoneSheet } from '../phone/NativePhoneSheet'
import { WEB_WIDE_MIN_WIDTH } from '../../lib/native-phone-layout'
import { useWorkspaceSessionScope } from '../workspace/useWorkspaceSessionScope'

export const SideChatScreen = observer(function SideChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { user } = useAuth()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const { width } = useWindowDimensions()
  const isWide = Platform.OS === 'web' && width >= WEB_WIDE_MIN_WIDTH
  const workspaceId = workspace?.id
  const [scopeSheetOpen, setScopeSheetOpen] = useState(false)
  const scope = useWorkspaceSessionScope(workspaceId, id)

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace('/(app)/side-chats' as any)
  }, [router])

  if (!workspaceId || !id) return null

  return (
    <View className="flex-1 bg-background">
      {isWide ? (
        <View className="flex-row items-center gap-2 border-b border-border px-4 py-4">
          <Pressable onPress={goBack} accessibilityLabel="Back" className="-ml-2 rounded-md p-2 active:bg-muted">
            <ArrowLeft size={22} className="text-foreground" />
          </Pressable>
          <Text className="flex-1 text-lg font-semibold text-foreground" numberOfLines={1}>
            Side chat
          </Text>
        </View>
      ) : null}
      {scope.attachments.length > 0 ? (
        <View className="flex-row items-center gap-2 border-b border-border/60 px-4 py-2">
          <Text className="text-xs font-medium text-muted-foreground">Working set</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Manage project scope"
            onPress={() => setScopeSheetOpen(true)}
            className="max-w-[180px] rounded-full border border-border bg-card px-2.5 py-1 active:bg-muted"
          >
            <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
              {scope.projectName(scope.focusedProjectId ?? scope.attachments[0].projectId)}
            </Text>
          </Pressable>
          {scope.attachments.length > 1 ? <Text className="text-xs text-muted-foreground">+{scope.attachments.length - 1}</Text> : null}
        </View>
      ) : null}
      <View className="min-h-0 flex-1">
        <ChatPanel
          featureId={null}
          featureName="Side chat"
          phase={null}
          workspaceId={workspaceId}
          userId={user?.id}
          chatScope="workspace"
          chatSessionId={id}
          onChatSessionChange={() => {}}
          composer={experience.composer}
          presentation="agent"
          className="flex-1"
          isActive
        />
      </View>
      <NativePhoneSheet
        visible={scopeSheetOpen}
        onClose={() => setScopeSheetOpen(false)}
        title="Project scope"
        subtitle="Choose what this side chat can use"
        scroll
        draggable
        keyboardBehavior="scroll"
      >
        <View className="gap-2 px-4 pb-6 pt-2">
          {scope.attachments.map((attachment) => {
            const focused = attachment.projectId === scope.focusedProjectId
            const busy = scope.busyProjectId === attachment.projectId
            return (
              <View key={attachment.id} className="rounded-xl border border-border bg-background p-3">
                <Pressable
                  onPress={() => scope.setFocusedProjectId(attachment.projectId)}
                  accessibilityRole="button"
                  accessibilityLabel={`Focus ${scope.projectName(attachment.projectId)} for the next prompt`}
                  className="flex-row items-center justify-between"
                >
                  <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground" numberOfLines={1}>
                    {scope.projectName(attachment.projectId)}
                  </Text>
                  {focused ? <Text className="ml-2 text-xs font-medium text-primary">Focused</Text> : null}
                </Pressable>
                <View className="mt-3 flex-row gap-2">
                  <Pressable
                    disabled={busy}
                    onPress={() => void scope.toggleProjectMode(attachment)}
                    className="rounded-lg border border-border px-2.5 py-1.5 disabled:opacity-50"
                  >
                    <Text className="text-xs text-foreground">
                      {attachment.attachMode === 'readonly' ? 'Read only' : 'Can edit'}
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={busy}
                    onPress={() => void scope.detachProject(attachment)}
                    className="rounded-lg px-2.5 py-1.5 active:bg-destructive/10 disabled:opacity-50"
                  >
                    <Text className="text-xs text-destructive">Detach</Text>
                  </Pressable>
                </View>
              </View>
            )
          })}
          <Text className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Add project</Text>
          {scope.attachableProjects.length > 0 ? scope.attachableProjects.map((project: any) => (
            <Pressable
              key={project.id}
              disabled={scope.busyProjectId !== null}
              onPress={() => void scope.attachProject(project.id)}
              className="rounded-xl border border-border bg-background px-3 py-3 active:bg-muted disabled:opacity-50"
            >
              <Text className="text-sm font-medium text-foreground" numberOfLines={1}>{project.name || 'Untitled project'}</Text>
              <Text className="mt-0.5 text-xs text-muted-foreground">Attach with read and write</Text>
            </Pressable>
          )) : (
            <Text className="text-sm text-muted-foreground">Every accessible project is already attached.</Text>
          )}
          {scope.busyProjectId ? <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">Preparing project context…</Text> : null}
          {scope.error ? <Text accessibilityLiveRegion="polite" className="text-xs text-destructive">{scope.error}</Text> : null}
        </View>
      </NativePhoneSheet>
    </View>
  )
})
