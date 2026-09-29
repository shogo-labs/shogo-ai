// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useState } from "react"
import { ActivityIndicator, Pressable, Text, View } from "react-native"
import { Mic, Square, X } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { formatDuration } from "../../lib/use-recording"
import type { IslandMeetingDecision, IslandMeetingState } from "./types"

export function useElapsedSeconds(startedAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt === undefined ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
}

export function RecordingDot({ size = 8 }: { size?: number }) {
  return (
    <View
      className="rounded-full bg-red-500 animate-pulse motion-reduce:animate-none"
      style={{ width: size, height: size }}
    />
  )
}

function MeetingButton({
  label,
  onPress,
  tone = "secondary",
  disabled,
}: {
  label: string
  onPress: () => void
  tone?: "primary" | "secondary" | "danger"
  disabled?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={cn(
        "rounded-lg px-2.5 py-1.5",
        tone === "primary" ? "bg-red-500 hover:bg-red-400" : tone === "danger" ? "bg-white/10" : "bg-white/5 hover:bg-white/10",
        disabled && "opacity-50",
      )}
    >
      <Text className={cn("text-[11px] font-semibold", tone === "primary" ? "text-white" : "text-zinc-200")}>
        {label}
      </Text>
    </Pressable>
  )
}

/** Meeting prompt, recording controls, and recording errors, shown above
 * whatever the island card is displaying. */
export function IslandMeetingBanner({
  meeting,
  onDecision,
  onOpenMeetings,
}: {
  meeting: IslandMeetingState
  onDecision: (decision: IslandMeetingDecision, promptId?: string) => void
  onOpenMeetings: () => void
}) {
  const elapsed = useElapsedSeconds(meeting.recording?.startedAt)
  const { prompt, recording, busy, error } = meeting
  if (!prompt && !recording && !error) return null

  return (
    <View className="mx-2 mb-2 gap-1.5 rounded-xl border border-white/10 bg-zinc-900 px-3 py-2">
      {recording ? (
        <View className="flex-row items-center gap-2">
          <RecordingDot />
          <Pressable onPress={onOpenMeetings} className="min-w-0 flex-1">
            <Text className="text-[12px] font-semibold text-zinc-50" numberOfLines={1}>
              Recording{recording.app ? ` ${recording.app}` : ""} · {formatDuration(elapsed)}
            </Text>
            <Text className="text-[10px] text-zinc-500">Shogo will transcribe it when you stop.</Text>
          </Pressable>
          {busy ? (
            <ActivityIndicator size="small" color="#a1a1aa" />
          ) : (
            <Pressable
              onPress={() => onDecision("stop")}
              accessibilityLabel="Stop recording"
              className="flex-row items-center gap-1 rounded-lg bg-white/10 px-2 py-1.5"
            >
              <Square size={10} color="#fafafa" fill="#fafafa" />
              <Text className="text-[11px] font-semibold text-zinc-50">Stop</Text>
            </Pressable>
          )}
        </View>
      ) : prompt ? (
        <>
          <View className="flex-row items-center gap-2">
            <View className="h-6 w-6 items-center justify-center rounded-full bg-red-500/15">
              <Mic size={13} color="#f87171" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-[12px] font-semibold text-zinc-50" numberOfLines={1}>
                {prompt.app} call detected
              </Text>
              <Text className="text-[10px] text-zinc-400">Record it with Shogo?</Text>
            </View>
            <Pressable onPress={() => onDecision("dismiss")} accessibilityLabel="Not now" hitSlop={6}>
              <X size={13} color="#71717a" />
            </Pressable>
          </View>
          <View className="flex-row items-center justify-end gap-1.5">
            {busy ? <ActivityIndicator size="small" color="#a1a1aa" /> : null}
            <MeetingButton label="Not now" onPress={() => onDecision("dismiss")} disabled={busy} />
            {prompt.suggestAutoRecord ? (
              <MeetingButton label="Always record" onPress={() => onDecision("always", prompt.id)} disabled={busy} />
            ) : null}
            <MeetingButton label="Record" tone="primary" onPress={() => onDecision("record", prompt.id)} disabled={busy} />
          </View>
        </>
      ) : null}
      {error ? (
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 flex-1 text-[11px] text-rose-400">{error}</Text>
          {!prompt && !recording ? (
            <Pressable onPress={() => onDecision("dismiss")} accessibilityLabel="Dismiss" hitSlop={6}>
              <X size={12} color="#71717a" />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}
