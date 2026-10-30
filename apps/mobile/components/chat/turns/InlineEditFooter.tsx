// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Footer of the in-place message editor (SHO-263).
 *
 * Replaces the old "Edit message?" modal: the revert/keep choice, the
 * "what happens on send" label and the keyboard hint all live inline,
 * under the editor that sits in the transcript. Presentational only —
 * the editor owns the state.
 */

import { Pressable, Text, View } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"

export interface InlineEditRevertControl {
  checked: boolean
  /** "Revert files to before this message" */
  label: string
  /** "Checkpoint from 3 minutes ago · 4 files changed" */
  hint?: string
  onChange: (next: boolean) => void
}

export interface InlineEditFooterProps {
  /** "Revert & resend" / "Resend" / "Send" */
  submitLabel: string
  /** "Esc to cancel · ⏎ to send" */
  hint: string
  canSend: boolean
  busy?: boolean
  /** API error from the last attempt, shown inline under the editor. */
  error?: string | null
  onCancel: () => void
  onSend: () => void
  revert?: InlineEditRevertControl | null
  className?: string
}

export function InlineEditFooter({
  submitLabel,
  hint,
  canSend,
  busy = false,
  error,
  onCancel,
  onSend,
  revert,
  className,
}: InlineEditFooterProps) {
  return (
    <View className={cn("gap-2 pt-1.5", className)}>
      {error ? (
        <Text
          role="alert"
          accessibilityRole="alert"
          className="text-xs text-destructive leading-5"
        >
          {error}
        </Text>
      ) : null}

      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <View className="flex-1 min-w-[180px]">
          {revert ? (
            <Pressable
              onPress={() => revert.onChange(!revert.checked)}
              role="checkbox"
              aria-checked={revert.checked}
              accessibilityRole="checkbox"
              accessibilityLabel={revert.label}
              accessibilityState={{ checked: revert.checked }}
              className="flex-row items-start gap-2"
            >
              <View
                className={cn(
                  "h-4 w-4 mt-0.5 rounded border items-center justify-center",
                  revert.checked
                    ? "bg-primary border-primary"
                    : "border-muted-foreground/50 bg-transparent",
                )}
              >
                {revert.checked ? (
                  <Text className="text-[10px] leading-3 text-primary-foreground">
                    ✓
                  </Text>
                ) : null}
              </View>
              <View className="flex-1">
                <Text className="text-xs font-medium text-foreground">
                  {revert.label}
                </Text>
                {revert.hint ? (
                  <Text className="text-[11px] text-muted-foreground mt-0.5">
                    {revert.hint}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ) : null}
        </View>

        <View className="flex-row items-center gap-2">
          <Text className="text-[11px] text-muted-foreground mr-1">{hint}</Text>
          <Pressable
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel editing"
            className="h-7 px-2.5 rounded-md items-center justify-center border border-border/60 active:opacity-70"
          >
            <Text className="text-xs text-foreground">Cancel</Text>
          </Pressable>
          <Pressable
            onPress={onSend}
            disabled={!canSend || busy}
            accessibilityRole="button"
            accessibilityLabel={submitLabel}
            accessibilityState={{ disabled: !canSend || busy }}
            className={cn(
              "h-7 px-3 rounded-md items-center justify-center active:opacity-80",
              canSend && !busy ? "bg-primary" : "bg-muted",
            )}
          >
            <Text
              className={cn(
                "text-xs font-medium",
                canSend && !busy
                  ? "text-primary-foreground"
                  : "text-muted-foreground",
              )}
            >
              {busy ? "Sending…" : submitLabel}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  )
}

export default InlineEditFooter
