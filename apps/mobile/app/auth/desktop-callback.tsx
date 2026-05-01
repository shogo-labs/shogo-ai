// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local-dev landing page for the cloud→desktop auth handoff.
 *
 * Used only when SHOGO_AUTH_CALLBACK_URL is set to point here (e.g.
 * `http://localhost:8081/auth/desktop-callback`) — instead of redirecting
 * the browser straight to `shogo://auth-callback?...`, the cloud bridge
 * page lands here so we can:
 *
 *   1. Show the raw callback parameters (handy for debugging the flow).
 *   2. Forward to the real `shogo://auth-callback` deep link so the
 *      locally-running Electron app receives the key.
 *   3. POST the same payload to the local workspace API's
 *      `/api/local/cloud-login/complete` endpoint — the same call the
 *      Electron main process makes when it receives the deep link — so
 *      the local API ends up signed in without involving the desktop.
 *
 * This page is web-only — it's not wired into the native app navigation.
 */

import { useEffect, useMemo, useState } from 'react'
import { View, Text, Platform } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { Button } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../lib/api'

const AUTO_CLOSE_DELAY_MS = 2500

interface CallbackParams {
  state?: string
  key?: string
  email?: string
  workspace?: string
}

type LocalSignInStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'ok'; email?: string; workspace?: string }
  | { kind: 'error'; message: string }

export default function DesktopCallback() {
  const params = useLocalSearchParams<CallbackParams>()

  const state = typeof params.state === 'string' ? params.state : ''
  const key = typeof params.key === 'string' ? params.key : ''
  const email = typeof params.email === 'string' ? params.email : ''
  const workspace = typeof params.workspace === 'string' ? params.workspace : ''

  const [localStatus, setLocalStatus] = useState<LocalSignInStatus>({ kind: 'idle' })
  const [closeCountdown, setCloseCountdown] = useState<number | null>(null)

  const deepLinkUrl = useMemo(() => {
    if (!state || !key) return null
    const sp = new URLSearchParams({ state, key })
    if (email) sp.set('email', email)
    if (workspace) sp.set('workspace', workspace)
    return `shogo://auth-callback?${sp.toString()}`
  }, [state, key, email, workspace])

  const onForwardToDesktop = () => {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && deepLinkUrl) {
      window.location.href = deepLinkUrl
    }
  }

  const onSignInLocally = async () => {
    if (!state || !key) {
      setLocalStatus({ kind: 'error', message: 'Missing state or key in URL' })
      return
    }
    setLocalStatus({ kind: 'pending' })
    try {
      const res = await fetch(`${API_URL}/api/local/cloud-login/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, key, email, workspace }),
        credentials: Platform.OS === 'web' ? 'include' : 'omit',
      })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        email?: string
        workspace?: { id?: string; name?: string }
      }
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      setLocalStatus({
        kind: 'ok',
        email: body.email,
        workspace: body.workspace?.name,
      })
      setCloseCountdown(Math.ceil(AUTO_CLOSE_DELAY_MS / 1000))
    } catch (err) {
      setLocalStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  // After a successful local sign-in, auto-close this tab so the original
  // onboarding tab (which is polling cloud-login/status) is the only one
  // left. Falls back to the manual close button if window.close() is
  // refused — browsers only allow it for tabs they themselves opened.
  useEffect(() => {
    if (localStatus.kind !== 'ok' || closeCountdown === null) return
    if (closeCountdown <= 0) {
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        try {
          window.close()
        } catch {
          // Browser refused — leave the manual button visible.
        }
      }
      return
    }
    const t = setTimeout(() => setCloseCountdown((n) => (n === null ? null : n - 1)), 1000)
    return () => clearTimeout(t)
  }, [localStatus.kind, closeCountdown])

  const onCloseTab = () => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      try {
        window.close()
      } catch {
        // ignore
      }
    }
  }

  return (
    <View className="flex-1 bg-background items-center justify-center px-6">
      <View className="max-w-md w-full gap-4">
        <Text className="text-2xl font-bold text-foreground">
          Cloud sign-in callback
        </Text>
        <Text className="text-sm text-muted-foreground">
          The cloud has redirected you here instead of launching the desktop
          deep link directly. This is the local-dev equivalent of{' '}
          <Text className="font-mono">shogo://auth-callback</Text>.
        </Text>

        <View className="gap-2 rounded-md border border-border bg-card p-3">
          <ParamRow label="state" value={state || '(missing)'} />
          <ParamRow label="key" value={key || '(missing)'} />
          {email ? <ParamRow label="email" value={email} /> : null}
          {workspace ? <ParamRow label="workspace" value={workspace} /> : null}
        </View>

        {!state || !key ? (
          <Text className="text-sm text-destructive">
            Missing state or key in the callback URL — sign-in cannot complete.
          </Text>
        ) : (
          <View className="gap-2">
            <Button
              onPress={onSignInLocally}
              disabled={localStatus.kind === 'pending'}
              className="w-full"
            >
              {localStatus.kind === 'pending'
                ? 'Signing in to local API…'
                : `Sign in via local API (${API_URL})`}
            </Button>

            {deepLinkUrl ? (
              <Button
                onPress={onForwardToDesktop}
                variant="outline"
                className="w-full"
              >
                Forward to Shogo Desktop (shogo://)
              </Button>
            ) : null}
          </View>
        )}

        {localStatus.kind === 'ok' ? (
          <View className="gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">
            <Text className="text-sm font-semibold text-emerald-700">
              Local API signed in
            </Text>
            <Text className="text-xs text-emerald-700/80">
              {localStatus.email ? `${localStatus.email} · ` : ''}
              {localStatus.workspace || 'Workspace key persisted'}
            </Text>
            <Text className="text-xs text-emerald-700/80">
              {closeCountdown !== null && closeCountdown > 0
                ? `Closing this tab in ${closeCountdown}s — return to your original window to continue onboarding.`
                : 'You can close this tab and return to your original window to continue onboarding.'}
            </Text>
            <Button onPress={onCloseTab} variant="outline" className="w-full">
              Close this tab
            </Button>
          </View>
        ) : null}

        {localStatus.kind === 'error' ? (
          <View className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
            <Text className="text-sm font-semibold text-destructive">
              Local sign-in failed
            </Text>
            <Text className="text-xs text-destructive/80">
              {localStatus.message}
            </Text>
          </View>
        ) : null}

        <Text className="text-xs text-muted-foreground">
          Set <Text className="font-mono">SHOGO_AUTH_CALLBACK_URL</Text> back to
          its default in <Text className="font-mono">.env.local</Text> (or
          unset it) to redirect straight to the desktop again.
        </Text>
      </View>
    </View>
  )
}

function ParamRow({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text className="text-xs uppercase text-muted-foreground">{label}</Text>
      <Text className="text-sm font-mono text-foreground" selectable>
        {value}
      </Text>
    </View>
  )
}
