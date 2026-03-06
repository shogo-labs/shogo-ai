/**
 * InlineToolWidget Component (React Native)
 *
 * Compact inline tool display with expand/collapse for interleaved rendering.
 * Shows tool name, key argument, and state in collapsed view.
 * Expands to show full args and result.
 */

import { useState } from "react"
import { View, Text, Pressable, ScrollView } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { CheckCircle2, XCircle, Loader2, ChevronRight, ChevronDown } from "lucide-react-native"
import {
  type ToolCallData,
  formatToolName,
  getToolNamespace,
  getToolKeyArg,
} from "../tools/types"

export interface InlineToolWidgetProps {
  tool: ToolCallData
  isExpanded?: boolean
  onToggle?: () => void
  className?: string
}

export function InlineToolWidget({
  tool,
  isExpanded: controlledExpanded,
  onToggle,
  className,
}: InlineToolWidgetProps) {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const isExpanded = controlledExpanded ?? internalExpanded

  const handleToggle = () => {
    if (onToggle) {
      onToggle()
    } else {
      setInternalExpanded(!internalExpanded)
    }
  }

  const displayName = formatToolName(tool.toolName)
  const namespace = getToolNamespace(tool.toolName)
  const keyArg = getToolKeyArg(tool.toolName, tool.args)

  const StateIcon = {
    streaming: Loader2,
    success: CheckCircle2,
    error: XCircle,
  }[tool.state]

  const formatJson = (data: unknown): string => {
    if (typeof data === 'string') {
      try {
        return JSON.stringify(JSON.parse(data), null, 2)
      } catch {
        return data
      }
    }
    try {
      return JSON.stringify(data, null, 2)
    } catch {
      return String(data)
    }
  }

  const getDisplayableResult = (): string => {
    if (tool.error) return tool.error
    if (tool.result === undefined || tool.result === null) return ""
    if (typeof tool.result === "string") return tool.result
    const r = tool.result as Record<string, unknown>
    if (r.stderr && typeof r.stderr === "string") {
      const stdout = typeof r.stdout === "string" ? r.stdout : ""
      return stdout ? `${stdout}\n${r.stderr}` : r.stderr
    }
    if (r.stdout && typeof r.stdout === "string") return r.stdout
    if (r.text && typeof r.text === "string") return r.text
    return formatJson(tool.result)
  }

  return (
    <View className={cn("overflow-hidden", className)}>
      {/* Collapsed header */}
      <Pressable
        onPress={handleToggle}
        className="w-full flex-row items-center gap-1.5 py-1 px-2"
      >
        {isExpanded ? (
          <ChevronDown className="w-2.5 h-2.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-2.5 h-2.5 text-muted-foreground" />
        )}

        <View
          className={cn(
            "w-1 h-1 rounded-full",
            tool.category === "mcp" && "bg-tool-mcp",
            tool.category === "file" && "bg-tool-file",
            tool.category === "skill" && "bg-tool-skill",
            tool.category === "bash" && "bg-tool-bash",
            tool.category === "other" && "bg-muted-foreground"
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

        {keyArg ? (
          <Text className="flex-1 text-[9px] text-muted-foreground/60 font-mono text-right" numberOfLines={1}>
            {keyArg}
          </Text>
        ) : (
          <View className="flex-1" />
        )}

        <StateIcon
          className={cn(
            "w-3 h-3",
            tool.state === "streaming" && "text-blue-400",
            tool.state === "success" && "text-green-500",
            tool.state === "error" && "text-red-500"
          )}
        />
      </Pressable>

      {/* Expanded content */}
      {isExpanded && (
        <View className="border-t border-border/50 p-2 gap-1.5">
          {tool.args && Object.keys(tool.args).length > 0 && (
            <View className="gap-0.5">
              <Text className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
                Args
              </Text>
              <ScrollView nestedScrollEnabled className="bg-background/50 rounded p-1.5 max-h-32">
                <Text className="text-[10px] font-mono text-foreground" selectable>
                  {formatJson(tool.args)}
                </Text>
              </ScrollView>
            </View>
          )}

          {tool.state === "success" && tool.result !== undefined && (
            <View className="gap-0.5">
              <Text className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
                Result
              </Text>
              <ScrollView nestedScrollEnabled className="bg-background/50 rounded p-1.5 max-h-32">
                <Text className="text-[10px] font-mono text-foreground" selectable>
                  {formatJson(tool.result)}
                </Text>
              </ScrollView>
            </View>
          )}

          {tool.state === "error" && (
            <View className="gap-0.5">
              <Text className="text-[9px] font-medium text-red-500 uppercase tracking-wide">
                Error
              </Text>
              <ScrollView nestedScrollEnabled className="bg-red-500/10 rounded p-1.5 max-h-32">
                <Text className="text-[10px] font-mono text-red-500" selectable>
                  {getDisplayableResult() || "No output captured"}
                </Text>
              </ScrollView>
            </View>
          )}

          {tool.duration !== undefined && tool.duration > 0 && (
            <Text className="text-[9px] text-muted-foreground">
              {tool.duration < 1000 ? `${tool.duration}ms` : `${(tool.duration / 1000).toFixed(2)}s`}
            </Text>
          )}
        </View>
      )}
    </View>
  )
}

export default InlineToolWidget
