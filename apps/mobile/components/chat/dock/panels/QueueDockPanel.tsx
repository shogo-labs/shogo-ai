// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Queued messages — rows moved verbatim out of `ChatInput.tsx`'s old
 * `rounded-t-lg` block, preserving reorder / send-now / edit / delete and
 * the offline styling. The header + collapse chrome are now `DockPanel`'s
 * job, so this only renders the row list.
 */

import { useMemo, useState } from "react"
import { View, Text, Pressable, Image, Platform } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  ChevronUp,
  ChevronDown,
  SendHorizontal,
  Pencil,
  Trash2,
  WifiOff,
  AlertTriangle,
  AlarmClock,
  Image as ImageIcon,
  ListOrdered,
  PauseCircle,
  Play,
} from "lucide-react-native"
import { useDockPanel } from "../useDockPanel"
import type {
  DockPanelDescriptor,
  DockIconComponent,
} from "../../../../lib/chat-dock-store"
import { wakeRefusalMessage } from "../../../../lib/wake-refusal"
import type { QueuedMessage } from "../../ChatInput"
import { stripAskUserAnswerMarker } from "../../turns/askUserAnswers"

export interface QueueDockPanelProps {
  queuedMessages: QueuedMessage[]
  onRemoveQueuedMessage?: (messageId: string) => void
  onReorderQueuedMessage?: (messageId: string, direction: "up" | "down") => void
  onEditQueuedMessage?: (messageId: string) => void
  onSendQueuedMessageNow?: (messageId: string) => void
  onResumeTaskWakes?: (messageId: string) => void
  /** Team-chat wakes: their own queue, so their own routes. A rejected promise
   *  is the server's refusal (409 not_pending, 403 viewer), shown on the row. */
  onSendAgentWakeNow?: (wakeId: string) => void | Promise<void>
  onRemoveAgentWake?: (wakeId: string) => void | Promise<void>
}

/** The agent's own updates, held back by a wake pause. Never a queued message. */
export function waitingTaskWakes(queuedMessages: QueuedMessage[]): QueuedMessage[] {
  return queuedMessages.filter((msg) => msg.kind === "task_wake" && msg.paused)
}

/** The messages a person actually typed and is still waiting on. */
export function chatQueuedMessages(queuedMessages: QueuedMessage[]): QueuedMessage[] {
  return queuedMessages.filter(
    (msg) => msg.kind !== "task_wake" && msg.kind !== "agent_wake",
  )
}

/** Team-chat messages waiting behind a reply: one `AgentWake` row each. */
export function agentWakeMessages(
  queuedMessages: QueuedMessage[],
): QueuedMessage[] {
  return queuedMessages.filter((msg) => msg.kind === "agent_wake")
}

/**
 * One chip for everything a paused session is holding: the count, the titles,
 * why the session stopped, and Resume. The same updates in the task dock read
 * "waiting" rather than finished-and-unseen, and the agent's own prompt says
 * they are queued.
 */
/** The task's title off a queued wake note ("[Task update] SHO-88 Sim kernel (t_ab12) completed."). */
export function taskTitle(content: string): string {
  const first = content.split("\n")[0]!.trim()
  const note = /^\[Task update\]\s*(.*?)\s*\(t_[^)]*\)/.exec(first)
  return (note?.[1] ?? first).trim()
}

export function WaitingWakes({
  wakes,
  onResume,
}: {
  wakes: QueuedMessage[]
  onResume?: (messageId: string) => void
}) {
  const newest = wakes[wakes.length - 1]
  if (!newest) return null
  const count = wakes.length
  const titles = wakes.map((wake) => taskTitle(wake.content)).filter(Boolean)
  return (
    <View className="border-b border-border/40 bg-amber-500/10 px-3 py-2">
      <View className="flex-row items-center gap-2">
        <PauseCircle size={12} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
        <Text
          className="text-xs font-medium text-foreground flex-1 min-w-0"
          numberOfLines={1}
        >
          {count === 1
            ? "1 background update waiting"
            : `${count} background updates waiting`}
        </Text>
        {onResume ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Resume background updates"
            onPress={() => onResume(newest.id)}
            className="flex-row items-center gap-1 rounded border border-border px-2 py-0.5 active:opacity-60"
          >
            <Play size={10} className="text-foreground" />
            <Text className="text-[10px] font-medium text-foreground">Resume</Text>
          </Pressable>
        ) : null}
      </View>
      {titles.length > 0 ? (
        <Text className="mt-0.5 text-[10px] text-muted-foreground" numberOfLines={2}>
          {titles.join(" · ")}
        </Text>
      ) : null}
      <Text className="mt-0.5 text-[10px] text-muted-foreground" numberOfLines={2}>
        Paused after several automatic wake turns without a message. Resume to
        deliver them now.
      </Text>
    </View>
  )
}

