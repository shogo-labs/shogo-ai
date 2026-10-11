// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Read-only recap of a channel message that started this session.
 *
 * Same shape as an answered-question card: an icon, who sent it, where it
 * came from, and the message itself. The wrapper prompt stays on the message
 * for the model and is not shown here.
 */

import { Pressable, Text, View } from "react-native"
import { Hash, MessageSquare } from "lucide-react-native"
import { useRouter } from "expo-router"
import { cn } from "@shogo/shared-ui/primitives"
import type { ChannelDispatch } from "@shogo/shared-app/chat"
import { conversationThreadRoute } from "../../../lib/team-chat-nav"
import { ChatMarkdown } from "../ChatMarkdown"

export interface ChannelDispatchCardProps {
  dispatch: ChannelDispatch
  variant?: "bubble" | "row"
  className?: string
}

export function ChannelDispatchCard({
  dispatch,
  variant = "row",
  className,
}: ChannelDispatchCardProps) {
  const router = useRouter()
  const isBubble = variant === "bubble"
  const channel = dispatch.conversationName
  const person = dispatch.handedOffBy ?? dispatch.trigger.authorName
  const where = channel ? `#${channel}` : "Direct message"
  const Icon = channel ? Hash : MessageSquare

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
            <Icon
              size={14}
              className={isBubble ? "text-white/80" : "text-primary"}
            />
          </View>
          <Text
            className={cn(
              "flex-1 text-xs font-semibold",
              isBubble ? "text-white" : "text-foreground",
            )}
          >
            {person}
          </Text>
        </View>

        <View className="gap-1.5">
          <Pressable
            onPress={() =>
              router.push(
                conversationThreadRoute(
                  dispatch.conversationId,
                  dispatch.threadRootId,
                ) as any,
              )
            }
            accessibilityRole="button"
            accessibilityLabel={channel ? `Open ${where}` : "Open direct message"}
          >
            <Text
              className={cn(
                "self-start font-mono text-[9px] font-semibold uppercase tracking-wide",
                isBubble ? "text-white/55" : "text-muted-foreground",
              )}
            >
              {where}
            </Text>
          </Pressable>
          {dispatch.trigger.text ? (
            <ChatMarkdown isStreaming={false} className={isBubble ? "text-white" : undefined}>
              {dispatch.trigger.text}
            </ChatMarkdown>
          ) : null}
        </View>
      </View>
    </View>
  )
}

export default ChannelDispatchCard
