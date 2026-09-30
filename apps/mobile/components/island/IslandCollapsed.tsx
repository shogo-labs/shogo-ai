// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Pressable, Text, View, useWindowDimensions } from "react-native"
import { Motion } from "@legendapp/motion"
import { Check, ChevronDown, Loader2, Mic } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { formatDuration } from "../../lib/use-recording"
import { ShogoLogoMark } from "../branding/ShogoLogoMark"
import { useIslandAccent } from "./island-accent"
import { IDLE_NOTCHED_WIDTH, ISLAND_CONTENT_IN, ISLAND_OPEN, NOTCH_WIDTH, islandMotion } from "./island-motion"
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

  const left = meeting.prompt ? (
    <View className="flex-row items-center gap-2 min-w-0 flex-shrink">
      <Mic size={12} color="#f87171" />
      <Text className="text-[12px] font-semibold text-white" numberOfLines={1}>
        {meeting.prompt.app} call
      </Text>
    </View>
  ) : meeting.recording ? (
    <View className="flex-row items-center gap-2 min-w-0 flex-shrink">
      <RecordingDot />
      <Text className="text-[12px] font-semibold tabular-nums text-white" numberOfLines={1}>
        {formatDuration(recordingSeconds)}
      </Text>
    </View>
  ) : (
    <View className="flex-row items-center gap-2 min-w-0 flex-shrink">
      {top ? <StatusDot status={top.status} /> : <ShogoLogoMark className="h-3.5 w-3.5" fill={accent} />}
      <Text className="text-[12px] font-semibold text-white" numberOfLines={1}>
        {peek?.title ?? top?.projectName ?? "Shogo"}
      </Text>
    </View>
  )

  const right = meeting.prompt ? (
    <View className="rounded-full bg-red-500 px-2 py-0.5">
      <Text className="text-[10px] font-bold text-white">Record?</Text>
    </View>
  ) : (
    <View className="flex-row items-center gap-1.5 min-w-0 flex-shrink">
      {peek ? (
        <>
          <Check size={12} color="#38bdf8" />
          <Text className="text-[11px] text-zinc-300" numberOfLines={1}>
            {peek.detail}
          </Text>
        </>
      ) : attentionCount > 0 ? (
        <View className="rounded-full bg-amber-400 px-1.5 min-w-[18px] items-center">
          <Text className="text-[10px] font-bold text-black">{attentionCount}</Text>
        </View>
      ) : running ? (
        <>
          <Loader2 size={12} color={accent} className="animate-spin motion-reduce:animate-none" />
          {top?.step ? (
            <Text className="text-[11px] text-zinc-400" numberOfLines={1}>
              {top.step}
            </Text>
          ) : null}
        </>
      ) : sessions.length > 0 ? (
        <Text className="text-[11px] text-zinc-400">{sessions.length}</Text>
      ) : (
        <ChevronDown size={12} color="#a1a1aa" />
      )}
    </View>
  )

  return (
    <View className="h-full w-full items-center">
      <Motion.View
        // Notched: grow sideways out of the idle wings. Elsewhere there are
        // no wings to grow from, so the pill scales in.
        initial={
          reducedMotion
            ? undefined
            : layout.notched
              ? { width: Math.min(IDLE_NOTCHED_WIDTH, windowWidth) }
              : { opacity: 0, scale: 0.92 }
        }
        animate={layout.notched ? { width: windowWidth } : { opacity: 1, scale: 1 }}
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
            layout.notched ? "rounded-b-[14px] px-3.5" : "rounded-[18px] border border-white/10 px-3.5 justify-center gap-2",
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
                <View className="flex-1 min-w-0">{left}</View>
                <View style={{ width: NOTCH_WIDTH }} />
                <View className="flex-1 min-w-0 items-end">{right}</View>
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
