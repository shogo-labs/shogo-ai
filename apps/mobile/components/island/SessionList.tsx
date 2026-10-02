// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useMemo, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native"
import { MessageSquarePlus } from "lucide-react-native"
import { useDomainHttp } from "../../contexts/domain"
import { chatSessionEvents } from "../../lib/chat-session-events"
import {
  fetchProjectChatSessions,
  projectChatLabel,
  type ProjectChatListItem,
} from "../../lib/project-chat-sessions"
import { StatusDot } from "./IslandCollapsed"
import { mergeSessionRows, type IslandSessionRow } from "./island-inbox"
import type { IslandSession } from "./types"

export function relativeTime(timestamp: number): string {
  if (!timestamp) return ""
  const minutes = Math.round((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export function SessionRow({
  row,
  subtitle,
  onPress,
}: {
  row: Pick<IslandSessionRow, "title" | "status" | "activity" | "step" | "replyPreview">
  subtitle?: string
  onPress: () => void
}) {
  const detail = subtitle ?? (row.status === "running" ? row.step : undefined) ?? row.replyPreview
  return (
    <Pressable onPress={onPress} className="flex-row items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-white/5">
      <StatusDot status={row.status} />
      <View className="min-w-0 flex-1">
        <Text className="text-[12px] font-medium text-zinc-100" numberOfLines={1}>
          {row.title}
        </Text>
        {detail ? (
          <Text className="mt-0.5 text-[11px] text-zinc-500" numberOfLines={1}>
            {detail.replace(/\s+/g, " ").trim()}
          </Text>
        ) : null}
      </View>
      <Text className="text-[10px] text-zinc-500">{relativeTime(row.activity)}</Text>
    </Pressable>
  )
}

export function SessionList({
  projectId,
  liveSessions,
  onOpen,
  onNewChat,
}: {
  projectId: string
  liveSessions: IslandSession[]
  onOpen: (sessionId: string) => void
  onNewChat: () => void
}) {
  const http = useDomainHttp()
  const [apiSessions, setApiSessions] = useState<ProjectChatListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const liveCount = liveSessions.filter((s) => s.projectId === projectId).length
  // Bumped when a chat in this project is created/renamed/deleted elsewhere.
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    return chatSessionEvents.subscribe(({ projectId: pid, refresh }) => {
      if (refresh && pid === projectId) setRefreshTick((tick) => tick + 1)
    })
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    fetchProjectChatSessions(http, projectId)
      .then((result) => !cancelled && setApiSessions(result.sessions))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [http, projectId, liveCount, refreshTick])

  const rows = useMemo(
    () => mergeSessionRows(projectId, apiSessions ?? [], liveSessions, projectChatLabel),
    [apiSessions, liveSessions, projectId],
  )

  return (
    <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ padding: 8 }}>
      <Pressable
        onPress={onNewChat}
        className="mb-1 flex-row items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-white/5"
      >
        <MessageSquarePlus size={14} color="#a78bfa" />
        <Text className="text-[12px] font-semibold text-violet-300">New chat</Text>
      </Pressable>
      {apiSessions === null && !error ? (
        <View className="items-center py-4">
          <ActivityIndicator size="small" />
        </View>
      ) : null}
      {error ? <Text className="px-2 py-2 text-[11px] text-rose-400">{error}</Text> : null}
      {rows.map((row) => (
        <SessionRow key={row.sessionId} row={row} onPress={() => onOpen(row.sessionId)} />
      ))}
      {apiSessions && rows.length === 0 ? (
        <Text className="px-2 py-3 text-[11px] text-zinc-500">No chats yet.</Text>
      ) : null}
    </ScrollView>
  )
}
