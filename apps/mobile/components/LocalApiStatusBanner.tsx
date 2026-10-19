// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-60: the desktop app now recovers a *wedged* local API (alive but not
 * serving) the same way it recovers a killed one — kill, back off, respawn —
 * and gives up loudly after five attempts. Until this banner existed the
 * renderer had no idea any of that was happening: `local-server:unavailable`
 * had no listener anywhere, so a dead API looked exactly like a slow one.
 *
 * Three states, all driven by the supervisor's IPC events:
 *   restarting  → "Local API restarting (attempt n/5)…"
 *   unavailable → error banner with Retry and Open log
 *   restarted   → hidden again
 *
 * A restart that lands in under two seconds never paints, which is the common
 * case (SHO-26 respawns in ~200-440 ms) — otherwise every kill would flash.
 */
import { useCallback, useEffect, useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { X, RotateCw, FileText } from 'lucide-react-native'

type BannerState =
  | { kind: 'hidden' }
  | { kind: 'restarting'; attempt: number; maxAttempts: number }
  | { kind: 'unavailable'; error: string }

export const LOCAL_API_BANNER_REVEAL_MS = 2_000

interface LocalApiBridge {
  onLocalServerRestarting?: (
    cb: (info: { attempt: number; maxAttempts: number; delayMs: number }) => void,
  ) => () => void
  onLocalServerRestarted?: (cb: (info: { attempt: number; pid?: number }) => void) => () => void
  onLocalServerUnavailable?: (cb: (info: { error: string }) => void) => () => void
  restartLocalServer?: () => Promise<{ ok: boolean; pid?: number; error?: string }>
  openLocalServerLog?: () => Promise<{ ok: boolean; path?: string; error?: string }>
}

function getBridge(): LocalApiBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = (window as unknown as { shogoDesktop?: LocalApiBridge }).shogoDesktop
  return bridge?.onLocalServerRestarting ? (bridge as LocalApiBridge) : null
}

export function LocalApiStatusBanner() {
  const [state, setState] = useState<BannerState>({ kind: 'hidden' })
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const bridge = getBridge()
    if (!bridge) return

    let revealTimer: ReturnType<typeof setTimeout> | null = null
    const cancelReveal = () => {
      if (revealTimer) {
        clearTimeout(revealTimer)
        revealTimer = null
      }
    }

    const offRestarting = bridge.onLocalServerRestarting?.((info) => {
      // Give a fast respawn its two seconds before the banner appears.
      cancelReveal()
      revealTimer = setTimeout(() => {
        revealTimer = null
        setDismissed(false)
        setState({ kind: 'restarting', attempt: info.attempt, maxAttempts: info.maxAttempts })
      }, LOCAL_API_BANNER_REVEAL_MS)
    })
    const offRestarted = bridge.onLocalServerRestarted?.(() => {
      cancelReveal()
      setState({ kind: 'hidden' })
      setDismissed(false)
    })
    const offUnavailable = bridge.onLocalServerUnavailable?.((info) => {
      // Terminal: shows at once, no reveal delay.
      cancelReveal()
      setDismissed(false)
      setState({ kind: 'unavailable', error: info.error })
    })

    return () => {
      cancelReveal()
      offRestarting?.()
      offRestarted?.()
      offUnavailable?.()
    }
  }, [])

  const retry = useCallback(async () => {
    const bridge = getBridge()
    if (!bridge?.restartLocalServer) return
    setBusy(true)
    try {
      const result = await bridge.restartLocalServer()
      if (!result?.ok) {
        // The success path arrives as `local-server:restarted` and hides us;
        // a failure has to be visible here or Retry looks like a no-op.
        setState({
          kind: 'unavailable',
          error: result?.error ?? 'The local API did not come back up.',
        })
      }
    } catch (err) {
      setState({
        kind: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }, [])

  const openLog = useCallback(async () => {
    const bridge = getBridge()
    try {
      const result = await bridge?.openLocalServerLog?.()
      if (result && !result.ok) {
        setState({
          kind: 'unavailable',
          error: result.error ?? result.path ?? 'The API log could not be opened.',
        })
      }
    } catch (err) {
      setState({ kind: 'unavailable', error: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  if (state.kind === 'hidden' || dismissed) return null

  if (state.kind === 'restarting') {
    return (
      <View
        testID="shogo-local-api-banner"
        className="relative flex-row flex-wrap items-center justify-center gap-x-2 bg-amber-500 px-8 py-1.5"
      >
        <RotateCw size={12} className="text-white" />
        <Text className="text-xs font-medium text-white">
          Local API restarting (attempt {state.attempt}/{state.maxAttempts})…
        </Text>
      </View>
    )
  }

  return (
    <View
      testID="shogo-local-api-banner"
      className="relative flex-row flex-wrap items-center justify-center gap-x-2 gap-y-1 bg-red-600 px-8 py-1.5"
    >
      <Text className="text-xs font-medium text-white">
        Local API is down — agents can’t run until it restarts.
      </Text>
      {state.error ? (
        <Text
          testID="shogo-local-api-banner-error"
          className="max-w-full text-xs text-white/80"
        >
          {state.error}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Retry local API"
        disabled={busy}
        onPress={retry}
        className={`ml-2 rounded px-2 py-0.5 ${busy ? 'bg-white/10' : 'bg-white/20'}`}
      >
        <Text className="text-xs font-semibold text-white">{busy ? 'Retrying…' : 'Retry'}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open local API log"
        onPress={openLog}
        className="ml-1 flex-row items-center gap-1 rounded px-2 py-0.5"
      >
        <FileText size={12} className="text-white" />
        <Text className="text-xs font-semibold text-white">Open log</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        onPress={() => setDismissed(true)}
        className="absolute right-2 p-1"
      >
        <X size={12} className="text-white" />
      </Pressable>
    </View>
  )
}
