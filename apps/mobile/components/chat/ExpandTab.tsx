// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ExpandTab Component
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Renders a vertical tab with "Chat" label and MessageSquare icon.
 * When collapsed, shows as a tab on the side that can be pressed to expand.
 */

import * as React from "react"
import { View, Text, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { MessageSquare } from "lucide-react-native"

export interface ExpandTabProps {
  onExpand: () => void
  className?: string
}

export function ExpandTab({ onExpand, className }: ExpandTabProps) {
  return (
    <Pressable
      onPress={onExpand}
      className={cn(
        "flex-col items-center gap-2 px-2 py-4",
        "bg-card border-l border-border rounded-l-lg",
        "active:bg-accent",
        className
      )}
      accessibilityLabel="Expand chat panel"
    >
      <MessageSquare
        className="h-4 w-4 shrink-0 text-foreground"
      />
      <Text className="text-xs font-medium tracking-wider text-foreground">Chat</Text>
    </Pressable>
  )
}
