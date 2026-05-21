// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FileViewerModal – centered scrollable viewer for long text content.
 *
 * Shown when the user taps a long-text preview card or a file attachment.
 * Supports smooth scrolling, selectable text, and a copy-to-clipboard action.
 */

import { useState, useCallback, useEffect, useMemo } from "react"
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  useWindowDimensions,
} from "react-native"
import * as Clipboard from "expo-clipboard"
import {
  X,
  Copy,
  Check,
  FileText,
  Code,
  Braces,
  FileType,
  Pencil,
  RotateCcw,
} from "lucide-react-native"
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
import { analyzeContent, type ContentKind } from "./long-text-utils"

export interface FileViewerModalProps {
  visible: boolean
  onClose: () => void
  content: string
  title?: string
  kind?: ContentKind
  sizeLabel?: string
  /**
   * When true, an Edit button is shown in the header. Tapping it switches
   * the body into a multiline editor. Saving fires `onSave` with the new
   * content; the parent is responsible for recomputing kind/size/lines.
   */
  editable?: boolean
  /** Called with the edited content when the user presses Save. */
  onSave?: (next: string) => void
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
  editable = false,
  onSave,
}: FileViewerModalProps) {
  const [copied, setCopied] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(content)
  /**
   * Bumped whenever we want to *remount* the TextInput so its uncontrolled
   * `defaultValue` is re-applied (entering edit mode, reverting, or the
   * parent swapping content). Keeping the editor uncontrolled is what
   * prevents the React-Native-Web cursor-jump-to-end bug on every keystroke.
   */
  const [editorKey, setEditorKey] = useState(0)
  const { height: screenHeight } = useWindowDimensions()
  /** Centered dialog — capped height so it reads as a panel, not a fullscreen takeover. */
  const panelMaxHeight = Math.min(screenHeight * 0.7, 600)
  const bodyMaxHeight = Math.min(screenHeight * 0.56, 500)

  // Re-sync the draft whenever the underlying content changes (e.g. the
  // user opens a different chip) or the modal is re-opened. We also leave
  // edit mode if the parent swaps the content out from under us.
  useEffect(() => {
    setDraft(content)
    setIsEditing(false)
    setEditorKey((k) => k + 1)
  }, [content, visible])

  const draftInfo = useMemo(
    () => (isEditing ? analyzeContent(draft) : null),
    [draft, isEditing]
  )
  const isDirty = isEditing && draft !== content

  const handleCopy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(isEditing ? draft : content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // silently fail
    }
  }, [content, draft, isEditing])

  const handleSave = useCallback(() => {
    if (!onSave) return
    onSave(draft)
    setIsEditing(false)
  }, [draft, onSave])

  const handleStartEdit = useCallback(() => {
    setDraft(content)
    setEditorKey((k) => k + 1)
    setIsEditing(true)
  }, [content])

  const handleRevert = useCallback(() => {
    setDraft(content)
    setEditorKey((k) => k + 1)
  }, [content])

  const canEdit = editable && typeof onSave === "function"

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
            {(() => {
              const label = isEditing ? draftInfo?.sizeLabel : sizeLabel
              return label ? (
                <Text className="text-xs text-muted-foreground">({label})</Text>
              ) : null
            })()}
            {isEditing && isDirty ? (
              <View className="ml-1 h-1.5 w-1.5 rounded-full bg-primary" />
            ) : null}
          </View>
          <View className="flex-row items-center gap-2">
            {canEdit && !isEditing ? (
              <Pressable
                onPress={handleStartEdit}
                className="h-8 w-8 items-center justify-center rounded-md"
                accessibilityLabel="Edit content"
                accessibilityRole="button"
              >
                <Pencil size={16} className="text-muted-foreground" />
              </Pressable>
            ) : null}
            {canEdit && isEditing ? (
              <>
                <Pressable
                  onPress={handleRevert}
                  disabled={!isDirty}
                  className={cn(
                    "h-8 w-8 items-center justify-center rounded-md",
                    !isDirty && "opacity-40",
                  )}
                  accessibilityLabel="Revert edits"
                  accessibilityRole="button"
                >
                  <RotateCcw size={16} className="text-muted-foreground" />
                </Pressable>
                <Pressable
                  onPress={handleSave}
                  disabled={!isDirty}
                  className={cn(
                    "h-8 rounded-md px-3 items-center justify-center",
                    isDirty ? "bg-primary" : "bg-muted"
                  )}
                  accessibilityLabel="Save edits"
                  accessibilityRole="button"
                >
                  <Text
                    className={cn(
                      "text-xs font-semibold",
                      isDirty
                        ? "text-primary-foreground"
                        : "text-muted-foreground"
                    )}
                  >
                    Save
                  </Text>
                </Pressable>
              </>
            ) : null}
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

        {/* Body — viewer or editor */}
        <ModalBody className="m-0 p-0">
          {isEditing ? (
            <View className="px-4 py-3" style={{ maxHeight: bodyMaxHeight }}>
              <TextInput
                /**
                 * `key` + `defaultValue` keep this input *uncontrolled* so
                 * React doesn't re-apply `value` on every keystroke — that
                 * re-application is what causes the cursor to jump to the
                 * end after each character on React-Native-Web. We remount
                 * (bump `editorKey`) only when entering edit mode, reverting,
                 * or the parent swaps content.
                 */
                key={editorKey}
                defaultValue={draft}
                onChangeText={setDraft}
                multiline
                autoFocus
                textAlignVertical="top"
                accessibilityLabel="Edit content"
                placeholder="Edit content…"
                placeholderTextColor="#71717a"
                className="text-xs text-foreground font-mono leading-5"
                style={{
                  minHeight: 200,
                  maxHeight: bodyMaxHeight - 24,
                }}
              />
            </View>
          ) : (
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
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}
