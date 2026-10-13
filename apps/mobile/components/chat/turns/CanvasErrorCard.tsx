// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Read-only recap of a canvas-error "Debug" prompt.
 *
 * Same shell as a channel-dispatch card. The diagnostic markdown stays on
 * the message for the model and is not shown here.
 */

import { useState } from "react"
import { Pressable, Text, View } from "react-native"
import { Bug } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import type { CanvasErrorPrompt } from "./canvasErrorPrompt"

export interface CanvasErrorCardProps {
  prompt: CanvasErrorPrompt
  variant?: "bubble" | "row"
  className?: string
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function CanvasErrorCard({
  prompt,
  variant = "row",
  className,
}: CanvasErrorCardProps) {
  const [open, setOpen] = useState(false)
  const isBubble = variant === "bubble"
  const phaseLabel = prompt.phase === "compile" ? "COMPILE-TIME" : "RUNTIME"
  const where = prompt.route ? `${phaseLabel} · ${prompt.route}` : phaseLabel
  const errorIsLong = prompt.error.length > 180 || prompt.error.includes("\n")
  const hasLists = prompt.actions.length > 0 || prompt.logs.length > 0
  const canExpand = errorIsLong || hasLists
  const meta = [
    prompt.actions.length > 0
      ? countLabel(prompt.actions.length, "recent action", "recent actions")
      : null,
    prompt.logs.length > 0
      ? countLabel(prompt.logs.length, "log line", "log lines")
      : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <View
      className={cn(
        isBubble ? "w-full max-w-[85%] self-end" : "w-full",
        className,
      )}
    >
      <View
        className={cn(
          "gap-3 rounded-2xl border px-3.5 py-3",
          isBubble
            ? "border-white/10 bg-[#2a2a2a]"
            : "border-border/50 bg-secondary/60",
        )}
      >
        <View className="flex-row items-center gap-2">
          <View
            className={cn(
              "h-6 w-6 items-center justify-center rounded-full",
              isBubble ? "bg-white/10" : "bg-primary/10",
            )}
          >
            <Bug
              size={14}
              className={isBubble ? "text-white/80" : "text-primary"}
            />
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text
              className={cn(
                "text-xs font-semibold",
                isBubble ? "text-white" : "text-foreground",
              )}
            >
              Canvas error
            </Text>
            <Text
              className={cn(
                "font-mono text-[9px] font-semibold tracking-wide",
                isBubble ? "text-white/55" : "text-muted-foreground",
              )}
            >
              {where}
            </Text>
          </View>
        </View>

        <Text
          numberOfLines={open ? undefined : 4}
          className={cn(
            "font-mono text-xs",
            isBubble ? "text-white/90" : "text-foreground",
          )}
        >
          {prompt.error}
        </Text>

        {meta || canExpand ? (
          <View className="flex-row items-center justify-between gap-3">
            {meta ? (
              <Text
                className={cn(
                  "flex-1 text-[11px]",
                  isBubble ? "text-white/55" : "text-muted-foreground",
                )}
              >
                {meta}
              </Text>
            ) : (
              <View className="flex-1" />
            )}
            {canExpand ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  open ? "Hide error details" : "Show error details"
                }
                onPress={() => setOpen((value) => !value)}
              >
                <Text
                  className={cn(
                    "text-xs font-semibold",
                    isBubble ? "text-white" : "text-foreground",
                  )}
                >
                  {open ? "Hide details" : "Show details"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {open && prompt.actions.length > 0 ? (
          <View className="gap-1">
            <Text
              className={cn(
                "font-mono text-[9px] font-semibold uppercase tracking-wide",
                isBubble ? "text-white/55" : "text-muted-foreground",
              )}
            >
              Recent actions
            </Text>
            {prompt.actions.map((line, index) => (
              <Text
                key={`action-${index}`}
                className={cn(
                  "font-mono text-[11px]",
                  isBubble ? "text-white/80" : "text-foreground",
                )}
              >
                {line}
              </Text>
            ))}
          </View>
        ) : null}

        {open && prompt.logs.length > 0 ? (
          <View className="gap-1">
            <Text
              className={cn(
                "font-mono text-[9px] font-semibold uppercase tracking-wide",
                isBubble ? "text-white/55" : "text-muted-foreground",
              )}
            >
              Runtime logs
            </Text>
            {prompt.logs.map((line, index) => (
              <Text
                key={`log-${index}`}
                className={cn(
                  "font-mono text-[11px]",
                  isBubble ? "text-white/80" : "text-foreground",
                )}
              >
                {line}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  )
}

export default CanvasErrorCard