// Hover is CSS-only. RN-Web's JS `hovered` state goes stale when the dock
// (bottom-anchored, so it grows upward) shifts rows under a stationary
// cursor, highlighting whichever row used to be there.
function QueueAction({
  label,
  icon: Icon,
  destructive = false,
  onPress,
}: {
  label: string
  icon: DockIconComponent
  destructive?: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      onPress={(e) => {
        if (e?.stopPropagation) e.stopPropagation()
        onPress()
      }}
      className={cn(
        "h-6 w-6 items-center justify-center rounded",
        destructive
          ? "hover:bg-destructive/20 active:bg-destructive/20"
          : "hover:bg-muted-foreground/25 active:bg-muted-foreground/25",
      )}
    >
      <Icon size={12} className="text-muted-foreground" />
    </Pressable>
  )
}

/**
 * A team-chat message waiting behind this session's reply. Its two buttons press
 * the wake routes, and a refusal (409 not_pending, 403 viewer) is shown on the
 * row rather than swallowed, so the dock says the same thing the thread's note does.
 */
function AgentWakeRow({
  msg,
  onSendNow,
  onRemove,
}: {
  msg: QueuedMessage
  onSendNow?: (wakeId: string) => void | Promise<void>
  onRemove?: (wakeId: string) => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const act = (run: () => void | Promise<void>) => {
    if (busy) return
    setError(null)
    setBusy(true)
    void Promise.resolve(run())
      .catch((err: unknown) => setError(wakeRefusalMessage(err)))
      .finally(() => setBusy(false))
  }

  return (
    <View
      testID={`agent-wake-${msg.id}`}
      accessibilityLabel="Queued team-chat message"
      className={cn(
        "group flex-row items-center gap-2 px-3 py-0.5 border-b border-border/40 last:border-b-0",
        Platform.OS === "web" && "hover:bg-muted/40",
      )}
    >
      <AlarmClock
        size={11}
        className="text-amber-600 dark:text-amber-400 flex-shrink-0"
      />
      <View className="flex-1 min-w-0 py-1">
        {msg.source ? (
          <Text
            className="text-[10px] text-muted-foreground"
            numberOfLines={1}
          >
            {msg.source}
          </Text>
        ) : null}
        <Text className="text-xs text-foreground" numberOfLines={1}>
          {msg.content}
        </Text>
        {error ? (
          <Text className="text-[10px] text-destructive" numberOfLines={2}>
            {error}
          </Text>
        ) : null}
      </View>
      <View className="flex-row items-center gap-0.5">
        {onSendNow && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send queued message now"
            disabled={busy}
            onPress={() => act(() => onSendNow(msg.id))}
            className={cn(
              "flex-row items-center gap-1 rounded border border-border px-2 py-0.5 active:opacity-60",
              busy && "opacity-60",
            )}
          >
            <SendHorizontal size={10} className="text-foreground" />
            <Text className="text-[10px] font-medium text-foreground">
              Send now
            </Text>
          </Pressable>
        )}
        {onRemove && (
          <QueueAction
            label="Delete queued message"
            icon={Trash2}
            destructive
            onPress={() => act(() => onRemove(msg.id))}
          />
        )}
      </View>
    </View>
  )
}

