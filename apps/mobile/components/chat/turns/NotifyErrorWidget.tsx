// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { AlertTriangle } from "lucide-react-native"
import type { ToolCallData } from "../tools/types"

export interface NotifyErrorWidgetProps {
  tool: ToolCallData
  className?: string
}

export function NotifyErrorWidget({ tool, className }: NotifyErrorWidgetProps) {
  const rawTitle = (tool.args as { title?: unknown })?.title
  const title = typeof rawTitle === "string" ? rawTitle : "Error"
  const rawMessage = (tool.args as { message?: unknown })?.message
  const message = typeof rawMessage === "string" ? rawMessage : rawMessage ? String(rawMessage) : ""

  return (
    <View
      className={cn(
        "rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 p-3 gap-2",
        className,
      )}
    >
      <View className="flex-row items-center gap-2">
        <AlertTriangle size={16} className="text-red-500 dark:text-red-400" />
        <Text className="text-sm font-semibold text-red-700 dark:text-red-300 flex-1">
          {title}
        </Text>
      </View>
      {message ? (
        <Text className="text-xs text-red-600 dark:text-red-400 leading-5">
          {message}
        </Text>
      ) : null}
    </View>
  )
}

export default NotifyErrorWidget
