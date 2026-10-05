// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useRef, useState } from "react"
import { Linking, Pressable, Text, View } from "react-native"
import { API_URL, createHttpClient } from "../../lib/api"

export interface IntegrationAuthRequest {
  provider: string
  connectUrl: string
  message?: string
}

const POLL_MS = 3_000
const POLL_FOR_MS = 10 * 60_000

const KNOWN_LABELS: Record<string, string> = { github: "GitHub" }

/** "github" -> "GitHub", "composio:google_calendar" -> "Google Calendar", "mcp:linear" -> "Linear". */
export function integrationLabel(provider: string): string {
  if (KNOWN_LABELS[provider]) return KNOWN_LABELS[provider]
  const name = provider.includes(":") ? provider.slice(provider.indexOf(":") + 1) : provider
  return name
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ")
}

/** The project a connect link is for, read off `/api/projects/:projectId/integrations/...`. */
function linkProjectId(connectUrl: string): string | null {
  try {
    const match = new URL(connectUrl).pathname.match(/\/api\/projects\/([^/]+)\/integrations\//)
    return match ? decodeURIComponent(match[1]!) : null
  } catch {
    return null
  }
}

interface MyIntegrations {
  connections?: Array<{ provider: string }>
  grants?: Array<{ provider: string; projectId: string; revokedAt?: string | null }>
}

async function isConnected(provider: string, projectId: string | null): Promise<boolean> {
  const { data: body } = await createHttpClient().get<MyIntegrations>("/api/me/integrations")
  const connected = (body?.connections ?? []).some((c) => c.provider === provider)
  const granted =
    !projectId || (body?.grants ?? []).some((g) => g.provider === provider && g.projectId === projectId && !g.revokedAt)
  return connected && granted
}

/**
 * Shown when the agent needs the person's own account on an integration.
 * Opens the connect link, notices when they've connected, and lets the
 * agent pick up where it left off.
 */
export function IntegrationConnectCard({
  request,
  onContinue,
  pollMs = POLL_MS,
}: {
  request: IntegrationAuthRequest
  /** Connected (or the person says so): tell the agent to carry on. */
  onContinue: (label: string) => void
  pollMs?: number
}) {
  const label = integrationLabel(request.provider)
  const [opened, setOpened] = useState(false)
  const done = useRef(false)

  const finish = () => {
    if (done.current) return
    done.current = true
    onContinue(label)
  }

  useEffect(() => {
    if (!opened || !API_URL) return
    const projectId = linkProjectId(request.connectUrl)
    const stopAt = Date.now() + POLL_FOR_MS
    let cancelled = false
    const tick = async () => {
      if (cancelled || done.current) return
      if (await isConnected(request.provider, projectId).catch(() => false)) {
        if (!cancelled) finish()
        return
      }
      if (Date.now() < stopAt) timer = setTimeout(tick, pollMs)
    }
    let timer = setTimeout(tick, pollMs)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, pollMs, request.connectUrl, request.provider])

  return (
    <View className="gap-2">
      <Text className="text-sm text-foreground">
        {`This agent acts as you on ${label}. Connect your ${label} account and it will carry on.`}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Connect ${label}`}
          onPress={() => {
            setOpened(true)
            void Linking.openURL(request.connectUrl)
          }}
          className="rounded-lg bg-primary px-3 py-1.5"
        >
          <Text className="text-xs font-medium text-primary-foreground">{`Connect ${label}`}</Text>
        </Pressable>
        {opened ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="I've connected, continue"
            onPress={finish}
            className="rounded-lg border border-border px-3 py-1.5"
          >
            <Text className="text-xs text-foreground">I've connected, continue</Text>
          </Pressable>
        ) : null}
      </View>
      {opened ? (
        <Text className="text-xs text-muted-foreground">Waiting for you to finish connecting…</Text>
      ) : null}
    </View>
  )
}