function QueueBody({
  queuedMessages,
  onRemoveQueuedMessage,
  onReorderQueuedMessage,
  onEditQueuedMessage,
  onSendQueuedMessageNow,
  onResumeTaskWakes,
  onSendAgentWakeNow,
  onRemoveAgentWake,
}: QueueDockPanelProps) {
  const wakes = waitingTaskWakes(queuedMessages)
  const messages = chatQueuedMessages(queuedMessages)
  const agentWakes = agentWakeMessages(queuedMessages)
  return (
    <View>
      <WaitingWakes wakes={wakes} onResume={onResumeTaskWakes} />
      {agentWakes.map((msg) => (
        <AgentWakeRow
          key={msg.id}
          msg={msg}
          onSendNow={onSendAgentWakeNow}
          onRemove={onRemoveAgentWake}
        />
      ))}
      {messages.map((msg, index) => {
        const files = msg.files ?? []
        const imageFiles = files.filter((f) => f.type?.startsWith("image/"))
        const otherFiles = files.filter((f) => !f.type?.startsWith("image/"))
        const previewImage = imageFiles[0]
        const trimmedContent = stripAskUserAnswerMarker(
          msg.content?.trim() ?? "",
        ).trim()
        const attachmentLabel =
          files.length > 0
            ? `${files.length} ${files.length === 1 ? "attachment" : "attachments"}`
            : ""
        const primaryText = trimmedContent
          ? trimmedContent
          : attachmentLabel || "Empty message"
        return (
          <Pressable
            key={msg.id}
            onPress={() => onEditQueuedMessage?.(msg.id)}
            accessibilityLabel="Queued message"
            className={cn(
              "group flex-row items-center gap-2 px-3 py-0.5 border-b border-border/40 last:border-b-0",
              Platform.OS === "web" && "hover:bg-muted/40",
            )}
          >
            {msg.status === "failed" ? (
              <AlertTriangle
                size={11}
                className="text-destructive flex-shrink-0"
              />
            ) : msg.offline ? (
              <WifiOff
                size={11}
                className="text-orange-600 dark:text-orange-400 flex-shrink-0"
              />
            ) : (
              <View className="h-3 w-3 rounded-full border border-muted-foreground/30 flex-shrink-0" />
            )}
            {previewImage && (
              <Image
                source={{ uri: previewImage.dataUrl }}
                className="h-6 w-6 rounded border border-border flex-shrink-0"
                resizeMode="cover"
              />
            )}
            <View className="flex-1 min-w-0 py-1">
              <Text
                className={cn(
                  "text-xs",
                  msg.status === "failed"
                    ? "text-destructive"
                    : "text-foreground",
                )}
                numberOfLines={1}
              >
                {primaryText}
              </Text>
              {msg.error && (
                <Text
                  className="text-[10px] text-destructive"
                  numberOfLines={1}
                >
                  {msg.error}
                </Text>
              )}
              {trimmedContent && files.length > 0 && (
                <View className="flex-row items-center gap-1 mt-0.5">
                  <ImageIcon
                    className="h-3 w-3 text-muted-foreground"
                    size={10}
                  />
                  <Text
                    className="text-[10px] text-muted-foreground"
                    numberOfLines={1}
                  >
                    {imageFiles.length > 0 && otherFiles.length > 0
                      ? `${imageFiles.length} image${imageFiles.length === 1 ? "" : "s"} + ${otherFiles.length} file${otherFiles.length === 1 ? "" : "s"}`
                      : imageFiles.length > 0
                        ? `${imageFiles.length} image${imageFiles.length === 1 ? "" : "s"}`
                        : `${otherFiles.length} file${otherFiles.length === 1 ? "" : "s"}`}
                  </Text>
                </View>
              )}
            </View>
            <View
              className={cn(
                "flex-row items-center gap-0.5",
                Platform.OS === "web" && "opacity-0 group-hover:opacity-100",
              )}
            >
              {onReorderQueuedMessage &&
                messages.length > 1 &&
                index > 0 && (
                  <QueueAction
                    label="Move queued message up"
                    icon={ChevronUp}
                    onPress={() => onReorderQueuedMessage(msg.id, "up")}
                  />
                )}
              {onReorderQueuedMessage &&
                messages.length > 1 &&
                index < messages.length - 1 && (
                  <QueueAction
                    label="Move queued message down"
                    icon={ChevronDown}
                    onPress={() => onReorderQueuedMessage(msg.id, "down")}
                  />
                )}
              {onSendQueuedMessageNow && (
                <QueueAction
                  label="Send queued message now"
                  icon={SendHorizontal}
                  onPress={() => onSendQueuedMessageNow(msg.id)}
                />
              )}
              {onEditQueuedMessage && (
                <QueueAction
                  label="Edit queued message"
                  icon={Pencil}
                  onPress={() => onEditQueuedMessage(msg.id)}
                />
              )}
              {onRemoveQueuedMessage && (
                <QueueAction
                  label="Delete queued message"
                  icon={Trash2}
                  destructive
                  onPress={() => onRemoveQueuedMessage(msg.id)}
                />
              )}
            </View>
          </Pressable>
        )
      })}
    </View>
  )
}

export function QueueDockPanel(props: QueueDockPanelProps) {
  const { queuedMessages } = props
  const messages = chatQueuedMessages(queuedMessages)
  const wakeCount = waitingTaskWakes(queuedMessages).length
  const agentWakeCount = agentWakeMessages(queuedMessages).length
  const offlineCount = messages.filter((m) => m.offline).length
  const queuedCount = messages.length + agentWakeCount
  const parts = [
    offlineCount > 0 ? `${offlineCount} waiting` : null,
    queuedCount > offlineCount ? `${queuedCount - offlineCount} queued` : null,
    wakeCount > 0 ? `${wakeCount} update${wakeCount === 1 ? "" : "s"} paused` : null,
  ].filter(Boolean)

  const descriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (queuedMessages.length === 0) return null
    return {
      id: "queue",
      kind: "status",
      order: 70,
      title: "Queue",
      icon: ListOrdered,
      accent: wakeCount > 0 ? "warning" : offlineCount > 0 ? "warning" : "default",
      summary: parts.join(" · "),
      defaultExpanded: true,
      flushBody: true,
      render: () => <QueueBody {...props} />,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props, offlineCount, wakeCount, parts.join("|")])

  useDockPanel(descriptor)
  return null
}
