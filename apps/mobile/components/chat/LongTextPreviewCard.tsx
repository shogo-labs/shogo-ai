// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * LongTextPreviewCard – compact card shown in chat for oversized content.
 *
 * Displays a short snippet + metadata. Tapping opens FileViewerModal.
 */

import { useState, useMemo } from "react"
import { View, Text, Pressable } from "react-native"
import { FileText, Code, Braces, FileType, ChevronRight } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  analyzeContent,
  textSnippet,
  kindLabel,
  LONG_TEXT_CHIP_LAYOUT_CLASS,
  type ContentKind,
} from "./long-text-utils"
import { FileViewerModal } from "./FileViewerModal"

export interface LongTextPreviewCardProps {
  text: string
  title?: string
  className?: string
}

function KindIcon({ kind, size = 16 }: { kind: ContentKind; size?: number }) {
  const className = "text-primary"
  switch (kind) {
    case "json":
      return <Braces size={size} className={className} />
    case "code":
      return <Code size={size} className={className} />
    case "markdown":
      return <FileType size={size} className={className} />
    default:
      return <FileText size={size} className={className} />
  }
}

export function LongTextPreviewCard({
  text,
  title,
  className,
}: LongTextPreviewCardProps) {
  const [showModal, setShowModal] = useState(false)

  const info = useMemo(() => analyzeContent(text), [text])
  const snippet = useMemo(() => textSnippet(text, 200), [text])
  const label = kindLabel(info.kind)
  const displayTitle = title || `${label} content`

  return (
    <>
      <Pressable
        onPress={() => setShowModal(true)}
        className={cn(
          "rounded-lg border border-border bg-muted/40 p-3 gap-2",
          LONG_TEXT_CHIP_LAYOUT_CLASS,
          className
        )}
        accessibilityLabel={`View ${displayTitle}`}
        accessibilityRole="button"
      >
        {/* Top row: icon + title + size + chevron */}
        <View className="flex-row items-center gap-2">
          <KindIcon kind={info.kind} />
          <Text className="flex-1 text-xs font-medium text-foreground min-w-0" numberOfLines={1}>
            {displayTitle}
          </Text>
          <Text className="text-[10px] text-muted-foreground flex-shrink-0">
            {info.sizeLabel} · {info.lines} lines
          </Text>
          <ChevronRight size={14} className="text-muted-foreground" />
        </View>

        {/* Snippet */}
        <Text
          className="text-[11px] text-muted-foreground leading-4"
          numberOfLines={3}
        >
          {snippet}
        </Text>
      </Pressable>

      <FileViewerModal
        visible={showModal}
        onClose={() => setShowModal(false)}
        content={text}
        title={displayTitle}
        kind={info.kind}
        sizeLabel={info.sizeLabel}
      />
    </>
  )
}
