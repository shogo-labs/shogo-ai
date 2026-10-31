// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * EditableUserMessage
 *
 * Renders a previously-sent user message. Clicking plain text (or the
 * pencil in the hover action row) opens an in-place editor right where
 * the message sits — the Cursor/Lovable model:
 *
 *   - Display mode is selection-safe: selecting text, or clicking a link,
 *     mention, code block or attachment inside the message, never opens
 *     the editor.
 *   - A hover action row (web/desktop) offers Copy, Edit and Retry with
 *     labels and tooltips. Native touch devices keep the long-press sheet.
 *   - Edit mode is `<InlineMessageEditor>`: the composer's text/paste/
 *     attachment/mention/model behaviour, without the send or voice chrome,
 *     with an inline footer (revert-files choice, Cancel, labelled Send).
 *   - Everything below the edited message dims via `MessageEditContext`
 *     (`editingMessageId`) so the user sees exactly what will be replaced,
 *     and no confirmation modal is ever shown.
 *   - A failed truncate/rollback keeps the editor open with the draft and
 *     shows the API's message inline.
 *   - Editing while the agent runs is allowed: the run is stopped first
 *     (see `stopStreaming`).
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  View,
  Pressable,
  Text,
  Platform,
  ActivityIndicator,
  ActionSheetIOS,
  Alert,
} from "react-native"
import { Check, Copy, Pencil, RotateCcw } from "lucide-react-native"
import * as Clipboard from "expo-clipboard"
import * as Haptics from "expo-haptics"
import type { UIMessage } from "@ai-sdk/react"
import { cn } from "@shogo/shared-ui/primitives"
import { channelDispatchOf, extractTextContent, taskNotificationOf } from "@shogo/shared-app/chat"
import { MessageContent } from "./MessageContent"
import {
  useMessageEditContext,
  type MessageEditOptions,
} from "./MessageEditContext"
import {
  hasNonEmptySelection,
  isEditGestureIgnored,
  type EditCheckpointSummary,
} from "./editResend"
import { InlineMessageEditor } from "./InlineMessageEditor"
import { WebTooltip } from "../WebTooltip"
import type { FileAttachment } from "../ChatInput"
import { useIsNativePhoneLayout } from "../../../lib/native-phone-layout"
import { useMobileWorkspaceChrome } from "../../layout/MobileWorkspaceChromeContext"
import { AskUserAnswerCard } from "./AskUserAnswerCard"
import { CanvasErrorCard } from "./CanvasErrorCard"
import { ChannelDispatchCard } from "./ChannelDispatchCard"
import { TaskNotificationRow } from "./TaskNotificationRow"
import { stripAskUserAnswerMarker } from "./askUserAnswers"
import { stripBuildBriefMarker } from "./buildBrief"
import { parseCanvasErrorDebugPrompt } from "./canvasErrorPrompt"
import type { AnsweredQuestion } from "./types"

function showNativeUserMessageActions(opts: {
  canEdit: boolean
  canRetry: boolean
  onCopy: () => void
  onEdit: () => void
  onRetry: () => void
}) {
  const rows: { label: string; run: () => void; destructive?: boolean }[] = [
    { label: "Copy", run: opts.onCopy },
  ]
  if (opts.canEdit) {
    rows.push({ label: "Edit", run: opts.onEdit })
  }
  if (opts.canRetry) {
    rows.push({
      label: "Retry from here",
      run: opts.onRetry,
      destructive: true,
    })
  }

  if (Platform.OS === "ios") {
    const options = [...rows.map((r) => r.label), "Cancel"]
    const destructiveIndex = rows.findIndex((r) => r.destructive)
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex: options.length - 1,
        destructiveButtonIndex:
          destructiveIndex >= 0 ? destructiveIndex : undefined,
      },
      (index) => {
        if (index == null || index >= rows.length) return
        rows[index]?.run()
      },
    )
    return
  }

  Alert.alert("Message", undefined, [
    ...rows.map((r) => ({
      text: r.label,
      onPress: r.run,
      style: (r.destructive ? "destructive" : "default") as
        "destructive" | "default",
    })),
    { text: "Cancel", style: "cancel" as const },
  ])
}

