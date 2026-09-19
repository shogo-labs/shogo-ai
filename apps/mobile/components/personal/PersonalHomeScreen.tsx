// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useAuth } from '../../contexts/auth'
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import { clearChatPrefill, useChatPrefill } from '../../hooks/useChatPrefill'
import {
  api,
  type PersonalAgentProfile,
} from '../../lib/api'
import { ChatPanel } from '../chat/ChatPanel'
import type { RestoreDraftRequest } from '../chat/ChatInput'
import { PersonalAgentHeader } from './PersonalAgentHeader'
import { useWelcomeMessage } from './useWelcomeMessage'
import { buildDefaultProfileActions, ProfileActionSheet } from './ProfileActionSheet'
import { Sparkles, X } from 'lucide-react-native'

export const PersonalHomeScreen = observer(function PersonalHomeScreen() {
  const router = useRouter()
  const { user } = useAuth()
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const [profile, setProfile] = useState<PersonalAgentProfile | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [prefillRequest, setPrefillRequest] = useState<RestoreDraftRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showProfileSheet, setShowProfileSheet] = useState(false)
  const crossTabPrefill = useChatPrefill()
  const { showWelcome, dismissWelcome } = useWelcomeMessage(workspace?.id)

  const loadPersonalShell = useCallback(async () => {
    if (!workspace?.id) return
    try {
      setError(null)
      const [nextProfile, session] = await Promise.all([
        api.getAgentProfile(http, workspace.id),
        api.getPrimaryWorkspaceSession(http, workspace.id),
      ])
      setProfile(nextProfile)
      setSessionId(session.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load your companion')
    }
  }, [http, workspace?.id])

  useEffect(() => {
    void loadPersonalShell()
  }, [loadPersonalShell])

  // Adopt a cross-tab prefill (e.g. tapping a "Needs your OK" card from
  // Goals/Activity) into local state so it flows through the same
  // nonce-based restore/consume path as the avatar-change prefill below,
  // then immediately clear the shared mailbox — local state now owns it.
  useEffect(() => {
    if (!crossTabPrefill) return
    setPrefillRequest(crossTabPrefill)
    clearChatPrefill(crossTabPrefill.nonce)
  }, [crossTabPrefill])

  const prefill = useCallback((content: string) => {
    setPrefillRequest({ nonce: Date.now(), content })
  }, [])

  // Return control to ChatPanel's own draft restoration once ChatInput has
  // actually applied our prefill — not on a fixed-delay timer, which could
  // clear the request before ChatInput read it (dropped prefill) or after
  // ChatInput moved on to something else (clobbering unrelated state).
  const handlePrefillConsumed = useCallback((nonce: number) => {
    setPrefillRequest((current) => (current?.nonce === nonce ? null : current))
  }, [])

  if (!workspace?.id || !profile || !sessionId) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        {error ? (
          <>
            <Text className="text-center text-sm text-destructive">{error}</Text>
            <Text className="mt-2 text-center text-xs text-muted-foreground">
              Pull to refresh or reopen your personal workspace.
            </Text>
          </>
        ) : (
          <>
            <ActivityIndicator />
            <Text className="mt-3 text-sm text-muted-foreground">Preparing your companion…</Text>
          </>
        )}
      </View>
    )
  }

  const profileActions = buildDefaultProfileActions({
    agentName: profile.name,
    onPrefill: prefill,
    onOpenActivity: () => router.push('/(app)/activity' as any),
    onOpenSideChats: () => router.push('/(app)/side-chats' as any),
  })

  return (
    <View className="flex-1 bg-background">
      <PersonalAgentHeader profile={profile} onProfilePress={() => setShowProfileSheet(true)} />
      {showWelcome ? (
        <View className="mx-auto mt-3 w-full max-w-2xl px-4">
          <View className="flex-row items-start gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-4">
            <Sparkles size={18} className="mt-0.5 text-primary" />
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-semibold text-foreground">
                Hi, I'm {profile.name}.
              </Text>
              <Text className="mt-1 text-sm leading-5 text-muted-foreground">
                Tell me about something you want to keep track of — a habit, a project,
                a trip — and I'll turn it into a goal, check in on it, and let you know
                before I do anything that needs your OK.
              </Text>
            </View>
            <Pressable
              onPress={dismissWelcome}
              accessibilityLabel="Dismiss welcome message"
              className="h-7 w-7 items-center justify-center rounded-full active:bg-primary/10"
            >
              <X size={15} className="text-muted-foreground" />
            </Pressable>
          </View>
        </View>
      ) : null}
      <View className="min-h-0 flex-1">
        <ChatPanel
          featureId={null}
          featureName={profile.name}
          phase={null}
          workspaceId={workspace.id}
          userId={user?.id}
          chatScope="workspace"
          chatSessionId={sessionId}
          onChatSessionChange={setSessionId}
          composer={experience.composer}
          prefillRequest={prefillRequest}
          onPrefillConsumed={handlePrefillConsumed}
          className="flex-1"
          isActive
        />
      </View>
      <ProfileActionSheet
        visible={showProfileSheet}
        onClose={() => setShowProfileSheet(false)}
        title={profile.name}
        subtitle={profile.tagline || undefined}
        actions={profileActions}
      />
    </View>
  )
})
