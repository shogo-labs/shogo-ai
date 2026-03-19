// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ConnectToolWidget - OAuth connect button for Composio tool_install results.
 *
 * Renders a "Connect" button that opens a popup for OAuth.
 * Starts polling the API immediately after opening the popup (with a short
 * initial delay) to detect when the connection becomes active. This avoids
 * relying on popup close detection, which breaks due to Google's
 * Cross-Origin-Opener-Policy headers nullifying window references.
 *
 * Also checks connection status on mount so that if the user already
 * completed OAuth (e.g., page reloaded), the widget shows "connected".
 */

import { useState, useEffect, useCallback, useRef } from "react"
import { View, Text, Pressable, Platform } from "react-native"
import * as ExpoLinking from "expo-linking"
import { cn } from "@shogo/shared-ui/primitives"
import { openAuthFlow } from "@shogo/ui-kit/platform"
import {
  CheckCircle2,
  Loader2,
  ExternalLink,
  Link2,
  AlertCircle,
} from "lucide-react-native"
import { useLocalSearchParams } from "expo-router"
import { API_URL, api } from "../../../lib/api"
import { useChatContextSafe } from "../ChatContext"
import { useDomainHttp } from "../../../contexts/domain"

export interface ConnectToolWidgetProps {
  toolkitName: string
  authUrl: string
  toolCount: number
  className?: string
}

type ConnectStatus = "idle" | "connecting" | "connected" | "error"

const POLL_INTERVAL_MS = 2500
/** Max time to wait for connection before showing "Connection failed". Reduced from 90s so cancelled OAuth is detected sooner when popup-close isn't available (e.g. COOP). */
const POLL_TIMEOUT_MS = 30_000
const INITIAL_POLL_DELAY_MS = 5000

// Tracks toolkits with an OAuth flow in progress. Module-level so it survives
// component unmount/remount caused by the Custom Tab deep-link navigation.
const pendingOAuthToolkits = new Set<string>()

