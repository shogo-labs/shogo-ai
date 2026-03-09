// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ToolTimeline Component (React Native)
 *
 * Vertical tool timeline showing recent tool calls with gradient fade.
 * Collapsible with ToolPill summary in collapsed state.
 */

import { useState } from "react"
import { View, Text, Pressable, ScrollView } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { ChevronUp } from "lucide-react-native"
import { type ToolCallData, GRADIENT_CONFIG, getGradientOpacity } from "./types"
import { ToolCallDetail } from "./ToolCallDetail"
import { ToolPill } from "./ToolPill"

export interface ToolTimelineProps {
  tools: ToolCallData[]
  defaultExpanded?: boolean
  className?: string
}

export function ToolTimeline({
  tools,
  defaultExpanded = false,
  className,
}: ToolTimelineProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  if (tools.length === 0) {
    return null
  }

  const displayTools = isExpanded
    ? tools
    : tools.slice(-GRADIENT_CONFIG.maxItems)

  const sortedTools = [...displayTools].reverse()

  return (
    <View className={cn("rounded-md overflow-hidden", className)}>
      {/* Collapsed state: show ToolPill */}
      {!isExpanded && (
        <ToolPill
          tools={tools}
          onPress={() => setIsExpanded(true)}
        />
      )}

      {/* Expanded state: show full timeline */}
      {isExpanded && (
        <View className="bg-gray-50/30 dark:bg-gray-900/30 rounded-md border border-gray-200/50 dark:border-gray-700/50">
          {/* Header with collapse button */}
          <View className="flex-row items-center justify-between px-2 py-1.5 border-b border-gray-200/30 dark:border-gray-700/30">
            <Text className="text-xs font-medium text-gray-400">
              Tool Timeline ({tools.length})
            </Text>
            <Pressable
              onPress={() => setIsExpanded(false)}
              className="p-0.5 rounded"
              accessibilityLabel="Collapse timeline"
            >
              <ChevronUp className="w-3.5 h-3.5 text-gray-400" size={14} />
            </Pressable>
          </View>

          {/* Tool list with gradient fade */}
          <ScrollView className="py-1 max-h-64">
            {sortedTools.map((tool, index) => {
              const opacity = isExpanded ? 1 : getGradientOpacity(index)

              return (
                <ToolCallDetail
                  key={`timeline-${tool.id}`}
                  tool={tool}
                  opacity={opacity}
                />
              )
            })}
          </ScrollView>
        </View>
      )}
    </View>
  )
}

export default ToolTimeline