/** Native retry keeps a system Alert (two destructive flavours + Cancel). */
function showNativeRetryChoice(opts: {
  hasCheckpoint: boolean
  onRetry: (revertFiles: boolean) => void
}) {
  const buttons: Array<{
    text: string
    style?: "cancel" | "destructive" | "default"
    onPress?: () => void
  }> = [{ text: "Cancel", style: "cancel" }]
  if (opts.hasCheckpoint) {
    buttons.push({
      text: "Revert & retry",
      style: "destructive",
      onPress: () => opts.onRetry(true),
    })
    buttons.push({
      text: "Retry without reverting",
      onPress: () => opts.onRetry(false),
    })
  } else {
    buttons.push({
      text: "Retry",
      style: "destructive",
      onPress: () => opts.onRetry(false),
    })
  }
  Alert.alert("Retry from this message?", undefined, buttons)
}

export interface EditableUserMessageProps {
  message: UIMessage
  answeredQuestion?: AnsweredQuestion
  className?: string
}

/**
 * Parse a `data:image/png;base64,...` URL into its MIME prefix.
 * Returns a safe fallback so a malformed data URL doesn't crash the
 * resend (the server will validate the type either way).
 */
function extractMediaType(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl)
  return match?.[1] ?? "application/octet-stream"
}

/**
 * Build the `FileAttachment[]` shape the composer expects from a UI
 * message's `parts`. Matches the logic in
 * `ChatPanel.handleRetryFromMessage` so display-mode → edit-mode
 * round-trips preserve attachments faithfully.
 */
function extractFileAttachments(
  message: UIMessage,
): FileAttachment[] | undefined {
  const parts = ((message as any)?.parts ?? []) as any[]
  const fileParts = parts.filter((p: any) => p?.type === "file" && p?.url)
  if (fileParts.length === 0) return undefined
  return fileParts.map((p: any) => ({
    dataUrl: p.url,
    name: p.name ?? p.filename ?? "file",
    type: p.mediaType ?? extractMediaType(p.url),
  }))
}

