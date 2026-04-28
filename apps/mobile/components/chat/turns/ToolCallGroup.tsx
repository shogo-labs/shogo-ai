// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ToolCallGroup Component (React Native)
 *
 * Collapsible card that groups consecutive tool calls with the same name.
 * Collapsed by default, shows tool name + count + status summary.
 * Expands to reveal individual InlineToolWidget instances.
 */

import { View, Text, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronRight,
  ChevronDown,
} from "lucide-react-native"
import {
  type ToolCallData,
  formatToolName,
  getToolNamespace,
} from "../tools/types"
import { InlineToolWidget } from "./InlineToolWidget"
import { TransportBadge } from "../TransportBadge"

export interface ToolCallGroupProps {
  toolName: string
  tools: Array<{ tool: ToolCallData; id: string }>
  isExpanded?: boolean
  onToggle?: () => void
  className?: string
}

export function ToolCallGroup({
  toolName,
  tools,
  isExpanded = false,
  onToggle,
  className,
}: ToolCallGroupProps) {
  const displayName = formatToolName(toolName)
  const namespace = getToolNamespace(toolName)
  const category = tools[0]?.tool.category || "other"

  const hasErrors = tools.some((t) => t.tool.state === "error")
  const allSuccess =
    !hasErrors && tools.every((t) => t.tool.state === "success")
  const hasStreaming = tools.some((t) => t.tool.state === "streaming")

  return (
    <View
      className={cn(
        "rounded-md border overflow-hidden",
        hasErrors
          ? "border-exec-error/30 bg-exec-error/5"
          : "border-border/40 bg-muted/5",
        className,
      )}
    >
      {/* Header row */}
      <Pressable
        onPress={onToggle}
        className="w-full flex-row items-center gap-1.5 py-1.5 px-2"
      >
        {isExpanded ? (
          <ChevronDown className="w-2.5 h-2.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-2.5 h-2.5 text-muted-foreground" />
        )}

        <View
          className={cn(
            "w-1 h-1 rounded-full",
            category === "mcp" && "bg-tool-mcp",
            category === "file" && "bg-tool-file",
            category === "skill" && "bg-tool-skill",
            category === "bash" && "bg-tool-bash",
            category === "other" && "bg-muted-foreground",
          )}
        />

        <Text className="font-mono text-[10px] font-medium">
          {namespace && (
            <Text className="text-muted-foreground">{namespace}.</Text>
          )}
          <Text className="text-foreground">
            {displayName.replace(`${namespace}.`, "")}
          </Text>
        </Text>

        <View className="bg-muted/80 rounded-full px-1.5 py-px">
          <Text className="text-[9px] text-muted-foreground font-medium">
            ×{tools.length}
          </Text>
        </View>

        <View className="flex-1" />

        <TransportBadge size="xs" className="mr-1" />

        {hasStreaming ? (
          <Loader2 className="w-3 h-3 text-primary animate-spin" />
        ) : hasErrors ? (
          <XCircle className="w-3 h-3 text-red-500" />
        ) : allSuccess ? (
          <CheckCircle2 className="w-3 h-3 text-green-500" />
        ) : null}
      </Pressable>

      {/* Expanded: individual tools */}
      {isExpanded && (
        <View className="border-t border-border/30">
          {tools.map((t) => (
            <InlineToolWidget key={t.id} tool={t.tool} />
          ))}
        </View>
      )}
    </View>
  )
}

export default ToolCallGroup
