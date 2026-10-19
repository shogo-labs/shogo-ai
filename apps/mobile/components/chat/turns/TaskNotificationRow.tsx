// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The system's wake message after background tasks finished, shown as a
 * compact row per task instead of a user bubble. The full text (output file,
 * last output) stays on the message for the model and opens on tap.
 */

import { useState } from "react"
import { Pressable, Text, View } from "react-native"
import { Ban, CheckCircle2, XCircle } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import type { TaskNotification, TaskUpdateLine } from "@shogo/shared-app/chat"
import { useChatContextSafe } from "../ChatContext"

function iconFor(outcome: string) {
  if (outcome.startsWith("failed")) return { Icon: XCircle, tone: "text-destructive" }
  if (outcome.includes("cancelled")) return { Icon: Ban, tone: "text-muted-foreground" }
  return { Icon: CheckCircle2, tone: "text-emerald-500" }
}

function UpdateRow({ update }: { update: TaskUpdateLine }) {
  const [open, setOpen] = useState(false)
  const chat = useChatContextSafe()
  const openTask = chat?.openTaskThread
  const { Icon, tone } = iconFor(update.outcome)
  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-1">
        <Pressable
          onPress={() => (openTask ? openTask(update.taskId, { title: update.title }) : setOpen((v) => !v))}
          disabled={!update.detail && !openTask}
          accessibilityRole="button"
          accessibilityLabel={
            openTask ? `Open ${update.title} thread` : `${update.title} ${update.outcome}`
          }
          className="min-w-0 flex-1 flex-row items-center gap-2"
        >
          <Icon size={13} className={tone} />
          <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>
            <Text className="font-medium text-foreground">{update.title}</Text>
            {` ${update.outcome}`}
          </Text>
        </Pressable>
        {update.detail ? (
          <Pressable
            onPress={() => setOpen((v) => !v)}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={open ? "Hide log" : "Show log"}
            className="rounded px-1 py-0.5 active:opacity-60"
          >
            <Text className="text-[10px] text-muted-foreground">{open ? "Hide" : "Log"}</Text>
          </Pressable>
        ) : null}
      </View>
      {open && update.detail ? (
        <Text className="ml-5 font-mono text-[11px] text-muted-foreground" selectable>
          {update.detail}
        </Text>
      ) : null}
    </View>
  )
}

export function TaskNotificationRow({
  notification,
  className,
}: {
  notification: TaskNotification
  className?: string
}) {
  const count = notification.updates.length || notification.taskIds.length
  return (
    <View
      className={cn("w-full gap-1.5 rounded-xl border border-border/40 bg-secondary/40 px-3 py-2", className)}
      accessibilityLabel="Background tasks finished"
    >
      <Text className="font-mono text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
        {count === 1 ? "Background task finished" : `${count} background tasks finished`}
      </Text>
      {notification.updates.map((update) => (
        <UpdateRow key={update.taskId} update={update} />
      ))}
    </View>
  )
}

export default TaskNotificationRow
