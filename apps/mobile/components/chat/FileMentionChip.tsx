// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FileMentionChip — compact pill rendered above the chat textarea for an
 * @-tagged file. Mirrors the visual language of PastedTextChip.
 *
 * Why above and not inline? React Native's TextInput cannot embed JSX
 * mid-text. Copilot Chat takes the same approach.
 */

import { View, Text, Pressable } from "react-native"
import { AtSign, X, FileText, File, Image as ImageIcon } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import type { FileMention } from "./file-mention-utils"

export interface FileMentionChipProps {
  mention: FileMention
  onRemove: () => void
  className?: string
  status?: "ready" | "resolving" | "warning"
}

function iconFor(ext: string | undefined) {
  if (!ext) return <File size={12} className="text-primary" />
  const e = ext.toLowerCase()
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(e)) {
    return <ImageIcon size={12} className="text-primary" />
  }
  if ([".md", ".txt", ".json"].includes(e)) {
    return <FileText size={12} className="text-primary" />
  }
  return <File size={12} className="text-primary" />
}

export function FileMentionChip({
  mention,
  onRemove,
  className,
  status = "ready",
}: FileMentionChipProps) {
  const slash = mention.path.lastIndexOf("/")
  const parentPath = slash === -1 ? "" : mention.path.slice(0, slash)

  return (
    <View className={cn("relative", className)}>
      <View
        className={cn(
          "flex-row items-center gap-1.5 rounded-xl border px-2 py-1.5 max-w-[280px] shadow-sm",
          status === "warning"
            ? "border-amber-500/45 bg-amber-500/10"
            : status === "resolving"
              ? "border-primary/35 bg-primary/10"
            : "border-border bg-muted/60",
        )}
        accessibilityLabel={`File mention ${mention.path}`}
        // @ts-expect-error web a11y
        title={mention.path}
      >
        <View className="flex-row items-center rounded-md bg-primary/10 px-1 py-0.5">
          <AtSign size={10} className="text-primary" />
        </View>
        <View className="h-5 w-5 items-center justify-center rounded-md bg-background/60">
          {iconFor(mention.extension)}
        </View>
        <View className="min-w-0 flex-shrink">
          <Text
            className="text-[11px] font-medium text-foreground"
            numberOfLines={1}
          >
            {mention.displayName}
          </Text>
          {!!parentPath && (
            <Text className="text-[9px] text-muted-foreground" numberOfLines={1}>
              {parentPath}
            </Text>
          )}
          {status === "resolving" && (
            <Text className="text-[9px] text-primary" numberOfLines={1}>
              Loading content
            </Text>
          )}
        </View>
        <Pressable
          onPress={onRemove}
          accessibilityLabel={`Remove file mention ${mention.path}`}
          accessibilityRole="button"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          className="ml-0.5 h-5 w-5 items-center justify-center rounded-full bg-muted"
        >
          <X size={11} className="text-muted-foreground" />
        </Pressable>
      </View>
    </View>
  )
}

export default FileMentionChip
