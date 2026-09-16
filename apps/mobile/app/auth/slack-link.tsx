// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Slack Account-Link Bridge Page — mirrors `/auth/cli-link.tsx`'s pattern
 * for exactly the same reason.
 *
 * The "Link Shogo account" button Shogo posts in Slack
 * (`sendAccountLinkPrompt` in `apps/api/src/routes/slack-agent.ts`) has to
 * point at a URL Slack can open from *any* device, i.e. the API's public
 * host (an ngrok tunnel in local dev, `api.<domain>` in prod). That host is
 * a different browser cookie origin than wherever the user's Shogo session
 * actually lives — a direct link to the API can never carry a session
 * cookie back, so a plain "redirect here, then to /sign-in, then back"
 * dance can loop forever without ever completing (this bit engineers in
 * local dev before this page existed: the API kept redirecting to
 * `/sign-in`, the user kept signing in, and it kept redirecting again).
 *
 * This page sidesteps the cross-origin-cookie problem entirely by doing
 * the authenticated call *from the frontend's own origin* via the SDK's
 * `HttpClient` (which targets `API_URL` with same-origin/credentialed
 * fetch), instead of having the browser navigate to the API's public host
 * at all:
 *   1. Checks the Better Auth session (redirects to /sign-in if needed,
 *      preserving this URL so we land back here on success).
 *   2. Calls GET /api/integrations/slack/link?state=... — the API verifies
 *      the signed state, links the account, confirms in Slack, and resumes
 *      whatever request triggered the link (if any).
 *   3. Shows a brief "✓ Account linked" confirmation, then auto-navigates
 *      to Settings → Integrations so the user lands somewhere that
 *      visibly proves the link worked (green "Active" status + the Slack
 *      project list), instead of stranding them on a blank bridge page —
 *      see `?slackLinked=1` handling in `IntegrationsTab.tsx`, which pops
 *      open the "Manage projects" modal with a success banner.
 */

import { useEffect, useRef, useState } from 'react'
import { View, Text, ActivityIndicator, Platform } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Button } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../contexts/auth'
import { useDomainHttp } from '../../contexts/domain'

/** Long enough to read "✓ Account linked", short enough not to feel stuck. */
const REDIRECT_TO_SETTINGS_DELAY_MS = 1200

interface SlackLinkParams {
  state?: string
}

type Status = 'checking-auth' | 'redirect-signin' | 'linking' | 'linked' | 'error'

export default function SlackLinkBridge() {
  const router = useRouter()
  const params = useLocalSearchParams<SlackLinkParams>()
  const { isLoading: isAuthLoading, isAuthenticated } = useAuth()
  const http = useDomainHttp()

  const [status, setStatus] = useState<Status>('checking-auth')
  const [error, setError] = useState<string | null>(null)
  const [resumed, setResumed] = useState(false)
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
      const full =
        typeof window !== 'undefined'
          ? window.location.pathname + window.location.search
          : '/auth/slack-link'
      router.replace({ pathname: '/(auth)/sign-in', params: { next: full } } as any)
      return
    }

    if (!state) {
      setStatus('error')
      setError('Missing state parameter. Please click the link button in Slack again.')
      return
    }

    if (linkedRef.current) return
    linkedRef.current = true
    setStatus('linking')
    ;(async () => {
      try {
        const res = await http.get<{ ok: boolean; resumed?: boolean; error?: string }>(
          '/api/integrations/slack/link',
          { state },
        )
        if (!res.data?.ok) {
          throw new Error(res.data?.error || 'Failed to link your Shogo account.')
        }
        setResumed(!!res.data.resumed)
        setStatus('linked')
        // Land the user in Settings → Integrations, with the Slack project
        // manager already open, instead of leaving them on a blank tab with
        // just a sentence of text — see IntegrationsTab.tsx's handling of
        // `slackLinked=1` for the modal + success banner.
        setTimeout(() => {
          router.replace('/(app)/settings?tab=integrations&slackLinked=1' as any)
        }, REDIRECT_TO_SETTINGS_DELAY_MS)
      } catch (err) {
        linkedRef.current = false
        setStatus('error')
        setError(
          err instanceof Error ? err.message : 'Failed to link your Shogo account. Please try again.',
        )
      }
    })()
  }, [isAuthLoading, isAuthenticated, state, http, router])

  return (
    <View className="flex-1 bg-background items-center justify-center px-6">
      <View className="max-w-md w-full gap-4 items-center">
        <Text className="text-2xl font-bold text-foreground">Link your Shogo account</Text>

        {status === 'checking-auth' && (
          <>
            <ActivityIndicator />
            <Text className="text-sm text-muted-foreground text-center">Checking your session...</Text>
          </>
        )}

        {status === 'redirect-signin' && (
          <Text className="text-sm text-muted-foreground text-center">Redirecting you to sign in...</Text>
        )}

        {status === 'linking' && (
          <>
            <ActivityIndicator />
            <Text className="text-sm text-muted-foreground text-center">Linking your Shogo account...</Text>
          </>
        )}

        {status === 'linked' && (
          <View className="gap-2 items-center w-full">
            <Text className="text-base font-semibold text-foreground text-center">✓ Account linked</Text>
            <Text className="text-sm text-muted-foreground text-center">
              {resumed
                ? 'Return to Slack — I\u2019m picking up where you left off.'
                : 'Return to Slack and send your request again.'}
            </Text>
            <View className="flex-row items-center gap-2 mt-1">
              <ActivityIndicator size="small" />
              <Text className="text-xs text-muted-foreground">Opening your Slack settings…</Text>
            </View>
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
