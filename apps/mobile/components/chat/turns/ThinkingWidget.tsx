// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ThinkingWidget Component (React Native)
 *
 * Collapsible display for assistant thinking/reasoning blocks.
 * Auto-opens during streaming, auto-closes when complete.
 */

import { useState, useEffect, useRef, useCallback } from "react"
import { View, Text, Pressable, ScrollView } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { Brain, ChevronDown } from "lucide-react-native"

export interface ThinkingWidgetProps {
  text: string
  isStreaming?: boolean
  className?: string
}

export function ThinkingWidget({
  text,
  isStreaming = false,
  className,
}: ThinkingWidgetProps) {
  const [isOpen, setIsOpen] = useState(isStreaming)
  const userClosedRef = useRef(false)
  const startTimeRef = useRef<number | null>(null)
  const [duration, setDuration] = useState<number | undefined>(undefined)

  useEffect(() => {
    if (isStreaming) {
      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now()
      }
      if (!userClosedRef.current) {
        setIsOpen(true)
      }
    } else {
      if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / 1000))
        startTimeRef.current = null
      }
      setIsOpen(false)
      userClosedRef.current = false
    }
  }, [isStreaming])

  const toggleOpen = useCallback(() => {
    setIsOpen((prev) => {
      if (isStreaming && prev) {
        userClosedRef.current = true
      }
      return !prev
    })
  }, [isStreaming])

  const label = isStreaming
    ? "Thinking…"
    : duration !== undefined
      ? `Thought for ${duration}s`
      : "Thought"

  return (
    <View className={cn("my-1", className)}>
      <Pressable
        onPress={toggleOpen}
        className="flex-row items-center gap-1.5 rounded-md px-1.5 py-1"
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <Brain size={12} className="text-muted-foreground" />
        <Text className="text-[11px] text-muted-foreground">{label}</Text>
        <ChevronDown
          size={10}
          className={cn(
            "text-muted-foreground",
            isOpen ? "rotate-180" : "rotate-0"
          )}
        />
      </Pressable>

      {isOpen && text.length > 0 && (
        <ScrollView
          className="mt-1 max-h-[200px] rounded-md border border-border/50 bg-muted/30 p-2.5"
          nestedScrollEnabled
        >
          <Text className="text-[11px] leading-relaxed text-muted-foreground">
            {text}
          </Text>
        </ScrollView>
      )}
    </View>
  )
}
