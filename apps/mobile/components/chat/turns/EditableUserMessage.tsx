// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * EditableUserMessage
 *
 * Drop-in replacement for `<MessageContent message={userMsg} />` that
 * adds:
 *
 *   - A hover-revealed action row below the bubble: `Edit` and
 *     `Retry from here`. Both are blocked while the agent is
 *     streaming (race with the in-flight `useChat` request), while
 *     the message id is still optimistic / temp, or when no edit
 *     context provider is mounted (e.g. a Storybook smoke test).
 *
 *   - An in-place edit affordance — the bubble swaps to a multiline
 *     TextInput with Save / Cancel. Submit goes through the parent
 *     context's `editMessage` (and behind that the truncate-from
 *     server endpoint + `sendMessageInternal` in ChatPanel).
 *     Enter sends (without Shift); Shift+Enter inserts a newline,
 *     matching `ChatInput`. Escape cancels.
 *
 * Attachments (images / files) are intentionally not editable in v1.
 * They still render via the unchanged `<MessageContent />` while the
 * bubble is in display mode, and they survive an edit because the
 * server truncate-from + the next `sendMessageInternal` re-creates
 * the row with the original file parts forwarded by ChatPanel.
 */

import { memo, useCallback, useMemo, useRef, useState } from "react"
import { View, Pressable, Platform, TextInput, ActivityIndicator } from "react-native"
import { Pencil, RefreshCw, Check, X } from "lucide-react-native"
import type { UIMessage } from "@ai-sdk/react"
import { cn } from "@shogo/shared-ui/primitives"
import { Text as UIText } from "@/components/ui/text"
import { extractTextContent } from "@shogo/shared-app/chat"
import { MessageContent } from "./MessageContent"
import {
  useMessageEditContext,
  type MessageEditOptions,
} from "./MessageEditContext"
import {
  requestEditConfirmation,
  type EditConfirmCheckpoint,
  type EditConfirmKind,
} from "./EditConfirmDialog"

export interface EditableUserMessageProps {
  message: UIMessage
  className?: string
}

function ActionButton({
  icon: Icon,
  label,
  onPress,
  disabled,
}: {
  icon: typeof Pencil
  label: string
  onPress: () => void
  disabled?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      accessibilityRole="button"
      className={cn(
        "h-6 w-6 items-center justify-center rounded-md",
        Platform.OS === "web" && "hover:bg-muted/60",
        disabled && "opacity-40",
      )}
    >
      <Icon className="h-3.5 w-3.5 text-muted-foreground" size={14} />
    </Pressable>
  )
}

