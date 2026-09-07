// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TurnFooter (React Native)
 *
 * Renders under a completed assistant turn: thumbs up/down feedback,
 * a copy button, a "fork conversation from here" button, and a
 * relative completed-at timestamp ("2m ago").
 *
 * All actions (other than copy, which is purely local) go through
 * `TurnFooterContext` — see that file for why context instead of
 * props. When mounted outside a `TurnFooterProvider` (storybook,
 * standalone `TurnGroup` tests) the feedback/fork buttons render
 * disabled and copy still works.
 */

import { memo, useCallback, useEffect, useState } from "react"
import { View, Text, Pressable } from "react-native"
import * as Clipboard from "expo-clipboard"
import { Copy, Check, ThumbsUp, ThumbsDown, GitFork, Loader2 } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { useTurnFooterContext } from "./TurnFooterContext"
import { formatRelativeTime } from "./turnShaping"

/** How often the relative-time label re-renders to stay fresh. */
const RELATIVE_TIME_TICK_MS = 30_000

/**
 * Ticking "2m ago" label. Re-renders on an interval instead of a
 * derived-once string so a footer left open for a while doesn't go
 * stale — matches the "tense flips / counts tick" pattern used
 * elsewhere in the turn UI (see `PlanningStatusLine`).
 */
function useRelativeTimeLabel(timestampMs: number | undefined): string | null {
  const [, forceTick] = useState(0)

  useEffect(() => {
    if (timestampMs === undefined) return
    const id = setInterval(() => forceTick((n) => n + 1), RELATIVE_TIME_TICK_MS)
    return () => clearInterval(id)
  }, [timestampMs])

  if (timestampMs === undefined) return null
  return formatRelativeTime(timestampMs)
}

export interface TurnFooterProps {
  /** The assistant message id this footer acts on (feedback/fork target). */
  messageId: string | undefined
  /** Plain-text content of the turn, for the copy button. */
  text: string
  /** When the turn completed (epoch ms) — renders as "2m ago". */
  completedAt: number | undefined
  className?: string
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    if (!text) return
    try {
      await Clipboard.setStringAsync(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Silently fail on copy error
    }
  }, [text])

  return (
    <Pressable
      testID="turn-footer-copy"
      onPress={handleCopy}
      className="items-center justify-center rounded-lg p-1 hover:bg-muted/40"
      accessibilityLabel={copied ? "Copied" : "Copy message"}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
      )}
    </Pressable>
  )
}

export const TurnFooter = memo(function TurnFooter({
  messageId,
  text,
  completedAt,
  className,
}: TurnFooterProps) {
  const ctx = useTurnFooterContext()
  const relativeTime = useRelativeTimeLabel(completedAt)
  const [forking, setForking] = useState(false)

  const canAct = !!messageId && !!ctx && ctx.canActOnMessage(messageId)
  const currentThumb = messageId ? ctx?.feedback[messageId] : undefined

  const handleThumb = useCallback(
    async (thumbs: "up" | "down") => {
      if (!ctx || !messageId || !canAct) return
      try {
        if (currentThumb === thumbs) {
          await ctx.clearFeedback(messageId)
        } else {
          await ctx.setFeedback(messageId, thumbs)
        }
      } catch (err) {
        console.error("[TurnFooter] Failed to update feedback:", err)
      }
    },
    [ctx, messageId, canAct, currentThumb],
  )

  const handleFork = useCallback(async () => {
    if (!ctx || !messageId || !canAct || forking) return
    setForking(true)
    try {
      await ctx.forkFromMessage(messageId)
    } catch (err) {
      console.error("[TurnFooter] Failed to fork conversation:", err)
    } finally {
      setForking(false)
    }
  }, [ctx, messageId, canAct, forking])

  return (
    <View className={cn("flex-row items-center justify-between pl-3 pr-1", className)}>
      <View className="flex-row items-center gap-0.5">
        <CopyAction text={text} />

        <Pressable
          testID="turn-footer-thumb-up"
          onPress={() => handleThumb("up")}
          disabled={!canAct}
          className={cn(
            "items-center justify-center rounded-lg p-1 hover:bg-muted/40",
            !canAct && "opacity-40",
          )}
          accessibilityLabel={currentThumb === "up" ? "Remove like" : "Like response"}
        >
          <ThumbsUp
            className={cn(
              "h-3.5 w-3.5",
              currentThumb === "up" ? "text-primary" : "text-muted-foreground",
            )}
            fill={currentThumb === "up" ? "currentColor" : "none"}
          />
        </Pressable>

        <Pressable
          testID="turn-footer-thumb-down"
          onPress={() => handleThumb("down")}
          disabled={!canAct}
          className={cn(
            "items-center justify-center rounded-lg p-1 hover:bg-muted/40",
            !canAct && "opacity-40",
          )}
          accessibilityLabel={currentThumb === "down" ? "Remove dislike" : "Dislike response"}
        >
          <ThumbsDown
            className={cn(
              "h-3.5 w-3.5",
              currentThumb === "down" ? "text-destructive" : "text-muted-foreground",
            )}
            fill={currentThumb === "down" ? "currentColor" : "none"}
          />
        </Pressable>

        <Pressable
          testID="turn-footer-fork"
          onPress={handleFork}
          disabled={!canAct || forking}
          className={cn(
            "items-center justify-center rounded-lg p-1 hover:bg-muted/40",
            (!canAct || forking) && "opacity-40",
          )}
          accessibilityLabel="Fork conversation from here"
        >
          {forking ? (
            <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
          ) : (
            <GitFork className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </Pressable>
      </View>

      {relativeTime && (
        <Text className="text-[11px] text-muted-foreground/60">{relativeTime}</Text>
      )}
    </View>
  )
})

export default TurnFooter
