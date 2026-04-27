// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PastedTextChip — compact file-style chip for a pasted long-text block.
 *
 * Used by ChatInput and CompactChatInput. Visually mirrors the non-image
 * file chip (ChatGPT-style): small card with icon, kind label, size/line
 * count, and a close button. Tapping the chip opens a FileViewerModal
 * showing the full contents.
 */

import { View, Text, Pressable } from "react-native"
import { FileText, X } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { kindLabel, type PastedTextEntry } from "./long-text-utils"

export interface PastedTextChipProps {
  entry: PastedTextEntry
  onOpen: () => void
  onRemove: () => void
  /** Optional extra className for the outer wrapper. */
  className?: string
}

export function PastedTextChip({
  entry,
  onOpen,
  onRemove,
  className,
}: PastedTextChipProps) {
  return (
    <View className={cn("relative w-[180px]", className)}>
      <Pressable
        onPress={onOpen}
        className="rounded-lg border border-border bg-muted/50 p-2"
        accessibilityLabel="View pasted text"
        accessibilityRole="button"
      >
        <View className="flex-row items-center gap-2">
          <View className="h-7 w-7 items-center justify-center rounded-md bg-primary/15">
            <FileText size={14} className="text-primary" />
          </View>
          <View className="flex-1 min-w-0">
            <Text
              className="text-xs font-medium text-foreground"
              numberOfLines={1}
            >
              {kindLabel(entry.info.kind)} paste
            </Text>
            <Text
              className="text-[10px] text-muted-foreground"
              numberOfLines={1}
            >
              {entry.info.sizeLabel} · {entry.info.lines} lines
            </Text>
          </View>
        </View>
      </Pressable>
      <Pressable
        onPress={onRemove}
        className="absolute -right-1 -top-1 h-5 w-5 rounded-full bg-destructive items-center justify-center"
        accessibilityLabel="Remove pasted text"
        accessibilityRole="button"
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <X className="h-3 w-3 text-destructive-foreground" size={10} />
      </Pressable>
    </View>
  )
}

export default PastedTextChip
