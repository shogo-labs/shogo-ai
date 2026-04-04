// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TeamCard Component (React Native)
 *
 * Renders a card for team_create tool calls showing team name, member count,
 * task progress, and active teammate count. Pressable to navigate to the
 * Agents tab > Team sub-tab.
 */

import { useCallback, useSyncExternalStore, useMemo } from "react"
import { View, Text, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { Users, CheckCircle2, ChevronRight } from "lucide-react-native"
import { Motion } from "@legendapp/motion"
import type { ToolCallData } from "../tools/types"
import { teamStore } from "../../../lib/team-store"
import { subagentStreamStore } from "../../../lib/subagent-stream-store"

export interface TeamCardProps {
  tool: ToolCallData
  className?: string
}

const PULSE_DURATION = 1200

function PulsingDot() {
  return (
    <Motion.View
      initial={{ opacity: 0.4, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{
        type: "timing",
        duration: PULSE_DURATION,
        easing: "easeInOut",
        repeat: Infinity,
        repeatReverse: true,
      }}
      className="w-2 h-2 rounded-full bg-primary"
    />
  )
}

export function TeamCard({ tool, className }: TeamCardProps) {
  const storeVersion = useSyncExternalStore(
    teamStore.subscribe,
    () => teamStore.getVersion(),
    () => teamStore.getVersion(),
  )

  const args = tool.args as Record<string, unknown> | undefined
  const teamName = (args?.team_name as string) ?? "Team"
  const teamId = teamName

  const teamData = useMemo(() => teamStore.getTeam(teamId), [teamId, storeVersion])

  const memberCount = teamData?.members.size ?? 0
  const activeMembers = teamData
    ? [...teamData.members.values()].filter((m) => m.status === "active").length
    : 0

  const taskStats = useMemo(() => {
    if (!teamData) return { total: 0, completed: 0 }
    let total = 0
    let completed = 0
    for (const t of teamData.tasks.values()) {
      if (t.status !== "deleted") total++
      if (t.status === "completed") completed++
    }
    return { total, completed }
  }, [teamData, storeVersion])

  const isRunning = tool.state === "streaming"
  const isDone = tool.state === "success"

  const handlePress = useCallback(() => {
    subagentStreamStore.requestTabSwitch()
  }, [])

  return (
    <Pressable
      onPress={handlePress}
      className={cn(
        "overflow-hidden rounded-lg border border-border/40 bg-muted/20",
        className,
      )}
    >
      <View className="px-3 py-3 gap-2">
        <View className="flex-row items-center gap-2">
          <Users className="w-4 h-4 text-muted-foreground" size={16} />
          <Text
            className="flex-1 text-xs font-semibold text-foreground"
            numberOfLines={1}
          >
            {teamName}
          </Text>
          <Text className="text-[10px] text-muted-foreground font-mono px-1.5 py-0.5 rounded bg-muted/60">
            team
          </Text>
          {isRunning && <PulsingDot />}
          {isDone && (
            <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground" size={14} />
          )}
        </View>

        <View className="flex-row items-center gap-3">
          {memberCount > 0 && (
            <Text className="text-[11px] text-muted-foreground">
              {activeMembers}/{memberCount} active
            </Text>
          )}
          {taskStats.total > 0 && (
            <Text className="text-[11px] text-muted-foreground">
              {taskStats.completed}/{taskStats.total} tasks
            </Text>
          )}
          {memberCount === 0 && taskStats.total === 0 && (
            <Text className="text-[11px] text-muted-foreground">
              {isDone ? "Team created" : "Creating team..."}
            </Text>
          )}
          <View className="flex-1" />
          <ChevronRight
            className="w-3.5 h-3.5 text-muted-foreground/50"
            size={14}
          />
        </View>
      </View>
    </Pressable>
  )
}

export default TeamCard
