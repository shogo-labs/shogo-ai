// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Queued messages — rows moved verbatim out of `ChatInput.tsx`'s old
 * `rounded-t-lg` block, preserving reorder / send-now / edit / delete and
 * the offline styling. The header + collapse chrome are now `DockPanel`'s
 * job, so this only renders the row list.
 */

import { useMemo } from "react"
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
  Image as ImageIcon,
  ListOrdered,
} from "lucide-react-native"
import { useDockPanel } from "../useDockPanel"
import type { DockPanelDescriptor, DockIconComponent } from "../../../../lib/chat-dock-store"
import type { QueuedMessage } from "../../ChatInput"

export interface QueueDockPanelProps {
  queuedMessages: QueuedMessage[]
  onRemoveQueuedMessage?: (messageId: string) => void
  onReorderQueuedMessage?: (messageId: string, direction: "up" | "down") => void
  onEditQueuedMessage?: (messageId: string) => void
  onSendQueuedMessageNow?: (messageId: string) => void
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

function QueueBody({
  queuedMessages,
  onRemoveQueuedMessage,
  onReorderQueuedMessage,
  onEditQueuedMessage,
  onSendQueuedMessageNow,
}: QueueDockPanelProps) {
  return (
    <View>
      {queuedMessages.map((msg, index) => {
        const files = msg.files ?? []
        const imageFiles = files.filter((f) => f.type?.startsWith("image/"))
        const otherFiles = files.filter((f) => !f.type?.startsWith("image/"))
        const previewImage = imageFiles[0]
        const trimmedContent = msg.content?.trim() ?? ""
        const attachmentLabel =
          files.length > 0 ? `${files.length} ${files.length === 1 ? "attachment" : "attachments"}` : ""
        const primaryText = trimmedContent ? trimmedContent : attachmentLabel || "Empty message"
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
              <AlertTriangle size={11} className="text-destructive flex-shrink-0" />
            ) : msg.offline ? (
              <WifiOff size={11} className="text-orange-600 dark:text-orange-400 flex-shrink-0" />
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
              <Text className={cn("text-xs", msg.status === "failed" ? "text-destructive" : "text-foreground")} numberOfLines={1}>
                {primaryText}
              </Text>
              {msg.error && (
                <Text className="text-[10px] text-destructive" numberOfLines={1}>
                  {msg.error}
                </Text>
              )}
              {trimmedContent && files.length > 0 && (
                <View className="flex-row items-center gap-1 mt-0.5">
                  <ImageIcon className="h-3 w-3 text-muted-foreground" size={10} />
                  <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
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
              {onReorderQueuedMessage && queuedMessages.length > 1 && index > 0 && (
                <QueueAction
                  label="Move queued message up"
                  icon={ChevronUp}
                  onPress={() => onReorderQueuedMessage(msg.id, "up")}
                />
              )}
              {onReorderQueuedMessage && queuedMessages.length > 1 && index < queuedMessages.length - 1 && (
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
  const offlineCount = queuedMessages.filter((m) => m.offline).length

  const descriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (queuedMessages.length === 0) return null
    return {
      id: "queue",
      kind: "status",
      order: 70,
      title: "Queue",
      icon: ListOrdered,
      accent: offlineCount > 0 ? "warning" : "default",
      summary:
        offlineCount > 0
          ? `${offlineCount} waiting${queuedMessages.length > offlineCount ? ` · ${queuedMessages.length - offlineCount} queued` : ""}`
          : `${queuedMessages.length} queued`,
      defaultExpanded: true,
      flushBody: true,
      render: () => <QueueBody {...props} />,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props, offlineCount])

  useDockPanel(descriptor)
  return null
}