export function ConnectToolWidget({
  toolkitName,
  authUrl,
  toolCount,
  className,
}: ConnectToolWidgetProps) {
  const [status, setStatus] = useState<ConnectStatus>("idle")
  const chatContext = useChatContextSafe()
  const http = useDomainHttp()
  const hasSentConfirmation = useRef(false)
  const { id: projectId, fromOAuth } = useLocalSearchParams<{
    id: string
    fromOAuth?: string
  }>()

  const sendConfirmation = useCallback(() => {
    if (hasSentConfirmation.current) return
    hasSentConfirmation.current = true
    chatContext?.sendMessage(
      `I have successfully connected ${toolkitName}. You can continue.`
    )
  }, [chatContext, toolkitName])

  const checkConnection = useCallback(async () => {
    if (!projectId) return false
    try {
      if (http) {
        const json = await api.getIntegrationStatus(http, toolkitName, projectId)
        return (
          (json as any)?.data?.connected === true ||
          ((json as any)?.ok === true && (json as any)?.data?.status === "ACTIVE")
        )
      }
      const res = await fetch(
        `${API_URL}/api/integrations/status/${encodeURIComponent(toolkitName)}?projectId=${encodeURIComponent(projectId)}`,
        { credentials: "include" }
      )
      if (!res.ok) return false
      const json = await res.json()
      return (
        json?.data?.connected === true ||
        (json?.ok === true && json?.data?.status === "ACTIVE")
      )
    } catch {
      return false
    }
  }, [toolkitName, projectId, http])

  // On mount: check if already connected (handles page reload after OAuth).
  // If we're returning from a native OAuth flow (tracked by pendingOAuthToolkits
  // or the fromOAuth query param), also send the confirmation message so the
  // agent continues.
  useEffect(() => {
    let cancelled = false
    checkConnection().then((connected) => {
      if (!cancelled && connected) {
        setStatus("connected")
        if (pendingOAuthToolkits.has(toolkitName) || fromOAuth === "1") {
          pendingOAuthToolkits.delete(toolkitName)
          sendConfirmation()
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [checkConnection, toolkitName, sendConfirmation, fromOAuth])

  // Poll while connecting: wait an initial delay, then poll until connected
  useEffect(() => {
    if (status !== "connecting") return

    let cancelled = false

    const run = async () => {
      await new Promise((r) => setTimeout(r, INITIAL_POLL_DELAY_MS))
      const startTime = Date.now()

      while (!cancelled && Date.now() - startTime < POLL_TIMEOUT_MS) {
        const connected = await checkConnection()
        if (cancelled) return
        if (connected) {
          setStatus("connected")
          sendConfirmation()
          return
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      }

      if (!cancelled) {
        setStatus("error")
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [status, checkConnection, sendConfirmation])

  const checkAndConfirm = useCallback(async () => {
    const connected = await checkConnection()
    if (connected) {
      pendingOAuthToolkits.delete(toolkitName)
      setStatus("connected")
      sendConfirmation()
    }
  }, [checkConnection, toolkitName, sendConfirmation])

  const handleConnect = useCallback(async () => {
    setStatus("connecting")
    const isNative = Platform.OS !== "web"
    if (isNative) pendingOAuthToolkits.add(toolkitName)

    try {
      // Create a fresh connection via the API so the callback redirect uses the
      // correct scheme for the current environment (exp:// in Expo Go,
      // shogo:// in standalone builds) instead of the hardcoded agent URL.
      if (projectId && http) {
        try {
          const redirect = isNative
            ? ExpoLinking.createURL(
                `integrations-callback?projectId=${encodeURIComponent(projectId)}`
              )
            : undefined
          const callbackUrl = redirect
            ? `${API_URL}/api/integrations/callback?redirect=${encodeURIComponent(redirect)}`
            : `${API_URL}/api/integrations/callback`
          const data = await api.connectIntegration(
            http,
            toolkitName,
            projectId,
            callbackUrl
          )
          const redirectUrl = data.data?.redirectUrl
          if (redirectUrl) {
            const result = await openAuthFlow(redirectUrl)
            await checkAndConfirm()
            // On web, popup close means user closed/cancelled; if still not connected, show error immediately instead of waiting for 90s timeout
            if (Platform.OS === "web" && result?.type === "success") {
              const connected = await checkConnection()
              if (!connected) setStatus("error")
            }
            return
          }
        } catch {
          // Fall back to agent-provided authUrl
        }
      }

      const result = await openAuthFlow(authUrl)
      await checkAndConfirm()
      if (Platform.OS === "web" && result?.type === "success") {
        const connected = await checkConnection()
        if (!connected) setStatus("error")
      }
    } catch {
      setStatus("error")
      if (isNative) pendingOAuthToolkits.delete(toolkitName)
    }
  }, [authUrl, http, toolkitName, projectId, checkAndConfirm])

  const displayName =
    toolkitName.charAt(0).toUpperCase() + toolkitName.slice(1)

  if (status === "connected") {
    return (
      <View
        className={cn(
          "flex-row items-center gap-2 px-3 py-2.5 mx-2 rounded-lg bg-green-500/10 border border-green-500/20",
          className
        )}
      >
        <CheckCircle2 size={16} className="text-green-500" />
        <Text className="text-xs font-medium text-green-600 dark:text-green-400">
          {displayName} connected
        </Text>
        <Text className="text-[10px] text-muted-foreground ml-auto">
          {toolCount} tools available
        </Text>
      </View>
    )
  }

  if (status === "error") {
    return (
      <View
        className={cn(
          "px-3 py-2.5 mx-2 rounded-lg bg-destructive/10 border border-destructive/20",
          className
        )}
      >
        <View className="flex-row items-center gap-2 mb-1.5">
          <AlertCircle size={14} className="text-destructive" />
          <Text className="text-xs font-medium text-destructive">
            Connection failed
          </Text>
        </View>
        <Pressable
          onPress={handleConnect}
          className="flex-row items-center justify-center gap-1.5 px-4 py-2 rounded-md bg-primary"
        >
          <ExternalLink size={14} className="text-primary-foreground" />
          <Text className="text-xs font-medium text-primary-foreground">
            Retry
          </Text>
        </Pressable>
      </View>
    )
  }

  return (
    <View
      className={cn(
        "px-3 py-2.5 mx-2 rounded-lg bg-primary/5 border border-primary/10",
        className
      )}
    >
      <View className="flex-row items-center gap-2 mb-2">
        <Link2 size={14} className="text-primary" />
        <Text className="text-xs font-medium text-foreground">
          {displayName} requires authorization
        </Text>
      </View>
      <Pressable
        onPress={handleConnect}
        disabled={status === "connecting"}
        className={cn(
          "flex-row items-center justify-center gap-1.5 px-4 py-2 rounded-md",
          status === "connecting" ? "bg-primary opacity-80" : "bg-primary"
        )}
      >
        {status === "connecting" ? (
          <Loader2 size={14} className="text-primary-foreground" />
        ) : (
          <ExternalLink size={14} className="text-primary-foreground" />
        )}
        <Text className="text-xs font-medium text-primary-foreground">
          {status === "connecting"
            ? "Waiting for authorization..."
            : `Connect ${displayName}`}
        </Text>
      </Pressable>
    </View>
  )
}

/**
 * Parse a tool_install result to extract auth info.
 * Handles both object and stringified-JSON results.
 */
export function parseToolInstallResult(result: unknown): {
  authStatus?: string
  authUrl?: string
  integration?: string
  toolCount?: number
} | null {
  if (!result) return null

  if (typeof result === "object") {
    return result as any
  }

  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result)
      if (typeof parsed === "string") {
        return JSON.parse(parsed)
      }
      return parsed
    } catch {
      return null
    }
  }

  return null
}
