// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FileViewerModal – centered scrollable viewer for long text content.
 *
 * Shown when the user taps a long-text preview card or a file attachment.
 * Supports smooth scrolling, selectable text, and a copy-to-clipboard action.
 */

import { useState, useCallback } from "react"
import { View, Text, Pressable, ScrollView, useWindowDimensions } from "react-native"
import * as Clipboard from "expo-clipboard"
import { X, Copy, Check, FileText, Code, Braces, FileType } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalCloseButton,
} from "@/components/ui/modal"
import { MarkdownText } from "./MarkdownText"
import type { ContentKind } from "./long-text-utils"

export interface FileViewerModalProps {
  visible: boolean
  onClose: () => void
  content: string
  title?: string
  kind?: ContentKind
  sizeLabel?: string
}

function KindIcon({ kind, size = 14 }: { kind?: ContentKind; size?: number }) {
  const className = "text-muted-foreground"
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

export function FileViewerModal({
  visible,
  onClose,
  content,
  title = "Full Content",
  kind = "plain",
  sizeLabel,
}: FileViewerModalProps) {
  const [copied, setCopied] = useState(false)
  const { height: screenHeight } = useWindowDimensions()
  /** Centered dialog — capped height so it reads as a panel, not a fullscreen takeover. */
  const panelMaxHeight = Math.min(screenHeight * 0.7, 600)
  const bodyMaxHeight = Math.min(screenHeight * 0.56, 500)

  const handleCopy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // silently fail
    }
  }, [content])

  return (
    <Modal isOpen={visible} onClose={onClose} size="md">
      <ModalBackdrop />
      <ModalContent
        className="bg-background m-4 rounded-xl border border-border p-0"
        style={{ maxHeight: panelMaxHeight }}
      >
        {/* Header */}
        <ModalHeader className="flex-row items-center justify-between px-4 py-3 border-b border-border">
          <View className="flex-row items-center gap-2 flex-1 min-w-0">
            <KindIcon kind={kind} />
            <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
              {title}
            </Text>
            {sizeLabel ? (
              <Text className="text-xs text-muted-foreground">({sizeLabel})</Text>
            ) : null}
          </View>
          <View className="flex-row items-center gap-2">
            <Pressable
              onPress={handleCopy}
              className="h-8 w-8 items-center justify-center rounded-md"
              accessibilityLabel={copied ? "Copied" : "Copy content"}
            >
              {copied ? (
                <Check size={16} className="text-green-500" />
              ) : (
                <Copy size={16} className="text-muted-foreground" />
              )}
            </Pressable>
            <ModalCloseButton className="h-8 w-8 items-center justify-center rounded-md">
              <X size={16} className="text-muted-foreground" />
            </ModalCloseButton>
          </View>
        </ModalHeader>

        {/* Scrollable body */}
        <ModalBody className="m-0 p-0">
          <ScrollView
            className="px-4 py-3"
            style={{ maxHeight: bodyMaxHeight }}
            showsVerticalScrollIndicator
            persistentScrollbar
          >
            {kind === "markdown" ? (
              <MarkdownText>{content}</MarkdownText>
            ) : (
              <Text selectable className="text-xs text-foreground font-mono leading-5">
                {content}
              </Text>
            )}
          </ScrollView>
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}
