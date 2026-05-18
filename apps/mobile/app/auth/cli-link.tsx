// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Device Cloud-Login Bridge Page — used by both Shogo Desktop
 * (Electron `runCloudSignIn` in `apps/desktop/src/main.ts`) and the
 * Shogo CLI worker (`shogo login` in
 * `packages/shogo-worker/src/lib/cloud-login.ts`). Both clients drive
 * the same poll-based device-code handshake; the only difference is
 * the `client=desktop|cli` URL hint that tweaks the heading copy.
 *
 * The page route is `/auth/cli-link` for backward compat with the
 * earliest CLI-only revision; treat it as the generic device bridge.
 *
 * Mints a key and POSTs it back to `/api/cli/login/approve` so a
 * polling client can pick it up. No protocol handler / no localhost
 * listener required — works behind firewalls, over SSH, on devboxes,
 * and inside sandboxed Electron processes alike.
 *
 * Flow:
 *   1. Client runs `shogo login` (CLI) or clicks "Sign in" (desktop) →
 *      POSTs /api/cli/login/start with device metadata; cloud creates
 *      a pending state and returns
 *      `<cloudUrl>/auth/cli-link?state=...&userCode=...&client=...`.
 *   2. Client opens that URL in the user's default browser.
 *   3. This page:
 *        - Checks Better Auth session (redirects to /sign-in if needed,
 *          preserving the URL so we land back here on success).
 *        - Calls GET /api/cli/login/state to load the user code +
 *          device metadata so the user can verify what they're approving.
 *        - Lets the user pick a workspace (auto-skips if pre-selected
 *          or only one).
 *        - On Approve → POST /api/cli/login/approve → cloud mints the
 *          device-tagged API key and pins it to the state.
 *        - Shows a "you can close this tab" confirmation. The waiting
 *          client picks up the key on its next poll tick.
 *
 * Single security check that matters: `state` is a 16-byte random
 * nonce we never display to the user — anyone with the URL effectively
 * controls the pending session, so the only way to get it is to be on
 * the machine that initiated the flow. The 6-char userCode IS shown as
 * a cross-check so the human can confirm the device matches the
 * terminal/desktop window they started the sign-in from.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { View, Text, ActivityIndicator, Platform, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Button, cn } from '@shogo/shared-ui/primitives'
import { type WorkspaceSummary, PlatformApi } from '@shogo-ai/sdk'
import { useAuth } from '../../contexts/auth'
import { useDomainHttp } from '../../contexts/domain'

interface CliLinkParams {
  state?: string
  userCode?: string
  deviceId?: string
  deviceName?: string
  devicePlatform?: string
  appVersion?: string
  workspaceId?: string
  /** "desktop" | "cli" — chooses the heading copy. Echoed by /state too. */
  client?: string
}

type Status =
  | 'checking-auth'
  | 'redirect-signin'
  | 'loading-state'
  | 'loading-workspaces'
  | 'picking-workspace'
  | 'approving'
  | 'approved'
  | 'denied'
  | 'error'

interface CliPendingState {
  ok: boolean
  status: 'pending' | 'approved' | 'denied' | 'expired'
  userCode: string
  client: 'desktop' | 'cli'
  deviceId: string
  deviceName: string
  devicePlatform?: string
  deviceAppVersion?: string
  preselectedWorkspaceId?: string
}

