// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Account-link bridge for team chat on Microsoft Teams and Google Chat.
 * Same approach as `slack-link.tsx`: the chat app's button opens this page,
 * which signs the user in on the frontend's own origin and then calls
 * POST /api/chat-providers/link with the signed state.
 */

import { useEffect, useRef, useState } from 'react'
import { View, Text, ActivityIndicator, Platform } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Button } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../contexts/auth'
import { DomainProvider, useDomainHttp } from '../../contexts/domain'

type Status = 'checking-auth' | 'redirect-signin' | 'linking' | 'linked' | 'error'

const PROVIDER_LABELS: Record<string, string> = { teams: 'Microsoft Teams', google_chat: 'Google Chat', slack: 'Slack' }

function ChatLinkBridge() {
  const router = useRouter()
  const params = useLocalSearchParams<{ state?: string }>()
  const { isLoading: isAuthLoading, isAuthenticated } = useAuth()
  const http = useDomainHttp()

  const [status, setStatus] = useState<Status>('checking-auth')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ provider: string; resumed: boolean } | null>(null)
  const linkedRef = useRef(false)

  const state = typeof params.state === 'string' ? params.state : ''

  useEffect(() => {
    if (Platform.OS !== 'web') {
      setStatus('error')
      setError('This sign-in bridge is only available on web.')
      return
    }
    if (isAuthLoading) return
    if (!isAuthenticated) {
      setStatus('redirect-signin')
      const full = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/auth/chat-link'
      router.replace({ pathname: '/(auth)/sign-in', params: { next: full } } as any)
      return
    }
    if (!state) {
      setStatus('error')
      setError('Missing state parameter. Please use the link button in chat again.')
      return
    }
    if (linkedRef.current) return
    linkedRef.current = true
    setStatus('linking')
    ;(async () => {
      try {
        const res = await http.post<{ ok: boolean; provider: string; resumed?: boolean }>('/api/chat-providers/link', { state })
        if (!res.data?.ok) throw new Error('Failed to link your Shogo account.')
        setResult({ provider: res.data.provider, resumed: !!res.data.resumed })
        setStatus('linked')
      } catch (err: any) {
        linkedRef.current = false
        setStatus('error')
        setError(err?.data?.error?.message || err?.message || 'Failed to link your Shogo account. Please try again.')
      }
    })()
  }, [isAuthLoading, isAuthenticated, state, http, router])

  const surface = result ? PROVIDER_LABELS[result.provider] ?? 'chat' : 'chat'

  return (
    <View className="flex-1 bg-background items-center justify-center px-6">
      <View className="max-w-md w-full gap-4 items-center">
        <Text className="text-2xl font-bold text-foreground">Link your Shogo account</Text>

        {(status === 'checking-auth' || status === 'linking') && (
          <>
            <ActivityIndicator />
            <Text className="text-sm text-muted-foreground text-center">
              {status === 'linking' ? 'Linking your Shogo account...' : 'Checking your session...'}
            </Text>
          </>
        )}

        {status === 'redirect-signin' && (
          <Text className="text-sm text-muted-foreground text-center">Redirecting you to sign in...</Text>
        )}

        {status === 'linked' && (
          <View className="gap-2 items-center w-full">
            <Text className="text-base font-semibold text-foreground text-center">✓ Account linked</Text>
            <Text className="text-sm text-muted-foreground text-center">
              {result?.resumed
                ? `Return to ${surface} — I\u2019m picking up where you left off.`
                : `Return to ${surface} and send your message again.`}
            </Text>
          </View>
        )}

        {status === 'error' && (
          <View className="gap-3 items-center w-full">
            <Text className="text-sm text-destructive text-center">{error || 'Something went wrong.'}</Text>
            <Button
              variant="outline"
              onPress={() => {
                linkedRef.current = false
                setStatus('checking-auth')
                setError(null)
              }}
              className="w-full"
            >
              Try Again
            </Button>
          </View>
        )}
      </View>
    </View>
  )
}

export default function ChatLinkBridgeRoute() {
  return (
    <DomainProvider>
      <ChatLinkBridge />
    </DomainProvider>
  )
}
