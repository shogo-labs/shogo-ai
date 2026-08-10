// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState } from "react"
import { Pressable, View, Text } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react-native"
import type { ToolCallData } from "../tools/types"

export interface NotifyErrorWidgetProps {
  tool: ToolCallData
  className?: string
}

type NotifyErrorArgs = { title?: unknown; message?: unknown }

const COPY = {
  label: "Error",
  fallbackTitle: "Something went wrong",
} as const

function toDisplayString(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (value === null || value === undefined) return ""
  return String(value).trim()
}

function getErrorContent(args: NotifyErrorArgs | undefined) {
  const title = toDisplayString(args?.title) || COPY.fallbackTitle
  const message = toDisplayString(args?.message)

  return {
    title,
    details: message || title,
  }
}

export function NotifyErrorWidget({ tool, className }: NotifyErrorWidgetProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const args = tool.args as NotifyErrorArgs | undefined
  const { title, details } = getErrorContent(args)
  const ChevronIcon = isExpanded ? ChevronDown : ChevronRight

  return (
    <View
      className={cn(
        "overflow-hidden rounded-md border border-red-500/30 bg-red-500/5",
        className,
      )}
    >
      <Pressable
        accessibilityLabel={`${COPY.label}: ${title}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: isExpanded }}
        onPress={() => setIsExpanded((current) => !current)}
        className="w-full flex-row items-center gap-1.5 px-2 py-1.5"
      >
        <ChevronIcon className="w-3 h-3 text-muted-foreground" />
        <AlertTriangle className="w-3 h-3 text-red-500" />

        <Text className="font-mono text-[10px] font-medium text-red-600 dark:text-red-400">
          {COPY.label}
        </Text>

        <Text
          className="flex-1 text-right text-[9px] text-muted-foreground"
          numberOfLines={1}
        >
          {title}
        </Text>
      </Pressable>

      {isExpanded ? (
        <View className="border-t border-red-500/20 px-2 py-1.5">
          <Text className="text-xs leading-5 text-red-700 dark:text-red-300">
            {details}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

export default NotifyErrorWidget