export const EditableUserMessage = memo(function EditableUserMessage({
  message,
  answeredQuestion,
  className,
}: EditableUserMessageProps) {
  const ctx = useMessageEditContext()
  const nativePhone = useIsNativePhoneLayout()
  const usesMobileWorkspaceChrome = useMobileWorkspaceChrome()
  const usesCompactBubble = nativePhone || usesMobileWorkspaceChrome

  const [localEditing, setLocalEditing] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [checkpoint, setCheckpoint] = useState<EditCheckpointSummary | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [retryMenuOpen, setRetryMenuOpen] = useState(false)

  const isEditing = ctx ? ctx.editingMessageId === message.id : localEditing

  // A failed truncate/rollback re-mounts this row (the optimistic collapse
  // removed it), so the editor's draft and error live in the context and are
  // handed back as its initial values.
  const pendingEdit =
    ctx?.pendingEdit && ctx.pendingEdit.messageId === message.id
      ? ctx.pendingEdit
      : null
  const revertedNote = ctx?.revertedNote?.(message.id) ?? null

  const originalText = useMemo(
    () => stripBuildBriefMarker(stripAskUserAnswerMarker(extractTextContent(message))),
    [message],
  )
  const originalFiles = useMemo(
    () => extractFileAttachments(message),
    [message],
  )

  const editable = ctx ? ctx.canEditMessage(message) : false
  const canEdit = Boolean(editable && !answeredQuestion)
  // Editing and retry stay available during a run — sending stops it first.
  const canRetry = Boolean(editable)
  const discardCount = ctx ? ctx.countMessagesAfter(message.id) : 0

  const clearEditState = useCallback(() => {
    setCheckpoint(null)
    setError(null)
    setBusy(false)
  }, [])

  const handleStartEdit = useCallback(() => {
    if (!canEdit || busy) return
    // Only one editor at a time: another message's Edit closes an untouched
    // editor, but a changed draft is never thrown away from under the user.
    const otherOpen = ctx?.editingMessageId && ctx.editingMessageId !== message.id
    if (otherOpen && ctx.inlineEditDirty) return
    setRetryMenuOpen(false)
    setError(null)
    setCheckpoint(null)
    if (ctx) ctx.setEditingMessageId(message.id)
    else setLocalEditing(true)
  }, [canEdit, busy, ctx, message.id])

  // Resolve the revert target when the editor opens (not on submit) so the
  // footer can show the choice straight away. Runs for a re-mounted editor
  // too — after a failed send the row is fresh, so it has to re-resolve.
  const checkpointRequestedRef = useRef(false)
  useEffect(() => {
    if (!isEditing || !ctx) {
      checkpointRequestedRef.current = false
      return
    }
    if (checkpointRequestedRef.current) return
    if (ctx.countMessagesAfter(message.id) <= 0) return
    checkpointRequestedRef.current = true
    let cancelled = false
    void ctx
      .getPrecedingCheckpoint(message.id)
      .then((result) => {
        const found = result.checkpoint
        const projectId = result.projectId
        if (cancelled || !found || !projectId) return
        const next: EditCheckpointSummary = {
          id: found.id,
          projectId,
          createdAt: found.createdAt,
          filesChanged: found.filesChanged,
          includesDb: found.includesDb,
        }
        setCheckpoint((prev) => (prev?.id === next.id ? prev : next))
      })
      .catch((err) => {
        // No rollback target: the editor simply offers chat-only resend.
        console.warn(
          "[EditableUserMessage] preceding-checkpoint lookup failed:",
          err,
        )
      })
    return () => {
      cancelled = true
    }
  }, [isEditing, ctx, message.id])

  const handleCancelEdit = useCallback(() => {
    clearEditState()
    ctx?.setPendingEdit(null)
    if (ctx) ctx.setEditingMessageId(null)
    else setLocalEditing(false)
  }, [clearEditState, ctx])

  const handleEditorSubmit = useCallback(
    async (
      content: string,
      files: FileAttachment[] | undefined,
      options: MessageEditOptions,
    ) => {
      if (!ctx) return
      setError(null)
      setBusy(true)
      try {
        // Editing mid-run: stop first and let the stream settle, so the
        // truncate can't race the in-flight turn.
        if (ctx.isStreaming) await ctx.stopStreaming()
        await ctx.editMessage(message.id, content, files, options)
        // On success the message id disappears from the transcript and this
        // component unmounts; reset defensively for layouts that keep it.
        ctx.setPendingEdit(null)
        clearEditState()
        ctx.setEditingMessageId(null)
      } catch (err) {
        // This row is usually already unmounted by the optimistic collapse,
        // so the error and the draft that must reopen with it are recorded in
        // the context (EditableUserMessage remounts from `pendingEdit`).
        const detail =
          err instanceof Error && err.message
            ? err.message
            : "Could not resend this message."
        ctx.setPendingEdit({
          messageId: message.id,
          content,
          files,
          error: detail,
        })
        setError(detail)
        setBusy(false)
        throw err
      }
    },
    [ctx, message.id, clearEditState],
  )

  const runRetry = useCallback(
    async (revertFiles: boolean) => {
      if (!ctx) return
      setRetryMenuOpen(false)
      setError(null)
      setBusy(true)
      const options: MessageEditOptions = {
        revertFiles: revertFiles && Boolean(checkpoint),
        checkpoint:
          revertFiles && checkpoint
            ? {
                id: checkpoint.id,
                projectId: checkpoint.projectId,
                createdAt: checkpoint.createdAt,
                includesDb: checkpoint.includesDb,
              }
            : undefined,
      }
      try {
        if (ctx.isStreaming) await ctx.stopStreaming()
        await ctx.retryFromMessage(message.id, options)
      } catch (err) {
        setError(
          err instanceof Error && err.message
            ? err.message
            : "Could not retry this message.",
        )
      } finally {
        setBusy(false)
      }
    },
    [ctx, message.id, checkpoint],
  )

  const needRetryCheckpoint = useCallback(async () => {
    if (!ctx) return null
    if (discardCount <= 0) return null
    if (checkpoint) return checkpoint
    try {
      const result = await ctx.getPrecedingCheckpoint(message.id)
      if (!result.checkpoint || !result.projectId) return null
      const next: EditCheckpointSummary = {
        id: result.checkpoint.id,
        projectId: result.projectId,
        createdAt: result.checkpoint.createdAt,
        filesChanged: result.checkpoint.filesChanged,
        includesDb: result.checkpoint.includesDb,
      }
      setCheckpoint(next)
      return next
    } catch {
      return null
    }
  }, [ctx, discardCount, checkpoint, message.id])

  const handleRetryClick = useCallback(async () => {
    if (!canRetry || busy) return
    const resolved = await needRetryCheckpoint()
    if (Platform.OS !== "web") {
      showNativeRetryChoice({
        hasCheckpoint: Boolean(resolved),
        onRetry: (revert) => {
          void runRetry(revert)
        },
      })
      return
    }
    if (!resolved) {
      await runRetry(false)
      return
    }
    // Anchored two-option popover, never the old full-screen dialog.
    setRetryMenuOpen(true)
  }, [canRetry, busy, needRetryCheckpoint, runRetry])

  const handleCopy = useCallback(async () => {
    if (!originalText) return
    try {
      await Clipboard.setStringAsync(originalText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be unavailable in some simulators — ignore.
    }
  }, [originalText])

  // Selection-safe click-to-edit: a press that is part of selecting text,
  // or that lands on a link / mention / code block, is not an edit request.
  const handleRowPress = useCallback(
    (event?: unknown) => {
      if (!canEdit || busy) return
      if (Platform.OS === "web") {
        const anyEvent = event as { target?: unknown; nativeEvent?: { target?: unknown } } | undefined
        const target = anyEvent?.target ?? anyEvent?.nativeEvent?.target
        if (hasNonEmptySelection(globalThis as any)) return
        if (isEditGestureIgnored(target, false)) return
      }
      handleStartEdit()
    },
    [canEdit, busy, handleStartEdit],
  )

  const handleNativeLongPress = useCallback(() => {
    if (busy) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {})
    showNativeUserMessageActions({
      canEdit,
      canRetry,
      onCopy: () => {
        void handleCopy()
      },
      onEdit: handleStartEdit,
      onRetry: () => {
        void handleRetryClick()
      },
    })
  }, [busy, canEdit, canRetry, handleCopy, handleStartEdit, handleRetryClick])

  useEffect(() => {
    setRetryMenuOpen(false)
  }, [isEditing])

  // ─── Non-message rows ─────────────────────────────────────────
  const taskNotification = taskNotificationOf(message)
  if (taskNotification) {
    return (
      <View className={cn("w-full", className)}>
        <TaskNotificationRow notification={taskNotification} />
      </View>
    )
  }

  const dispatch = channelDispatchOf(message)
  if (dispatch) {
    return (
      <View
        className={cn(
          usesCompactBubble ? "w-full items-end px-1" : "w-full",
          className,
        )}
      >
        <ChannelDispatchCard
          dispatch={dispatch}
          variant={usesCompactBubble ? "bubble" : "row"}
        />
      </View>
    )
  }

  const canvasError = parseCanvasErrorDebugPrompt(extractTextContent(message))
  if (canvasError) {
    return (
      <View
        className={cn(
          usesCompactBubble ? "w-full items-end px-1" : "w-full",
          className,
        )}
      >
        <CanvasErrorCard
          prompt={canvasError}
          variant={usesCompactBubble ? "bubble" : "row"}
        />
      </View>
    )
  }

  // ─── EDIT MODE ────────────────────────────────────────────────
  if (isEditing) {
    return (
      <View className={cn("w-full", className)}>
        <InlineMessageEditor
          messageId={message.id}
          originalText={originalText}
          originalFiles={originalFiles}
          initialText={pendingEdit?.content}
          initialFiles={pendingEdit?.files}
          discardCount={discardCount}
          checkpoint={checkpoint}
          streaming={Boolean(ctx?.isStreaming)}
          error={pendingEdit?.error ?? error}
          onCancel={handleCancelEdit}
          onSubmit={handleEditorSubmit}
        />
      </View>
    )
  }

  // ─── DISPLAY MODE ─────────────────────────────────────────────
  // Web/desktop: full-width row. Compact bubble on the companion mobile
  // shell and native phone (long-press sheet there).
  if (usesCompactBubble) {
    return (
      <View className={cn("w-full items-end px-1", className)}>
        <Pressable
          onPress={
            nativePhone || answeredQuestion ? undefined : () => handleRowPress()
          }
          onLongPress={nativePhone ? handleNativeLongPress : undefined}
          delayLongPress={nativePhone ? 400 : undefined}
          disabled={nativePhone ? busy : answeredQuestion ? !canRetry : !canEdit}
          accessibilityRole="button"
          accessibilityLabel={
            nativePhone
              ? "Your message. Long press for copy, edit, and retry."
              : "Edit this message and re-run from here."
          }
          accessibilityHint={
            nativePhone
              ? undefined
              : "Activates an inline editor pre-filled with this message."
          }
          className={cn(
            answeredQuestion ? "max-w-full" : "max-w-[85%]",
            Platform.OS === "web" && canEdit && "cursor-text",
            busy && "opacity-60",
          )}
        >
          {answeredQuestion ? (
            <AskUserAnswerCard
              answeredQuestion={answeredQuestion}
              variant="bubble"
            />
          ) : (
            <MessageContent message={message} variant="userBubble" />
          )}
        </Pressable>
        {error ? (
          <Text className="mt-1 px-2 text-xs text-destructive">{error}</Text>
        ) : null}
        {busy ? (
          <View className="mt-1 pr-2">
            <ActivityIndicator size="small" />
          </View>
        ) : null}
        {revertedNote ? (
          <Text className="mt-1 px-2 text-[11px] text-muted-foreground">
            {revertedNote}
          </Text>
        ) : null}
      </View>
    )
  }

  const isNative = Platform.OS !== "web"
  const isWeb = Platform.OS === "web"

  // Resting fill is intentionally subtler than a chat bubble so a long thread
  // of historical user messages doesn't read as a row of stacked CTAs.
  const rowBoxStyle = answeredQuestion
    ? undefined
    : cn(
        "rounded-md bg-secondary/60",
        isNative ? "min-h-12 px-4 py-3" : "px-3 py-2",
        isWeb && canEdit && "cursor-text hover:bg-secondary",
      )

  // Hover actions: Copy / Edit / Retry. Web reveals them on hover; native
  // tablets (no hover) always show them. Positioned absolutely so opening
  // them never shifts the transcript.
  const showActions = !answeredQuestion && (isWeb ? hovered || retryMenuOpen : true)

  const actionButtonClass = cn(
    "h-6 w-6 items-center justify-center rounded-md",
    "hover:bg-muted/60 active:opacity-70",
  )

  return (
    // Hover has to be a DOM handler on the View: react-native-web's View
    // whitelists `onMouseEnter`/`onMouseLeave` (mouseProps) but drops
    // `onHoverIn` — that one only exists on Pressable. With `onHoverIn` here
    // `hovered` never flipped in a browser and the Copy/Edit/Retry row never
    // rendered at all (caught by e2e/local/chat-edit-resend).
    <View
      className={cn("w-full", className)}
      {...(isWeb
        ? ({
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
          } as any)
        : {})}
    >
      <Pressable
        onPress={answeredQuestion ? undefined : handleRowPress}
        disabled={answeredQuestion ? !canRetry : !canEdit}
        accessibilityRole={canEdit ? "button" : undefined}
        accessibilityLabel={
          canEdit ? "Edit this message and re-run from here" : undefined
        }
        accessibilityHint={
          canEdit
            ? "Activates an inline editor pre-filled with this message."
            : undefined
        }
        className={cn(
          "w-full flex-row items-start gap-2",
          rowBoxStyle,
          busy && "opacity-60",
        )}
      >
        <View className="flex-1 min-w-0">
          {answeredQuestion ? (
            <AskUserAnswerCard
              answeredQuestion={answeredQuestion}
              variant="row"
            />
          ) : (
            <MessageContent message={message} />
          )}
        </View>
      </Pressable>

      {showActions && (
        <View className="relative">
          <View
            className="absolute right-1 -top-3 flex-row items-center gap-0.5 rounded-md border border-border/40 bg-background/95 px-1 py-0.5"
            style={{ zIndex: 5 }}
          >
            <WebTooltip label={copied ? "Copied" : "Copy"}>
              <Pressable
                onPress={() => {
                  void handleCopy()
                }}
                accessibilityRole="button"
                accessibilityLabel="Copy message text"
                className={actionButtonClass}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-primary" size={14} />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-muted-foreground" size={14} />
                )}
              </Pressable>
            </WebTooltip>

            {canEdit && (
              <WebTooltip label="Edit">
                <Pressable
                  onPress={handleStartEdit}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="Edit message"
                  className={actionButtonClass}
                >
                  <Pencil
                    className="h-3.5 w-3.5 text-muted-foreground"
                    size={14}
                  />
                </Pressable>
              </WebTooltip>
            )}

            {canRetry && (
              <WebTooltip label="Retry from here">
                <Pressable
                  onPress={() => {
                    void handleRetryClick()
                  }}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="Retry from this message"
                  className={actionButtonClass}
                >
                  {busy ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <RotateCcw
                      className="h-3.5 w-3.5 text-muted-foreground"
                      size={14}
                    />
                  )}
                </Pressable>
              </WebTooltip>
            )}
          </View>

          {retryMenuOpen && (
            <View
              accessibilityRole="menu"
              className="absolute right-1 top-4 z-10 w-56 rounded-md border border-border bg-popover p-1 shadow-md"
            >
              <Pressable
                onPress={() => {
                  void runRetry(true)
                }}
                accessibilityRole="button"
                accessibilityLabel="Revert files and retry"
                className="rounded px-2 py-1.5 hover:bg-muted/60"
              >
                <Text className="text-xs text-foreground">Revert & retry</Text>
                {checkpoint ? (
                  <Text className="text-[11px] text-muted-foreground">
                    {checkpoint.filesChanged > 0
                      ? `${checkpoint.filesChanged} file${
                          checkpoint.filesChanged === 1 ? "" : "s"
                        } back to the checkpoint`
                      : "Files back to the checkpoint"}
                  </Text>
                ) : null}
              </Pressable>
              <Pressable
                onPress={() => {
                  void runRetry(false)
                }}
                accessibilityRole="button"
                accessibilityLabel="Retry without reverting files"
                className="rounded px-2 py-1.5 hover:bg-muted/60"
              >
                <Text className="text-xs text-foreground">
                  Retry without reverting
                </Text>
                <Text className="text-[11px] text-muted-foreground">
                  Chat only — files stay as they are
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      )}

      {error ? (
        <Text className="mt-1 px-3 text-xs text-destructive">{error}</Text>
      ) : null}
      {revertedNote ? (
        <Text className="mt-1 px-3 text-[11px] text-muted-foreground">
          {revertedNote}
        </Text>
      ) : null}
    </View>
  )
})

export default EditableUserMessage