export default function CliLinkBridge() {
  const router = useRouter()
  const params = useLocalSearchParams<CliLinkParams>()
  const { isLoading: isAuthLoading, isAuthenticated } = useAuth()
  const http = useDomainHttp()
  const platform = useMemo(() => new PlatformApi(http), [http])

  const [status, setStatus] = useState<Status>('checking-auth')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<CliPendingState | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const approvedRef = useRef(false)
  const stateLoadedRef = useRef(false)
  const workspacesLoadedRef = useRef(false)

  const state = typeof params.state === 'string' ? params.state : ''
  // Effective client label — query string is the first source so the
  // page can render the right heading even before /state fetches.
  const clientHint: 'desktop' | 'cli' =
    pending?.client ??
    (params.client === 'desktop' ? 'desktop' : params.client === 'cli' ? 'cli' : 'cli')
  const clientLabel = clientHint === 'desktop' ? 'Shogo Desktop' : 'Shogo CLI'

  const approve = useCallback(
    async (workspaceId: string | undefined) => {
      if (approvedRef.current) return
      approvedRef.current = true
      setStatus('approving')
      try {
        const res = await http.request<{ ok: boolean; error?: string; workspace?: string | null; email?: string | null }>(
          '/api/cli/login/approve',
          { method: 'POST', body: { state, workspaceId } },
        )
        if (!res.data?.ok) {
          throw new Error(res.data?.error || `Approve failed (HTTP ${res.status})`)
        }
        setStatus('approved')
      } catch (err) {
        approvedRef.current = false
        setStatus('error')
        setError(
          err instanceof Error ? err.message : 'Failed to approve sign-in. Please try again.',
        )
      }
    },
    [http, state],
  )

  const deny = useCallback(async () => {
    try {
      await http.request('/api/cli/login/deny', { method: 'POST', body: { state } })
    } catch {
      /* best-effort — the state will TTL out anyway */
    }
    setStatus('denied')
  }, [http, state])

  // Phase 1: auth + state lookup
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
          : '/auth/cli-link'
      router.replace({ pathname: '/(auth)/sign-in', params: { next: full } } as any)
      return
    }

    if (!state) {
      setStatus('error')
      setError(
        clientHint === 'desktop'
          ? 'Missing state parameter. Please restart sign-in from the desktop app.'
          : 'Missing state parameter. Please rerun `shogo login` in your terminal.',
      )
      return
    }

    if (stateLoadedRef.current) return
    stateLoadedRef.current = true
    setStatus('loading-state')
    ;(async () => {
      try {
        const res = await http.get<CliPendingState>(`/api/cli/login/state`, { state })
        if (!res.data?.ok) {
          throw new Error(
            clientHint === 'desktop'
              ? 'Sign-in request not found or expired. Please restart sign-in from the desktop app.'
              : 'Sign-in request not found or expired. Please rerun `shogo login`.',
          )
        }
        if (res.data.status !== 'pending') {
          if (res.data.status === 'approved') setStatus('approved')
          else if (res.data.status === 'denied') setStatus('denied')
          else setStatus('error'), setError('Sign-in request expired.')
          setPending(res.data)
          return
        }
        setPending(res.data)
      } catch (err) {
        stateLoadedRef.current = false
        setStatus('error')
        setError(
          err instanceof Error ? err.message : 'Failed to load sign-in request.',
        )
      }
    })()
  }, [isAuthLoading, isAuthenticated, state, http, router])

  // Phase 2: workspace fetch + auto-approve when applicable
  useEffect(() => {
    if (!pending || pending.status !== 'pending') return
    if (workspacesLoadedRef.current) return
    workspacesLoadedRef.current = true

    setStatus('loading-workspaces')
    ;(async () => {
      try {
        const list = await platform.listMyWorkspaces()
        setWorkspaces(list)
        if (list.length === 0) {
          setStatus('error')
          setError('Your account has no workspaces. Create one in Shogo Cloud first.')
          return
        }

        const preselected = pending.preselectedWorkspaceId
          ? list.find((w) => w.id === pending.preselectedWorkspaceId)
          : null
        if (preselected) {
          await approve(preselected.id)
          return
        }
        if (list.length === 1) {
          // Show the picker anyway so the user always confirms — CLI
          // sign-in is more sensitive than desktop (server-side device,
          // long-lived). One click costs nothing.
          setSelectedWorkspaceId(list[0].id)
          setStatus('picking-workspace')
          return
        }

        setSelectedWorkspaceId(list[0].id)
        setStatus('picking-workspace')
      } catch (err) {
        workspacesLoadedRef.current = false
        setStatus('error')
        setError(
          err instanceof Error ? err.message : 'Failed to load your workspaces.',
        )
      }
    })()
  }, [pending, platform, approve])

  return (
    <View className="flex-1 bg-background items-center justify-center px-6">
      <View className="max-w-md w-full gap-4 items-center">
        <Text className="text-2xl font-bold text-foreground">Approve {clientLabel} sign-in</Text>

        {pending && (
          <View className="gap-1 w-full">
            <Text className="text-xs uppercase tracking-wider text-muted-foreground text-center">
              Verification code
            </Text>
            <Text className="text-3xl font-mono font-semibold text-foreground text-center tracking-widest">
              {pending.userCode}
            </Text>
            <Text className="text-xs text-muted-foreground text-center">
              This must match the code your terminal printed.
            </Text>
            <Text className="text-xs text-muted-foreground text-center mt-2">
              Device: {pending.deviceName}
              {pending.devicePlatform ? ` · ${pending.devicePlatform}` : ''}
            </Text>
          </View>
        )}

        {status === 'checking-auth' && (
          <>
            <ActivityIndicator />
            <Text className="text-sm text-muted-foreground text-center">Checking your session...</Text>
          </>
        )}

        {status === 'redirect-signin' && (
          <Text className="text-sm text-muted-foreground text-center">Redirecting you to sign in...</Text>
        )}

        {(status === 'loading-state' || status === 'loading-workspaces') && (
          <>
            <ActivityIndicator />
            <Text className="text-sm text-muted-foreground text-center">
              {status === 'loading-state' ? 'Loading sign-in request...' : 'Loading your workspaces...'}
            </Text>
          </>
        )}

        {status === 'picking-workspace' && (
          <View className="gap-3 w-full">
            <Text className="text-sm text-muted-foreground text-center">
              {clientHint === 'desktop'
                ? 'Choose which workspace this device should sign into. You can switch later from the desktop app\u2019s General settings.'
                : 'Choose which workspace this CLI session should act in. Keys are scoped to a single workspace; rerun `shogo login` to switch.'}
            </Text>
            <View className="gap-2 w-full">
              {workspaces.map((ws) => {
                const isSelected = selectedWorkspaceId === ws.id
                return (
                  <Pressable
                    key={ws.id}
                    onPress={() => setSelectedWorkspaceId(ws.id)}
                    className={cn(
                      'flex-row items-center gap-3 px-4 py-3 rounded-lg border',
                      isSelected ? 'border-primary bg-primary/5' : 'border-border',
                    )}
                  >
                    <View
                      className={cn(
                        'w-4 h-4 rounded-full border-2',
                        isSelected ? 'border-primary bg-primary' : 'border-muted-foreground',
                      )}
                    />
                    <View className="flex-1">
                      <Text className="font-medium text-foreground">{ws.name}</Text>
                      <Text className="text-xs text-muted-foreground">{ws.slug}</Text>
                    </View>
                  </Pressable>
                )
              })}
            </View>
            <View className="flex-row gap-2 w-full">
              <Button
                variant="outline"
                onPress={() => void deny()}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                onPress={() => {
                  if (selectedWorkspaceId) void approve(selectedWorkspaceId)
                }}
                disabled={!selectedWorkspaceId}
                className="flex-1"
              >
                Approve
              </Button>
            </View>
          </View>
        )}

        {status === 'approving' && (
          <>
            <ActivityIndicator />
            <Text className="text-sm text-muted-foreground text-center">
              Authorizing your sign-in...
            </Text>
          </>
        )}

        {status === 'approved' && (
          <View className="gap-2 items-center w-full">
            <Text className="text-base font-semibold text-foreground text-center">
              ✓ Signed in
            </Text>
            <Text className="text-sm text-muted-foreground text-center">
              {clientHint === 'desktop'
                ? 'Your desktop app should pick up the new credentials within a few seconds. You can close this tab.'
                : 'Your terminal should pick up the new credentials within a few seconds. You can close this tab.'}
            </Text>
          </View>
        )}

        {status === 'denied' && (
          <View className="gap-2 items-center w-full">
            <Text className="text-base font-semibold text-foreground text-center">
              Sign-in denied
            </Text>
            <Text className="text-sm text-muted-foreground text-center">
              No credentials were issued. You can close this tab.
            </Text>
          </View>
        )}

        {status === 'error' && (
          <View className="gap-3 items-center w-full">
            <Text className="text-sm text-destructive text-center">
              {error || 'Something went wrong.'}
            </Text>
            <Button
              variant="outline"
              onPress={() => {
                approvedRef.current = false
                stateLoadedRef.current = false
                workspacesLoadedRef.current = false
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
