// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * InlineMessageEditor (SHO-263)
 *
 * The in-place editor that replaces a past user message when the user
 * clicks the pencil (or plain text) on it — Cursor/Lovable style.
 *
 * It is the existing `<ChatInput>` (so paste, attachments, mentions,
 * ⌘↩ and the model picker all behave exactly like the bottom
 * composer) with the send/voice chrome suppressed (`inlineEdit`) and a
 * footer of its own: an inline revert-files choice, the reason the
 * button is worded the way it is, Cancel, and the keyboard hint.
 *
 * Everything destructive is still decided inline — there is no modal.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Platform, View } from "react-native"
import {
  ChatInput,
  type ChatInputHandle,
  type FileAttachment,
  type RestoreDraftRequest,
} from "../ChatInput"
import {
  useMessageEditContext,
  type MessageEditOptions,
} from "./MessageEditContext"
import { InlineEditFooter } from "./InlineEditFooter"
import {
  editorFooterHint,
  editSubmitLabel,
  formatRelativeTime,
  isDraftDirty,
  readRevertFilesPreference,
  writeRevertFilesPreference,
  type EditCheckpointSummary,
  type EditDraftSnapshot,
} from "./editResend"

export interface InlineMessageEditorProps {
  messageId: string
  /** The message as it was sent — the dirty-detection baseline. */
  originalText: string
  originalFiles?: FileAttachment[]
  /**
   * The draft to open with when it differs from the original (a failed send
   * re-mounts this editor with what the user had typed, see
   * `PendingEditDraft`). Defaults to the original message.
   */
  initialText?: string
  initialFiles?: FileAttachment[]
  /** How many messages below this one will be replaced (drives the label). */
  discardCount: number
  /** Resolved when the editor opened, not on submit. */
  checkpoint: EditCheckpointSummary | null
  /** A run is streaming — sending will stop it first. */
  streaming: boolean
  /** API error from the last attempt, shown under the editor. */
  error?: string | null
  onCancel: () => void
  /** Resolves when the edit is dispatched (or rejects with an error). */
  onSubmit: (
    content: string,
    files: FileAttachment[] | undefined,
    options: MessageEditOptions,
  ) => Promise<void>
}

