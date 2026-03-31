// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ThinkingWidget Component (React Native)
 *
 * Collapsible display for assistant thinking/reasoning blocks.
 * Auto-opens during streaming, auto-closes when complete.
 */

import { useState, useEffect, useRef, useCallback } from "react"
import { View, Text, Pressable, ScrollView, Platform, useColorScheme } from "react-native"
import { Motion, AnimatePresence } from "@legendapp/motion"
import { LinearGradient } from "expo-linear-gradient"
import { cn } from "@shogo/shared-ui/primitives"
import { ChevronDown } from "lucide-react-native"

const ANIM_DURATION = 250
const STREAM_MAX_HEIGHT = 200
const FADE_HEIGHT = 16

export interface ThinkingWidgetProps {
  text: string
  isStreaming?: boolean
  durationSeconds?: number
  className?: string
}

export function ThinkingWidget({
  text,
  isStreaming = false,
  durationSeconds,
  className,
}: ThinkingWidgetProps) {
  const [isOpen, setIsOpen] = useState(isStreaming)
  const userClosedRef = useRef(false)
  const startTimeRef = useRef<number | null>(null)
  const [duration, setDuration] = useState<number | undefined>(durationSeconds)
  const [measuredHeight, setMeasuredHeight] = useState(0)
  const colorScheme = useColorScheme()
  const innerScrollRef = useRef<ScrollView>(null)
  const userScrolledThinkingRef = useRef(false)
  const streamingOpenedRef = useRef(false)

  useEffect(() => {
    if (isStreaming) {
      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now()
      }
      userScrolledThinkingRef.current = false
      if (!userClosedRef.current) {
        streamingOpenedRef.current = true
        setIsOpen(true)
      }
    } else {
      if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / 1000))
        startTimeRef.current = null
      }
      streamingOpenedRef.current = false
      setIsOpen(false)
      userClosedRef.current = false
    }
  }, [isStreaming])

  const toggleOpen = useCallback(() => {
    streamingOpenedRef.current = false
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

  const hasText = text.length > 0
  const capHeight = isStreaming
  const targetHeight = capHeight
    ? Math.min(measuredHeight, STREAM_MAX_HEIGHT)
    : measuredHeight

  // Skip height animation when streaming auto-opens to avoid layout churn
  const effectiveDuration = streamingOpenedRef.current ? 0 : ANIM_DURATION

  // Composite bg color for gradient fades (muted/30 over page background)
  const fadeColor =
    colorScheme === "dark"
      ? "rgb(25, 25, 25)"
      : "rgb(252, 252, 252)"
  const fadeColorTransparent =
    colorScheme === "dark"
      ? "rgba(25, 25, 25, 0)"
      : "rgba(252, 252, 252, 0)"

  const webFadeMask =
    Platform.OS === "web"
      ? ({
          WebkitMaskImage: `linear-gradient(to bottom, transparent, black ${FADE_HEIGHT}px, black calc(100% - ${FADE_HEIGHT}px), transparent)`,
          maskImage: `linear-gradient(to bottom, transparent, black ${FADE_HEIGHT}px, black calc(100% - ${FADE_HEIGHT}px), transparent)`,
        } as any)
      : undefined

  return (
    <View className={cn("", className)}>
      <Pressable
        onPress={toggleOpen}
        className="flex-row items-center gap-1.5 rounded-md"
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <Text className="text-[11px] text-muted-foreground">{label}</Text>
        <Motion.View
          animate={{ rotateZ: isOpen ? "180deg" : "0deg" }}
          transition={{ type: "timing", duration: ANIM_DURATION, easing: "easeInOut" }}
        >
          <ChevronDown size={10} className="text-muted-foreground" />
        </Motion.View>
      </Pressable>

      {hasText && measuredHeight === 0 && (
        <View
          style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}
          onLayout={(e) => {
            const h = e.nativeEvent.layout.height
            if (h > 0) setMeasuredHeight(h)
          }}
        >
          <View className="rounded-md border border-border/50 bg-muted/30 p-2.5">
            <Text className="text-[11px] leading-relaxed text-muted-foreground">
              {text}
            </Text>
          </View>
        </View>
      )}

      <AnimatePresence>
        {isOpen && hasText && (
          <Motion.View
            key="thinking-content"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: targetHeight || STREAM_MAX_HEIGHT }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: "timing", duration: effectiveDuration, easing: "easeInOut" }}
            style={{ overflow: "hidden" }}
          >
            <View style={{ position: "relative" }}>
              <ScrollView
                ref={innerScrollRef}
                className="rounded-md border border-border/50 bg-muted/30 p-2.5"
                style={[
                  capHeight ? { maxHeight: STREAM_MAX_HEIGHT } : undefined,
                  webFadeMask,
                ]}
                scrollEnabled={capHeight}
                nestedScrollEnabled
                onScrollBeginDrag={() => {
                  userScrolledThinkingRef.current = true
                }}
                onContentSizeChange={(_w, h) => {
                  const next = Math.ceil(h + 20)
                  if (next !== measuredHeight) setMeasuredHeight(next)
                  if (isStreaming && !userScrolledThinkingRef.current) {
                    innerScrollRef.current?.scrollToEnd({ animated: false })
                  }
                }}
              >
                <Text className="text-[11px] leading-relaxed text-muted-foreground">
                  {text}
                </Text>
              </ScrollView>

              {/* Native fade overlays (web uses CSS mask instead) */}
              {Platform.OS !== "web" && (
                <>
                  <LinearGradient
                    colors={[fadeColor, fadeColorTransparent]}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      height: FADE_HEIGHT,
                      borderTopLeftRadius: 6,
                      borderTopRightRadius: 6,
                      pointerEvents: "none",
                    }}
                  />
                  <LinearGradient
                    colors={[fadeColorTransparent, fadeColor]}
                    style={{
                      position: "absolute",
                      bottom: 0,
                      left: 0,
                      right: 0,
                      height: FADE_HEIGHT,
                      borderBottomLeftRadius: 6,
                      borderBottomRightRadius: 6,
                      pointerEvents: "none",
                    }}
                  />
                </>
              )}
            </View>
          </Motion.View>
        )}
      </AnimatePresence>
    </View>
  )
}
