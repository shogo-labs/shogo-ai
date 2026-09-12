// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Content rendered inside the context-usage popover that opens when the user
 * clicks the `ContextTracker` ring in `ChatInput`. Breaks the current turn's
 * context window down into the same 6 categories Cursor's own "Context
 * Usage" popup uses: System prompt, Tool definitions, Skills, MCP & dynamic
 * tools, Subagent definitions, Conversation.
 *
 * Data comes from the gateway's `data-prompt-breakdown` SSE part (see
 * `AgentGateway`'s per-turn breakdown computation in `gateway.ts`), captured
 * by `ChatPanel` into `contextBreakdown` state and threaded down through
 * `ChatInput`.
 */
import React from "react"
import { View, Text } from "react-native"

import { formatTokenCount } from "./ContextTracker"

export interface ContextBreakdownCategory {
  key: string
  label: string
  estTokens: number
}

export interface ContextBreakdownData {
  categories: ContextBreakdownCategory[]
  grandEstTokens: number
}

interface ContextBreakdownPanelProps {
  /** Categorized per-turn breakdown from the gateway. Null before the first turn. */
  breakdown: ContextBreakdownData | null
  /** Live conversation-only estimate — used as a fallback numerator before any breakdown has arrived. */
  inputTokens: number
  contextWindowTokens: number
}

/**
 * Fixed color per category key — kept in sync with the `key`s the gateway
 * emits in `data-prompt-breakdown.categories` (packages/agent-runtime/src/gateway.ts).
 */
const CATEGORY_COLORS: Record<string, string> = {
  "system-prompt": "#a1a1aa",
  "tool-definitions": "#8b5cf6",
  skills: "#f59e0b",
  "mcp-dynamic-tools": "#d946ef",
  "subagent-definitions": "#3b82f6",
  conversation: "#f43f5e",
}
const FALLBACK_COLOR = "#a1a1aa"

function getCategoryColor(key: string): string {
  return CATEGORY_COLORS[key] ?? FALLBACK_COLOR
}

export function ContextBreakdownPanel({ breakdown, inputTokens, contextWindowTokens }: ContextBreakdownPanelProps) {
  const categories = breakdown?.categories ?? []
  const totalTokens = breakdown?.grandEstTokens ?? inputTokens
  const percentage = contextWindowTokens > 0 ? Math.min((totalTokens / contextWindowTokens) * 100, 100) : 0
  const visibleSegments = categories.filter((cat) => cat.estTokens > 0)

  return (
    <View className="w-full gap-3 p-3">
      <View className="flex-row items-baseline justify-between gap-2">
        <Text className="text-sm font-semibold text-foreground">{percentage.toFixed(0)}% Full</Text>
        <Text className="text-xs text-muted-foreground">
          ~{formatTokenCount(totalTokens)} / {formatTokenCount(contextWindowTokens)} Tokens
        </Text>
      </View>

      {visibleSegments.length > 0 ? (
        <>
          <View className="h-1.5 w-full flex-row overflow-hidden rounded-full bg-muted">
            {visibleSegments.map((cat) => (
              <View
                key={cat.key}
                style={{ backgroundColor: getCategoryColor(cat.key), flexGrow: cat.estTokens, flexBasis: 0 }}
              />
            ))}
          </View>

          <View className="gap-2">
            {categories.map((cat) => (
              <View key={cat.key} className="flex-row items-center justify-between gap-2">
                <View className="flex-row items-center gap-2">
                  <View className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: getCategoryColor(cat.key) }} />
                  <Text className="text-xs text-foreground">{cat.label}</Text>
                </View>
                <Text className="text-xs text-muted-foreground">{formatTokenCount(cat.estTokens)}</Text>
              </View>
            ))}
          </View>
        </>
      ) : (
        <Text className="text-xs leading-5 text-muted-foreground">
          Send a message to see the full context breakdown for this session.
        </Text>
      )}
    </View>
  )
}