export function InlineMessageEditor({
  messageId,
  originalText,
  originalFiles,
  initialText,
  initialFiles,
  discardCount,
  checkpoint,
  streaming,
  error,
  onCancel,
  onSubmit,
}: InlineMessageEditorProps) {
  const ctx = useMessageEditContext()
  const inputRef = useRef<ChatInputHandle>(null)
  const containerRef = useRef<View>(null)

  const startingText = initialText ?? originalText
  const startingFiles = initialFiles ?? originalFiles

  const [restoreDraftRequest, setRestoreDraftRequest] =
    useState<RestoreDraftRequest | null>({
      nonce: 1,
      content: startingText,
      files: startingFiles,
    })
  const [draft, setDraft] = useState<EditDraftSnapshot>({
    text: startingText,
    fileCount: startingFiles?.length ?? 0,
  })
  const [revertFiles, setRevertFiles] = useState(() =>
    readRevertFilesPreference(),
  )
  const [busy, setBusy] = useState(false)

  const original = useMemo<EditDraftSnapshot>(
    () => ({ text: originalText, fileCount: originalFiles?.length ?? 0 }),
    [originalText, originalFiles],
  )
  const dirty = isDraftDirty(original, draft)

  // Let sibling bubbles know this editor holds unsaved work, so clicking
  // Edit on another message can't silently discard it.
  const setInlineEditDirty = ctx?.setInlineEditDirty
  useEffect(() => {
    setInlineEditDirty?.(dirty)
  }, [setInlineEditDirty, dirty])
  useEffect(() => {
    return () => setInlineEditDirty?.(false)
  }, [setInlineEditDirty])

  // Keep the newest dirty flag reachable from the (stable) outside-click
  // listener without re-binding it on every keystroke.
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  const handleCancel = useCallback(() => {
    if (busy) return
    onCancel()
  }, [busy, onCancel])

  // Escape cancels (web).
  useEffect(() => {
    if (Platform.OS !== "web") return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      handleCancel()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [handleCancel])

  // Outside click: closes only while the draft is unchanged. Once the user
  // has typed or changed attachments, nothing but Esc / Cancel leaves.
  useEffect(() => {
    if (Platform.OS !== "web") return
    const handler = (e: MouseEvent) => {
      const target = e.target
      if (!(target instanceof Element)) return
      const node = containerRef.current as unknown as Element | null
      if (node && node.contains(target)) return
      if (
        target.closest(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]',
        )
      ) {
        return
      }
      if (dirtyRef.current) return
      handleCancel()
    }
    window.addEventListener("mousedown", handler, true)
    return () => window.removeEventListener("mousedown", handler, true)
  }, [handleCancel])

  // Native: tapping the transcript outside the editor hit-tests and cancels —
  // again only while the draft is unchanged.
  const handleNativeOutsideTap = useCallback(
    (pageX: number, pageY: number) => {
      if (dirtyRef.current) return
      const node = containerRef.current
      if (!node) {
        handleCancel()
        return
      }
      node.measureInWindow((x, y, width, height) => {
        const pad = 12
        const inside =
          pageX >= x - pad &&
          pageX <= x + width + pad &&
          pageY >= y - pad &&
          pageY <= y + height + pad
        if (!inside) handleCancel()
      })
    },
    [handleCancel],
  )

  const registerInlineEditCancel = ctx?.registerInlineEditCancel
  useEffect(() => {
    if (!registerInlineEditCancel) return
    return registerInlineEditCancel(handleNativeOutsideTap)
  }, [registerInlineEditCancel, handleNativeOutsideTap])

  const handleSubmit = useCallback(
    async (content: string, files?: FileAttachment[]) => {
      if (!ctx || busy) return
      const trimmed = content.trim()
      if (!trimmed && (!files || files.length === 0)) return
      setBusy(true)
      // Record the draft before dispatching: the send collapses the
      // transcript optimistically, which unmounts this editor, so the draft
      // and any error must live somewhere that outlives it.
      ctx.setPendingEdit({ messageId, content: trimmed, files, error: null })
      try {
        const revert = Boolean(checkpoint) && revertFiles
        writeRevertFilesPreference(revertFiles)
        await onSubmit(trimmed, files, {
          revertFiles: revert,
          checkpoint:
            revert && checkpoint
              ? {
                  id: checkpoint.id,
                  projectId: checkpoint.projectId,
                  createdAt: checkpoint.createdAt,
                  includesDb: checkpoint.includesDb,
                }
              : undefined,
        })
        ctx.setPendingEdit(null)
      } catch (err) {
        // EditableUserMessage records the API message in `pendingEdit`, which
        // comes back as the `error` prop when the editor re-mounts. Swallow
        // the rejection so it never surfaces as an unhandled promise.
        void err
      } finally {
        setBusy(false)
      }
    },
    [ctx, busy, checkpoint, revertFiles, messageId, onSubmit],
  )

  const revertControl = checkpoint
    ? {
        checked: revertFiles,
        label: "Revert files to before this message",
        hint: [
          `Checkpoint from ${formatRelativeTime(checkpoint.createdAt)}`,
          checkpoint.filesChanged > 0
            ? `${checkpoint.filesChanged} file${
                checkpoint.filesChanged === 1 ? "" : "s"
              } changed`
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
        onChange: (next: boolean) => setRevertFiles(next),
      }
    : null

  const submitLabel = editSubmitLabel({
    hasLaterMessages: discardCount > 0,
    revertFiles: Boolean(checkpoint) && revertFiles,
  })

  const composerProps = ctx?.composerProps

  return (
    <View ref={containerRef} collapsable={false} className="w-full">
      <ChatInput
        ref={inputRef}
        onSubmit={(content, files) => {
          void handleSubmit(content, files)
        }}
        disabled={busy}
        placeholder="Edit your message…"
        restoreDraftRequest={restoreDraftRequest}
        onDraftRestored={() => setRestoreDraftRequest(null)}
        onComposerDraftChange={setDraft}
        selectedModel={composerProps?.selectedModel}
        onModelChange={composerProps?.onModelChange}
        isPro={composerProps?.isPro ?? false}
        onUpgradeClick={composerProps?.onUpgradeClick}
        highlighted
        flush
        inlineEdit
        queuedMessages={[]}
        dimWhenDisabled={false}
      />
      <InlineEditFooter
        submitLabel={submitLabel}
        hint={editorFooterHint(streaming)}
        canSend={Boolean(draft.text.trim()) || draft.fileCount > 0}
        busy={busy}
        error={error ?? null}
        onCancel={handleCancel}
        onSend={() => inputRef.current?.submit()}
        revert={revertControl}
      />
    </View>
  )
}

export default InlineMessageEditor