export const EditableUserMessage = memo(function EditableUserMessage({
  message,
  className,
}: EditableUserMessageProps) {
  const ctx = useMessageEditContext()

  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [hovered, setHovered] = useState(false)
  const [busy, setBusy] = useState(false)

  const originalText = useMemo(() => extractTextContent(message), [message])
  const inputRef = useRef<TextInput>(null)

  const editable = ctx ? ctx.canEditMessage(message) : false
  const showActions = Boolean(
    ctx && editable && !ctx.isStreaming && !isEditing &&
      // On web, only reveal the row on hover to keep prior turns
      // visually quiet. On native (no hover) we always show it; the
      // queue list (ChatInput.tsx ~774) uses the same convention.
      (Platform.OS !== "web" || hovered),
  )

  const handleStartEdit = useCallback(() => {
    if (!ctx || ctx.isStreaming || !editable) return
    setDraft(originalText)
    setIsEditing(true)
    // Defer focus so the TextInput is mounted before we call .focus().
    // Some RN backends (web in particular) reject focus on an unmounted
    // node silently which leaves the user staring at a disabled-looking
    // textarea.
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [ctx, editable, originalText])

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false)
    setDraft("")
    setBusy(false)
  }, [])

  /**
   * Resolve the checkpoint (if any) to offer as a file-revert target
   * for the upcoming dialog. We only bother querying when there are
   * messages that would actually be discarded — when `discardCount`
   * is 0 the user is editing the most recent message and there's no
   * agent work to roll back, so a file revert would only undo work
   * the user explicitly wanted to keep.
   *
   * `getPrecedingCheckpoint` returns a soft-fail shape (checkpoint
   * may be null with a `reason` code) so a missing checkpoint is
   * NOT an error path here. Any network/auth failure does fall back
   * to "no checkpoint offered" — the truncate-only confirmation is
   * still a valid, useful prompt.
   */
  const resolveCheckpoint = useCallback(
    async (discardCount: number): Promise<EditConfirmCheckpoint | null> => {
      if (!ctx || discardCount <= 0) return null
      try {
        const result = await ctx.getPrecedingCheckpoint(message.id)
        if (!result.checkpoint || !result.projectId) return null
        return {
          id: result.checkpoint.id,
          projectId: result.projectId,
          createdAt: result.checkpoint.createdAt,
          commitMessage: result.checkpoint.commitMessage,
          filesChanged: result.checkpoint.filesChanged,
          includesDb: result.checkpoint.includesDb,
        }
      } catch (err) {
        // Network / auth blip — degrade to the chat-only confirmation
        // rather than blocking the user's edit flow entirely.
        console.warn(
          "[EditableUserMessage] preceding-checkpoint lookup failed; offering chat-only revert:",
          err,
        )
        return null
      }
    },
    [ctx, message.id],
  )

  /**
   * Shared closure for "ask the dialog, then dispatch through the
   * provider". Pulled out so edit and retry stay in lock-step on
   * the confirm semantics (file revert plumbing in particular).
   */
  const dispatchRewind = useCallback(
    async (
      kind: EditConfirmKind,
      perform: (options: MessageEditOptions) => Promise<void>,
    ) => {
      if (!ctx || busy) return
      const discardCount = ctx.countMessagesAfter(message.id)
      const checkpoint = await resolveCheckpoint(discardCount)
      const result = await requestEditConfirmation(kind, discardCount, checkpoint)
      if (!result.confirmed) return
      setBusy(true)
      try {
        await perform({
          revertFiles: result.revertFiles,
          checkpoint:
            result.revertFiles && checkpoint
              ? {
                  id: checkpoint.id,
                  projectId: checkpoint.projectId,
                  createdAt: checkpoint.createdAt,
                  includesDb: checkpoint.includesDb,
                }
              : undefined,
        })
      } catch (err) {
        console.error(`[EditableUserMessage] ${kind} failed:`, err)
      } finally {
        setBusy(false)
      }
    },
    [ctx, busy, message.id, resolveCheckpoint],
  )

  const handleSaveEdit = useCallback(async () => {
    if (!ctx || busy) return
    const trimmed = draft.trim()
    if (!trimmed) return
    // No-op edit (same content) is a save-as-cancel rather than a
    // costly rewind. Important because a user double-clicking Save on
    // unmodified content would otherwise destroy their thread.
    if (trimmed === originalText.trim()) {
      handleCancelEdit()
      return
    }
    await dispatchRewind("edit", async (options) => {
      await ctx.editMessage(message.id, trimmed, options)
      setIsEditing(false)
      setDraft("")
    })
  }, [ctx, busy, draft, originalText, message.id, handleCancelEdit, dispatchRewind])

  const handleRetry = useCallback(async () => {
    await dispatchRewind("retry", async (options) => {
      if (!ctx) return
      await ctx.retryFromMessage(message.id, options)
    })
  }, [ctx, message.id, dispatchRewind])

  const handleKeyPress = useCallback(
    (e: any) => {
      if (Platform.OS !== "web") return
      const key = e.nativeEvent.key
      if (key === "Enter" && !e.nativeEvent.shiftKey) {
        e.preventDefault()
        void handleSaveEdit()
        return
      }
      if (key === "Escape") {
        e.preventDefault()
        handleCancelEdit()
      }
    },
    [handleSaveEdit, handleCancelEdit],
  )

  if (isEditing) {
    const trimmed = draft.trim()
    const unchanged = trimmed === originalText.trim()
    return (
      <View
        className={cn(
          "max-w-[85%] ml-auto rounded-md bg-secondary px-3 py-2 gap-2",
          // Subtle ring so it's obvious which bubble is being edited.
          // Falls back to a colored border on platforms without
          // tailwind's ring utility (native).
          "border border-primary/50",
          className,
        )}
      >
        <TextInput
          ref={inputRef}
          value={draft}
          onChangeText={setDraft}
          onKeyPress={handleKeyPress}
          multiline
          editable={!busy}
          accessibilityLabel="Edit message"
          placeholder="Edit your message…"
          placeholderTextColor="#9ca3af"
          className={cn(
            "min-h-[40px] w-full text-xs text-foreground",
            "bg-transparent",
            Platform.OS === "web" && "outline-none no-focus-ring",
          )}
          textAlignVertical="top"
        />
        <View className="flex-row items-center justify-end gap-2">
          {Platform.OS === "web" && (
            <UIText size="xs" className="text-typography-500 mr-auto">
              Enter to save · Shift+Enter newline · Esc to cancel
            </UIText>
          )}
          <Pressable
            onPress={handleCancelEdit}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Cancel edit"
            className={cn(
              "h-7 px-2 flex-row items-center gap-1 rounded-md",
              Platform.OS === "web" && "hover:bg-muted/60",
              busy && "opacity-40",
            )}
          >
            <X className="h-3.5 w-3.5 text-muted-foreground" size={14} />
            <UIText size="xs" className="text-typography-600">
              Cancel
            </UIText>
          </Pressable>
          <Pressable
            onPress={handleSaveEdit}
            disabled={busy || !trimmed || unchanged}
            accessibilityRole="button"
            accessibilityLabel="Save and re-run"
            className={cn(
              "h-7 px-2.5 flex-row items-center gap-1 rounded-md bg-primary",
              (busy || !trimmed || unchanged) && "opacity-40",
            )}
          >
            {busy ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <Check className="h-3.5 w-3.5 text-primary-foreground" size={14} />
            )}
            <UIText size="xs" className="text-primary-foreground font-medium">
              Save & rerun
            </UIText>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={cn("ml-auto items-end", className)}
    >
      <MessageContent message={message} className="ml-0" />
      {showActions && (
        <View
          className={cn(
            "mt-1 flex-row items-center gap-0.5 pr-1",
            // Reserve space so the bubble doesn't jump on hover-in:
            // we render a fixed-height row and just toggle visibility.
            "h-6",
          )}
        >
          <ActionButton
            icon={Pencil}
            label="Edit message"
            onPress={handleStartEdit}
            disabled={busy}
          />
          <ActionButton
            icon={RefreshCw}
            label="Retry from this message"
            onPress={handleRetry}
            disabled={busy}
          />
        </View>
      )}
    </View>
  )
})

export default EditableUserMessage
