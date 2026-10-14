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

const KNOWN_LABELS: Record<string, string> = { github: "GitHub", github_app: "GitHub" }

/** Connects the project rather than the person's own account, so `/api/me/integrations` never shows it. */
const PROJECT_LEVEL = new Set(["github_app"])

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
}

interface AgentAccess {
  connected?: boolean
  allowed?: boolean
}

/** Connected, and (for a link from an agent) that agent acts as me, whether by its own or a workspace-wide consent. */
async function isConnected(provider: string, projectId: string | null): Promise<boolean> {
  const http = createHttpClient()
  if (projectId) {
    const { data } = await http.get<AgentAccess>(
      `/api/me/integrations/${encodeURIComponent(provider)}/access?projectId=${encodeURIComponent(projectId)}`,
    )
    return !!data?.connected && !!data?.allowed
  }
  const { data: body } = await http.get<MyIntegrations>("/api/me/integrations")
  return (body?.connections ?? []).some((c) => c.provider === provider)
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
    if (!opened || !API_URL || PROJECT_LEVEL.has(request.provider)) return
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
        {PROJECT_LEVEL.has(request.provider)
          ? request.message || `Connect ${label} to this project and the agent will carry on.`
          : `This agent acts as you on ${label}. Connect your ${label} account and it will carry on.`}
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
      {opened && !PROJECT_LEVEL.has(request.provider) ? (
        <Text className="text-xs text-muted-foreground">Waiting for you to finish connecting…</Text>
      ) : null}
    </View>
  )
}
