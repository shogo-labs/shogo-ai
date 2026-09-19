// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useAuth } from '../../contexts/auth'
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
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
    const nonce = Date.now()
    setPrefillRequest({
      nonce,
      content: 'I want to change your avatar to ',
    })
    // Let ChatInput consume the controlled draft, then return control to
    // ChatPanel so its normal inline-edit draft restoration remains intact.
    setTimeout(() => {
      setPrefillRequest((current) => (current?.nonce === nonce ? null : current))
    }, 100)
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
          personalMode
          prefillRequest={prefillRequest}
          className="flex-1"
          isActive
        />
      </View>
    </View>
  )
})
