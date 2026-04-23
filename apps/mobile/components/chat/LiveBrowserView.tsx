// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * LiveBrowserView — renders a running subagent's headless-Chromium viewport
 * in real time. Subscribes to the agent runtime's CDP screencast SSE route
 * (`GET /agent/subagents/:instanceId/screencast`) and paints each base64 JPEG
 * frame into an <Image/>.
 *
 * Mounted under a running subagent card when the Agents panel sees an
 * `instanceId` on its store entry; unmounted when the subagent finishes.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { View, Text, Image, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { useChatContextSafe } from "./ChatContext"
import { createAuthedEventSource } from "../../lib/authed-event-source"
import { logScreencast, warnScreencast } from "../../lib/screencast-debug"

const MAX_RECONNECT_ATTEMPTS = 5

interface ScreencastFrame {
  jpegBase64: string
  ts: number
  width: number
  height: number
}

export interface LiveBrowserViewProps {
  instanceId: string
  /** When false, tear down the stream (e.g. subagent has completed). */
  active?: boolean
  /** Optional explicit agent runtime URL. Falls back to the ChatContext's
   *  agentUrl when the component is rendered inside ChatPanel. Callers that
   *  live outside the ChatProvider (e.g. AgentsPanel in ProjectLayout) must
   *  pass this prop explicitly. */
  agentUrl?: string | null
  className?: string
}

export function LiveBrowserView({ instanceId, active = true, agentUrl: agentUrlProp, className }: LiveBrowserViewProps) {
  const chatContext = useChatContextSafe()
  const agentUrl = agentUrlProp ?? chatContext?.agentUrl ?? null
  const [frame, setFrame] = useState<ScreencastFrame | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exhaustedRetries, setExhaustedRetries] = useState(false)
  const esRef = useRef<EventSource | null>(null)
  // Bumped to force the effect to re-run when the user taps "Retry".
  const [connectGeneration, setConnectGeneration] = useState(0)

  const handleManualRetry = useCallback(() => {
    setExhaustedRetries(false)
    setError(null)
    setConnectGeneration((g) => g + 1)
  }, [])

  useEffect(() => {
    if (!active || !agentUrl || !instanceId) {
      logScreencast(
        `[screencast] LiveBrowserView skip connect active=${active} ` +
        `hasAgentUrl=${!!agentUrl} instanceId=${instanceId ?? "<none>"}`,
      )
      return
    }
    let alive = true
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let frameCount = 0
    let attempts = 0

    function connect() {
      if (!alive) return
      try {
        const url = `${agentUrl}/agent/subagents/${encodeURIComponent(instanceId)}/screencast`
        logScreencast(`[screencast] LiveBrowserView connect url=${url} attempt=${attempts + 1}/${MAX_RECONNECT_ATTEMPTS}`)
        const es = createAuthedEventSource(url)
        esRef.current = es
        es.onopen = () => {
          if (!alive) return
          logScreencast(`[screencast] LiveBrowserView onopen instanceId=${instanceId}`)
          attempts = 0
          setError(null)
          setExhaustedRetries(false)
        }
        es.onmessage = (ev: any) => {
          if (!alive) return
          try {
            const f = JSON.parse(ev.data) as ScreencastFrame
            if (f?.jpegBase64) {
              frameCount++
              if (frameCount === 1 || frameCount % 60 === 0) {
                logScreencast(
                  `[screencast] LiveBrowserView frame#${frameCount} instanceId=${instanceId} ` +
                  `size=${f.width}x${f.height}`,
                )
              }
              setFrame(f)
            }
          } catch (err: any) {
            warnScreencast(`[screencast] LiveBrowserView parse error: ${err?.message ?? err}`)
          }
        }
        es.onerror = (err: any) => {
          warnScreencast(
            `[screencast] LiveBrowserView onerror instanceId=${instanceId} ` +
            `readyState=${(es as any)?.readyState} err=${err?.message ?? "?"}`,
          )
          try { es.close() } catch {}
          if (!alive) return

          attempts++
          if (attempts >= MAX_RECONNECT_ATTEMPTS) {
            warnScreencast(
              `[screencast] LiveBrowserView exhausted ${MAX_RECONNECT_ATTEMPTS} retries for instanceId=${instanceId}`,
            )
            setError("Connection failed")
            setExhaustedRetries(true)
            return
          }

          setError(`Reconnecting… (${attempts}/${MAX_RECONNECT_ATTEMPTS})`)
          reconnectTimer = setTimeout(connect, 2000)
        }
      } catch (err: any) {
        warnScreencast(`[screencast] LiveBrowserView connect threw: ${err?.message ?? err}`)
        setError(err?.message ?? "Failed to connect")
        setExhaustedRetries(true)
      }
    }
    connect()

    return () => {
      logScreencast(`[screencast] LiveBrowserView cleanup instanceId=${instanceId}`)
      alive = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { esRef.current?.close() } catch {}
      esRef.current = null
    }
  }, [active, agentUrl, instanceId, connectGeneration])

  if (!frame) {
    return (
      <View className={cn("rounded-lg bg-muted/60 border border-border items-center justify-center py-6 px-4", className)}>
        <Text className="text-xs text-muted-foreground">
          {error ?? "Waiting for browser…"}
        </Text>
        {exhaustedRetries && (
          <Pressable
            onPress={handleManualRetry}
            accessibilityRole="button"
            accessibilityLabel="Retry screencast connection"
            className="mt-2 px-3 py-1.5 rounded-md bg-muted active:opacity-70"
          >
            <Text className="text-xs font-semibold text-destructive">Retry</Text>
          </Pressable>
        )}
      </View>
    )
  }

  // Aspect ratio is derived from the frame metadata so the image scales
  // correctly inside its container without distortion.
  const aspect = frame.width > 0 && frame.height > 0 ? frame.width / frame.height : 16 / 9

  return (
    <View className={cn("rounded-lg overflow-hidden bg-black border border-border", className)}>
      <Image
        source={{ uri: `data:image/jpeg;base64,${frame.jpegBase64}` }}
        style={{ width: "100%", aspectRatio: aspect }}
        resizeMode="contain"
        accessibilityLabel="Live browser preview"
      />
    </View>
  )
}
