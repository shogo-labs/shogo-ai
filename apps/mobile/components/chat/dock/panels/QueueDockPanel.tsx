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
  Image as ImageIcon,
  ListOrdered,
} from "lucide-react-native"
import { useDockPanel } from "../useDockPanel"
import type { DockPanelDescriptor } from "../../../../lib/chat-dock-store"
import type { QueuedMessage } from "../../ChatInput"

export interface QueueDockPanelProps {
  queuedMessages: QueuedMessage[]
  onRemoveQueuedMessage?: (messageId: string) => void
  onReorderQueuedMessage?: (messageId: string, direction: "up" | "down") => void
  onEditQueuedMessage?: (messageId: string) => void
  onSendQueuedMessageNow?: (messageId: string) => void
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
              "group flex-row items-center gap-2 py-1.5 border-b border-border/40 last:border-b-0",
              Platform.OS === "web" && "hover:bg-muted/40",
            )}
          >
            {msg.offline ? (
              <WifiOff size={11} className="text-orange-600 dark:text-orange-400 flex-shrink-0" />
            ) : (
              <View className="h-3 w-3 rounded-full border border-muted-foreground/30 flex-shrink-0" />
            )}
            {previewImage && (
              <Image
                source={{ uri: previewImage.dataUrl }}
                className="h-7 w-7 rounded border border-border flex-shrink-0"
                resizeMode="cover"
              />
            )}
            <View className="flex-1 min-w-0">
              <Text className="text-xs text-foreground" numberOfLines={1}>
                {primaryText}
              </Text>
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
              {onReorderQueuedMessage && queuedMessages.length > 1 && (
                <>
                  {index > 0 && (
                    <Pressable
                      accessibilityLabel="Move queued message up"
                      onPress={(e) => {
                        if (e?.stopPropagation) e.stopPropagation()
                        onReorderQueuedMessage(msg.id, "up")
                      }}
                    >
                      {(state: any) => {
                        const active = state.hovered || state.pressed
                        return (
                          <View className={cn("h-6 w-6 items-center justify-center rounded", active && "bg-muted-foreground/25")}>
                            <ChevronUp className={cn("h-3 w-3", active ? "text-foreground" : "text-muted-foreground")} size={12} />
                          </View>
                        )
                      }}
                    </Pressable>
                  )}
                  {index < queuedMessages.length - 1 && (
                    <Pressable
                      accessibilityLabel="Move queued message down"
                      onPress={(e) => {
                        if (e?.stopPropagation) e.stopPropagation()
                        onReorderQueuedMessage(msg.id, "down")
                      }}
                    >
                      {(state: any) => {
                        const active = state.hovered || state.pressed
                        return (
                          <View className={cn("h-6 w-6 items-center justify-center rounded", active && "bg-muted-foreground/25")}>
                            <ChevronDown className={cn("h-3 w-3", active ? "text-foreground" : "text-muted-foreground")} size={12} />
                          </View>
                        )
                      }}
                    </Pressable>
                  )}
                </>
              )}
              {onSendQueuedMessageNow && (
                <Pressable
                  accessibilityLabel="Send queued message now"
                  onPress={(e) => {
                    if (e?.stopPropagation) e.stopPropagation()
                    onSendQueuedMessageNow(msg.id)
                  }}
                >
                  {(state: any) => {
                    const active = state.hovered || state.pressed
                    return (
                      <View className={cn("h-6 w-6 items-center justify-center rounded", active && "bg-muted-foreground/25")}>
                        <SendHorizontal className={cn("h-3 w-3", active ? "text-foreground" : "text-muted-foreground")} size={12} />
                      </View>
                    )
                  }}
                </Pressable>
              )}
              {onEditQueuedMessage && (
                <Pressable
                  accessibilityLabel="Edit queued message"
                  onPress={(e) => {
                    if (e?.stopPropagation) e.stopPropagation()
                    onEditQueuedMessage(msg.id)
                  }}
                >
                  {(state: any) => {
                    const active = state.hovered || state.pressed
                    return (
                      <View className={cn("h-6 w-6 items-center justify-center rounded", active && "bg-muted-foreground/25")}>
                        <Pencil className={cn("h-3 w-3", active ? "text-foreground" : "text-muted-foreground")} size={12} />
                      </View>
                    )
                  }}
                </Pressable>
              )}
              {onRemoveQueuedMessage && (
                <Pressable
                  accessibilityLabel="Delete queued message"
                  onPress={(e) => {
                    if (e?.stopPropagation) e.stopPropagation()
                    onRemoveQueuedMessage(msg.id)
                  }}
                >
                  {(state: any) => {
                    const active = state.hovered || state.pressed
                    return (
                      <View className={cn("h-6 w-6 items-center justify-center rounded", active && "bg-destructive/20")}>
                        <Trash2 className={cn("h-3 w-3", active ? "text-destructive" : "text-muted-foreground")} size={12} />
                      </View>
                    )
                  }}
                </Pressable>
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
      chip: { icon: ListOrdered, count: queuedMessages.length },
      render: () => <QueueBody {...props} />,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props, offlineCount])

  useDockPanel(descriptor)
  return null
}
