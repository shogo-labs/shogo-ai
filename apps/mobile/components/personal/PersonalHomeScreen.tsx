// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useAuth } from '../../contexts/auth'
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import {
  api,
  type PersonalAgentProfile,
} from '../../lib/api'
import { ChatPanel } from '../chat/ChatPanel'
import type { RestoreDraftRequest } from '../chat/ChatInput'
import { PersonalAgentHeader } from './PersonalAgentHeader'

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

  const handleAvatarPress = useCallback(() => {
    setPrefillRequest({
      nonce: Date.now(),
      content: 'I want to change your avatar to ',
    })
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

  return (
    <View className="flex-1 bg-background">
      <PersonalAgentHeader
        profile={profile}
        onAvatarPress={handleAvatarPress}
        onActivityPress={() => router.push('/(app)/activity' as any)}
      />
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
    </View>
  )
})
