// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Context-summary section of the context-usage panel: shows the last compaction
 * (if the transcript's latest turn has one) and lets the user summarize now.
 *
 * The in-turn case is automatic — this button exists for "the ring is high and
 * I don't want to wait". The route answers honestly: `compacted` now,
 * `queued` for a live turn (it lands at the next step), or a reason when there
 * is nothing to fold away.
 */
import React, { useCallback, useState } from "react"
import { ActivityIndicator, Pressable, Text, View } from "react-native"
import { Scissors } from "lucide-react-native"
import { formatTokenCount } from "./ContextTracker"
import { requestContextCompaction } from "../../lib/compact-context"

type Status = { kind: "idle" } | { kind: "working" } | { kind: "done" | "info" | "error"; text: string }

export function ContextSummarySection({
  projectId,
  chatSessionId,
}: {
  projectId?: string | null
  chatSessionId?: string | null
}) {
  const [status, setStatus] = useState<Status>({ kind: "idle" })
  const disabled = !projectId || !chatSessionId || status.kind === "working"

  const onPress = useCallback(async () => {
    if (!projectId || !chatSessionId) return
    setStatus({ kind: "working" })
    try {
      const result = await requestContextCompaction(projectId, chatSessionId)
      if (result.compacted) {
        const before = result.tokensBefore !== undefined ? formatTokenCount(result.tokensBefore) : "?"
        const after = result.tokensAfter !== undefined ? formatTokenCount(result.tokensAfter) : "?"
        setStatus({ kind: "done", text: `Summarized · ${before} → ${after} tokens` })
        return
      }
      if (result.queued) {
        setStatus({ kind: "info", text: result.reason ?? "Will summarize at the next step" })
        return
      }
      setStatus({ kind: "info", text: result.reason ?? "Nothing to compact" })
    } catch (err: any) {
      setStatus({ kind: "error", text: err?.message ?? "Couldn't summarize context" })
    }
  }, [projectId, chatSessionId])

  const statusColor =
    status.kind === "error"
      ? "text-destructive"
      : status.kind === "done"
        ? "text-foreground"
        : "text-muted-foreground"

  return (
    <View className="gap-2 border-t border-border pt-3">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-xs text-muted-foreground">Summarize old turns to free context.</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Summarize context now"
          disabled={disabled}
          onPress={onPress}
          className={`flex-row items-center gap-1.5 rounded-full border border-border px-2.5 py-1 ${
            disabled ? "opacity-50" : "active:opacity-70"
          }`}
        >
          {status.kind === "working" ? (
            <ActivityIndicator size="small" />
          ) : (
            <Scissors size={12} className="text-foreground" />
          )}
          <Text className="text-xs font-medium text-foreground">Summarize now</Text>
        </Pressable>
      </View>
      {status.kind !== "idle" && status.kind !== "working" ? (
        <Text className={`text-[11px] ${statusColor}`}>{status.text}</Text>
      ) : null}
    </View>
  )
}
