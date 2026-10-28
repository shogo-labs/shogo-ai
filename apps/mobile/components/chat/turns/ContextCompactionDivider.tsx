// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Divider row for a context summarization ("Context summarized · 412k → 38k").
 *
 * One row per compaction, persisted as a `data-context-summarized` part on the
 * assistant message, so it survives a reload and explains why the context ring
 * in the composer dropped mid-turn. Before SHO-96 a compaction rewrote the
 * session's messages silently and left no trace in the transcript.
 */
import { View, Text } from "react-native"
import { Scissors } from "lucide-react-native"

export interface ContextCompactionPart {
  trigger: "auto" | "manual"
  tokensBefore: number
  tokensAfter: number
  messagesBefore: number
  messagesAfter: number
}

function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0"
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(Math.round(tokens))
}

export function ContextCompactionDivider({ part }: { part: ContextCompactionPart }) {
  const folded = Math.max(0, part.messagesBefore - part.messagesAfter)
  return (
    <View className="my-2 flex-row items-center gap-2">
      <View className="h-px flex-1 bg-border" />
      <View className="flex-row items-center gap-1.5 rounded-full border border-border px-2 py-0.5">
        <Scissors size={11} className="text-muted-foreground" />
        <Text className="text-[11px] text-muted-foreground">
          Context summarized · {formatTokens(part.tokensBefore)} → {formatTokens(part.tokensAfter)}
          {folded > 0 ? ` · ${folded} messages folded` : ""}
          {` (${part.trigger})`}
        </Text>
      </View>
      <View className="h-px flex-1 bg-border" />
    </View>
  )
}
