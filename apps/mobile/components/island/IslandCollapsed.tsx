// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Pressable, Text, View, useWindowDimensions } from "react-native"
import { Motion } from "@legendapp/motion"
import { Check, Loader2, Mic } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { formatDuration } from "../../lib/format-duration"
import { ShogoLogoMark } from "../branding/ShogoLogoMark"
import { useIslandAccent } from "./island-accent"
import {
  COLLAPSED_LEFT_WING,
  IDLE_NOTCHED_WIDTH,
  IDLE_WING,
  ISLAND_CONTENT_IN,
  ISLAND_OPEN,
  NOTCH_WIDTH,
  islandMotion,
} from "./island-motion"
import { RecordingDot, useElapsedSeconds } from "./IslandMeeting"
import { needsAttention, orderIslandSessions } from "./island-inbox"
import { ISLAND_TRIGGER_PROPS, type IslandLayout, type IslandMeetingState, type IslandSnapshot } from "./types"

export interface IslandPeek {
  title: string
  detail: string
}

export function StatusDot({ status, size = 8 }: { status: string; size?: number }) {
  const attention = status === "needs_approval" || status === "needs_answer"
  return (
    <View
      className={cn(
        "rounded-full",
        attention
          ? "bg-amber-400 animate-pulse motion-reduce:animate-none"
          : status === "running"
            ? "bg-primary"
            : status === "done"
              ? "bg-sky-400"
              : "bg-zinc-500",
      )}
      style={{ width: size, height: size }}
    />
  )
}

export function IslandCollapsed({
  snapshot,
  meeting,
  layout,
  peek,
  reducedMotion,
  onExpand,
}: {
  snapshot: IslandSnapshot
  meeting: IslandMeetingState
  layout: IslandLayout
  peek: IslandPeek | null
  reducedMotion: boolean
  onExpand: () => void
}) {
  const sessions = orderIslandSessions(snapshot.sessions)
  const top = sessions[0]
  const attentionCount = sessions.filter((s) => needsAttention(s.status)).length
  const running = sessions.some((s) => s.status === "running")
  const recordingSeconds = useElapsedSeconds(meeting.recording?.startedAt)
  const accent = useIslandAccent()
  const { width: windowWidth } = useWindowDimensions()

  // Left wing: a compact indicator. Right wing: the text, so names get the
  // whole wing instead of sharing it with the status icon.
  const left = meeting.prompt ? (
    <Mic size={13} color="#f87171" />
  ) : meeting.recording ? (
    <RecordingDot />
  ) : peek ? (
    <Check size={13} color="#38bdf8" />
  ) : attentionCount > 0 ? (
    <View className="rounded-full bg-amber-400 px-1.5 min-w-[18px] items-center">
      <Text className="text-[10px] font-bold text-black">{attentionCount}</Text>
    </View>
  ) : running ? (
    <Loader2 size={13} color={accent} className="animate-spin motion-reduce:animate-none" />
  ) : top ? (
    <StatusDot status={top.status} />
  ) : (
    <ShogoLogoMark className="h-3.5 w-3.5" fill={accent} />
  )

  // Right wing: a primary label that truncates, plus an optional trailing
  // detail pinned to the far edge so the wing reads as one full row.
  const primary = meeting.prompt
    ? meeting.prompt.app
    : meeting.recording
      ? (meeting.recording.app ?? "Recording")
      : peek
        ? peek.title
        : (top?.projectName ?? "Shogo")
  const secondary = meeting.recording || meeting.prompt
    ? null
    : peek
      ? peek.detail
      : running && top?.step
        ? top.step
        : sessions.length > 1
          ? `+${sessions.length - 1} more`
          : null
  const trailing = meeting.prompt ? (
    <View className="rounded-full bg-red-500 px-2 py-0.5">
      <Text className="text-[10px] font-bold text-white">Record?</Text>
    </View>
  ) : meeting.recording ? (
    <Text className="text-[12px] font-semibold tabular-nums text-red-300">{formatDuration(recordingSeconds)}</Text>
  ) : null
  const right = (
    <View className="flex-row items-center gap-1.5 min-w-0">
      <Text className="flex-shrink-0 max-w-[70%] text-[12px] font-semibold text-white" numberOfLines={1}>
        {primary}
      </Text>
      <Text className="min-w-0 flex-1 text-[11px] text-zinc-400" numberOfLines={1}>
        {secondary ?? ""}
      </Text>
      {trailing}
    </View>
  )

  return (
    <View className={cn("h-full w-full", layout.notched ? "items-start" : "items-center")}>
      <Motion.View
        // Notched: grow sideways out of the idle wings, which sit centered on
        // the notch (offset inside this lopsided window). Elsewhere there are
        // no wings to grow from, so the pill scales in.
        initial={
          reducedMotion
            ? undefined
            : layout.notched
              ? { width: Math.min(IDLE_NOTCHED_WIDTH, windowWidth), marginLeft: COLLAPSED_LEFT_WING - IDLE_WING }
              : { opacity: 0, scale: 0.92 }
        }
        animate={layout.notched ? { width: windowWidth, marginLeft: 0 } : { opacity: 1, scale: 1 }}
        transition={islandMotion(reducedMotion, ISLAND_OPEN)}
        style={{ height: "100%", width: layout.notched ? undefined : "100%" }}
      >
        <Pressable
          onPress={onExpand}
          {...ISLAND_TRIGGER_PROPS}
          accessibilityRole="button"
          accessibilityLabel="Open Shogo island"
          className={cn(
            "h-full w-full flex-row items-center overflow-hidden bg-black",
            layout.notched ? "rounded-b-[14px]" : "rounded-[18px] border border-white/10 px-3.5 justify-center gap-2",
          )}
        >
          <Motion.View
            initial={reducedMotion ? undefined : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={islandMotion(reducedMotion, ISLAND_CONTENT_IN)}
            style={{ flexDirection: "row", alignItems: "center", flex: 1, minWidth: 0, gap: layout.notched ? 0 : 8, justifyContent: "center" }}
          >
            {layout.notched ? (
              <>
                <View className="items-center justify-center" style={{ width: COLLAPSED_LEFT_WING }}>
                  {left}
                </View>
                <View style={{ width: NOTCH_WIDTH }} />
                <View className="flex-1 min-w-0 pl-2 pr-3.5">{right}</View>
              </>
            ) : (
              <>
                {left}
                {right}
              </>
            )}
          </Motion.View>
        </Pressable>
      </Motion.View>
    </View>
  )
}
