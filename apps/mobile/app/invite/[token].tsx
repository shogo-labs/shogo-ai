// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Invite-link acceptance route: `/invite/<token>`.
 *
 * In-app handler for the `acceptUrl` built by the invite-link flow
 * (apps/api/src/server.ts -> `${baseUrl}/invite/${link.token}`). Because the
 * link points at this same app's origin, it always resolves — no more Expo
 * "Unmatched Route" 404.
 *
 * Flow:
 *   1. GET  /api/invite-links/<token>/info   (public-ish, minimal auth)
 *   2. Signed out -> bounce through /sign-in?next=/invite/<token>
 *   3. Signed in  -> POST /api/invite-links/<token>/accept, then land at `/`
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Users, CheckCircle2, AlertTriangle } from 'lucide-react-native'
import { Button } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../contexts/auth'
import { API_URL } from '../../lib/api'

const ACTIVITY_ON_BRAND = '#ffffff'

interface LinkInfo {
  role: string
  projectName?: string
  workspaceName?: string
  expired: boolean
}

export default function InviteAcceptScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ token?: string }>()
  const token = useMemo(() => {
    const t = params.token
    if (typeof t === 'string') return t
    if (Array.isArray(t)) return t[0]
    return undefined
  }, [params.token])

  const { user, isAuthenticated, isLoading: authLoading } = useAuth()

  const [info, setInfo] = useState<LinkInfo | null>(null)
  const [isLoadingInfo, setIsLoadingInfo] = useState(true)
  const [isAccepting, setIsAccepting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [accepted, setAccepted] = useState(false)

  useEffect(() => {
    if (!token) {
      setError('Invalid invite link')
      setIsLoadingInfo(false)
      return
    }
    let cancelled = false
    setIsLoadingInfo(true)
    fetch(`${API_URL}/api/invite-links/${token}/info`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data: { ok?: boolean; data?: LinkInfo; error?: string }) => {
        if (cancelled) return
        if (data.ok && data.data) setInfo(data.data)
        else setError(data.error || 'Invalid invite link')
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load invite link')
      })
      .finally(() => {
        if (!cancelled) setIsLoadingInfo(false)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const handleAccept = useCallback(async () => {
    if (!token || !user?.id) return
    setIsAccepting(true)
    setError(null)
    try {
      const res = await fetch(`${API_URL}/api/invite-links/${token}/accept`, {
        method: 'POST',
        credentials: 'include',
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (data.ok) {
        setAccepted(true)
        setTimeout(() => router.replace('/'), 1500)
      } else {
        setError(data.error || 'Failed to accept invite')
      }
    } catch {
      setError('Failed to accept invite')
    } finally {
      setIsAccepting(false)
    }
  }, [token, user?.id, router])

  const goToSignIn = useCallback(() => {
    router.replace({
      pathname: '/(auth)/sign-in',
      params: { next: `/invite/${token}` },
    } as never)
  }, [router, token])

  if (authLoading || isLoadingInfo) {
    return (
      <SafeAreaView className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
      </SafeAreaView>
    )
  }

  if (error && !info) {
    return (
      <SafeAreaView className="flex-1 bg-background items-center justify-center px-6">
        <View className="items-center max-w-sm w-full" style={{ gap: 16 }}>
          <AlertTriangle size={48} className="text-destructive" />
          <Text className="text-xl font-semibold text-foreground text-center">Invalid Invite Link</Text>
          <Text className="text-muted-foreground text-center">{error}</Text>
          <Button className="w-full" onPress={() => router.replace('/')}>
            Go to Dashboard
          </Button>
        </View>
      </SafeAreaView>
    )
  }

  if (accepted) {
    return (
      <SafeAreaView className="flex-1 bg-background items-center justify-center px-6">
        <View className="items-center max-w-sm w-full" style={{ gap: 16 }}>
          <CheckCircle2 size={48} className="text-green-500" />
          <Text className="text-xl font-semibold text-foreground text-center">You're in!</Text>
          <Text className="text-muted-foreground text-center">
            You've joined {info?.projectName || info?.workspaceName}. Redirecting…
          </Text>
        </View>
      </SafeAreaView>
    )
  }

  const resourceName = info?.projectName || info?.workspaceName || 'this project'
  const roleLabel = info?.role === 'member' ? 'an Editor' : `a ${info?.role}`

  return (
    <SafeAreaView className="flex-1 bg-background items-center justify-center px-6">
      <View className="w-full max-w-sm rounded-xl border border-border bg-card p-8 items-center" style={{ gap: 24 }}>
        <View className="h-16 w-16 rounded-full bg-primary/10 items-center justify-center">
          <Users size={32} className="text-primary" />
        </View>

        <View className="items-center" style={{ gap: 8 }}>
          <Text className="text-xl font-semibold text-foreground text-center">You've been invited</Text>
          <Text className="text-muted-foreground text-center">
            Join <Text className="font-semibold text-foreground">{resourceName}</Text> as {roleLabel}
          </Text>
        </View>

        {info?.expired ? (
          <Text className="text-destructive text-sm text-center">This invite link has expired.</Text>
        ) : !isAuthenticated ? (
          <View className="w-full" style={{ gap: 12 }}>
            <Text className="text-sm text-muted-foreground text-center">Sign in to accept this invitation</Text>
            <Button className="w-full" onPress={goToSignIn}>
              Sign In
            </Button>
          </View>
        ) : (
          <View className="w-full" style={{ gap: 12 }}>
            {error ? <Text className="text-sm text-destructive text-center">{error}</Text> : null}
            <Button className="w-full" onPress={handleAccept} disabled={isAccepting}>
              {isAccepting ? <ActivityIndicator color={ACTIVITY_ON_BRAND} /> : 'Accept Invitation'}
            </Button>
            <Button variant="ghost" className="w-full" onPress={() => router.replace('/')}>
              Decline
            </Button>
          </View>
        )}
      </View>
    </SafeAreaView>
  )
}
