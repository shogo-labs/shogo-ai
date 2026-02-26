/**
 * ToolCallDetail Component (React Native)
 *
 * Individual tool call detail component for timeline display.
 * Shows tool name with namespace styling, execution state, args preview.
 */

import { View, Text } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { CheckCircle2, XCircle, Loader2 } from "lucide-react-native"
import { type ToolCallData, formatToolName, getToolNamespace, getToolKeyArg } from "./types"

export interface ToolCallDetailProps {
  tool: ToolCallData
  opacity?: number
  className?: string
}

export function ToolCallDetail({ tool, opacity = 1, className }: ToolCallDetailProps) {
  const displayName = formatToolName(tool.toolName)
  const namespace = getToolNamespace(tool.toolName)
  const keyArg = getToolKeyArg(tool.toolName, tool.args)

  const StateIcon = {
    streaming: Loader2,
    success: CheckCircle2,
    error: XCircle,
  }[tool.state]

  return (
    <View
      className={cn(
        "flex-row items-center gap-2 py-1.5 px-2 rounded-md",
        className
      )}
      style={{ opacity }}
    >
      {/* Category color indicator */}
      <View
        className={cn(
          "w-1.5 h-1.5 rounded-full shrink-0",
          tool.category === "mcp" && "bg-violet-500",
          tool.category === "file" && "bg-blue-500",
          tool.category === "skill" && "bg-amber-500",
          tool.category === "bash" && "bg-emerald-500",
          tool.category === "other" && "bg-gray-400"
        )}
      />

      {/* Tool name */}
      <View className="flex-row shrink-0">
        {namespace && (
          <Text className="font-mono text-xs text-gray-400">{namespace}.</Text>
        )}
        <Text className="font-mono text-xs font-medium text-foreground">
          {displayName.replace(`${namespace}.`, "")}
        </Text>
      </View>

      {/* Key argument */}
      {keyArg && (
        <Text
          className="flex-1 text-[10px] text-gray-400/60 font-light text-right font-mono"
          numberOfLines={1}
        >
          {keyArg}
        </Text>
      )}

      {!keyArg && <View className="flex-1" />}

      {/* State icon */}
      <StateIcon
        className={cn(
          "w-3.5 h-3.5 shrink-0",
          tool.state === "streaming" && "text-blue-400",
          tool.state === "success" && "text-green-500",
          tool.state === "error" && "text-red-500"
        )}
        size={14}
      />
    </View>
  )
}

export default ToolCallDetail
