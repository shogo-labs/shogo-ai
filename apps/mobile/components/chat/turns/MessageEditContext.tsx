// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * MessageEditContext
 *
 * Lets a user-message bubble deep in the TurnList tree request an
 * edit or "retry from here" without ChatPanel having to thread
 * callbacks through TurnList -> TurnGroup -> EditableUserMessage as
 * props.
 *
 * Why context (not props): `TurnGroup` is `memo`'d on `prev.turn ===
 * next.turn`. Adding callback props would defeat that memo for every
 * turn whenever the callback identity changed in ChatPanel. Context
 * keeps the memo intact — bubbles re-render only when the user opens
 * an edit, not on every parent render.
 *
 * ChatPanel is the producer (it owns the AI SDK `messages`,
 * `setMessages`, `sendMessageInternal`, and the per-session
 * ChatMessageCollection). EditableUserMessage is the consumer.
 */

import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react"
import type { UIMessage } from "@ai-sdk/react"
import type { PrecedingCheckpointResult } from "@shogo/shared-app/chat"
import type { FileAttachment } from "../ChatInput"

/**
 * Options forwarded to `editMessage` / `retryFromMessage` to opt
 * the destructive rewind into ALSO reverting project files via
 * the checkpoint system. When unset / false the file revert step
 * is skipped — only the chat history is truncated and the agent
 * is re-run.
 *
 * Plumbed through context (rather than encoded into the
 * confirmation dialog return value alone) so the actual rollback
 * call lives in ChatPanel, alongside the truncate + re-send work,
 * where errors can be surfaced uniformly.
 */
export interface MessageEditOptions {
  revertFiles?: boolean
  /**
   * The checkpoint to roll back to. The dialog already queried the
   * server for `getPrecedingCheckpoint`, so we pass the resolved id
   * + createdAt straight through instead of having ChatPanel re-query
   * (which would race with concurrent edits).
   */
  checkpoint?: {
    id: string
    projectId: string
    /** ISO 8601 — re-emitted in the SHOGO_FILES_REVERTED event detail. */
    createdAt: string
    includesDb: boolean
  }
}

/**
 * The draft of an inline edit that is mid-flight.
 *
 * Sending an edit collapses the transcript optimistically, which unmounts
 * the very row that owns the editor — and with it the editor's local draft
 * and error state. ChatPanel therefore keeps them here, keyed by message
 * id, so a failed truncate/rollback can re-mount the editor with exactly
 * what the user typed plus the API's error message (SHO-263 AC 8).
 */
export interface PendingEditDraft {
  messageId: string
  content: string
  files?: FileAttachment[]
  /** API error from the last attempt, rendered under the editor. */
  error?: string | null
}

export interface MessageEditContextValue {
  /**
   * Apply an edited content (and optionally a new set of file
   * attachments) to a previously sent user message, then re-run the
   * agent. The implementation MUST:
   *   1. Truncate the message AND all subsequent ones server-side
   *      (POST /api/chat-messages/:id/truncate-from).
   *   2. (Optional) If `options.revertFiles` is set, roll the
   *      project workspace back to `options.checkpoint` BEFORE
   *      re-sending — see `rollbackProjectToCheckpoint`. We do this
   *      after the truncate so a transient rollback failure leaves
   *      the chat in the expected post-truncate state instead of
   *      a half-rewound mess.
   *   3. Trim the local AI SDK `messages` to slice(0, indexOfEdited).
   *   4. Re-send the edited content via the existing send pipeline
   *      (so it goes through `actions.addMessage` -> server -> stream).
   *
   * `newFiles` semantics:
   *   - `undefined` → "no attachments on the resent message". This
   *     is what the in-place ChatInput produces when the user
   *     removed all chips. It is NOT a "leave attachments alone"
   *     marker — the in-place ChatInput is pre-populated via
   *     `restoreDraftRequest` with the original files, so a
   *     no-touch edit round-trips the same array back.
   *   - `FileAttachment[]` → that exact set of attachments (kept,
   *     added, or a mix). Order matches the ChatInput chip order.
   */
  editMessage: (
    messageId: string,
    newContent: string,
    newFiles: FileAttachment[] | undefined,
    options?: MessageEditOptions,
  ) => Promise<void>

  /**
   * Re-run the agent against an existing user message without changing
   * its content. Useful when the assistant reply was unsatisfying.
   * Same truncate-from + optional revert semantics as `editMessage`.
   */
  retryFromMessage: (
    messageId: string,
    options?: MessageEditOptions,
  ) => Promise<void>

  /**
   * How many turns will be discarded if the user edits/retries from
   * the given message id. Used to size the confirmation dialog copy
   * and to skip the dialog entirely when there is nothing to discard
   * (the user is editing the most recent message before the assistant
   * has produced its reply).
   */
  countMessagesAfter: (messageId: string) => number

  /**
   * True while the agent is streaming. Editing is still allowed — the
   * panel stops the run before it truncates (`stopStreaming`) — but the
   * editor says so in its footer.
   */
  isStreaming: boolean

  /**
   * Stop the in-flight run and resolve once the stream has settled.
   * No-op when nothing is streaming. `editMessage` / `retryFromMessage`
   * call this first so an edit made mid-run can't race the live turn.
   */
  stopStreaming: () => Promise<void>

  /**
   * The message currently open in an in-place editor, if any. Used by
   * `TurnList` to dim every turn below it ("N messages below will be
   * replaced") and by the bubbles to keep only one editor open.
   */
  editingMessageId: string | null
  setEditingMessageId: (messageId: string | null) => void
  /**
   * Whether the open editor's draft differs from the original message.
   * Clicking Edit on another message closes an untouched editor but must
   * not throw away a changed draft.
   */
  inlineEditDirty: boolean
  setInlineEditDirty: (dirty: boolean) => void

  /**
   * Whether a message id is editable. Optimistic local-only ids
   * (e.g. `temp-*`, `optimistic-*`) can't be truncated server-side
   * yet, so we surface the actions only once the row has a real id.
   */
  canEditMessage: (message: UIMessage) => boolean

  /**
   * The in-flight edit draft (see `PendingEditDraft`). Owned by ChatPanel
   * so it survives the optimistic collapse that unmounts the editor row.
   */
  pendingEdit: PendingEditDraft | null
  setPendingEdit: (next: PendingEditDraft | null) => void

  /**
   * The "Files reverted to the checkpoint from …" note attached to the
   * resent message, or null. Keyed by message id so the note travels with
   * the message the user is looking at, like Cursor/Lovable.
   */
  revertedNote: (messageId: string) => string | null

  /**
   * Resolve the checkpoint that would be offered as the rollback
   * target for "Edit & Discard"/"Retry from here" on this message,
   * or `null` if no rollback is available. The dialog uses this to
   * decide whether to render the "Also revert project files"
   * checkbox.
   *
   * Returns the full result object (not just `checkpoint`) so the
   * dialog can render a soft "files can't be reverted in folder
   * mode" hint based on `reason` instead of treating an absent
   * checkpoint as a generic error.
   */
  getPrecedingCheckpoint: (
    messageId: string,
  ) => Promise<PrecedingCheckpointResult>

  /**
   * Subset of ChatPanel's bottom-composer state forwarded to the
   * in-place `ChatInput` that EditableUserMessage mounts when the
   * user clicks a previously-sent bubble to edit it.
   *
   * We forward these instead of `useChat`-style globals so the
   * edit-mode composer:
   *   - shares the same model selection (changing the model in
   *     the bubble persists to the bottom composer, which is the
   *     same model the resend will use); and
   *   - honors the same upgrade gate (free users see the upgrade
   *     prompt when picking a premium model from inside an edit).
   *
   * Everything else (queue, interaction mode, quick actions,
   * dual plan, voice input, draft restore) is intentionally NOT
   * forwarded — those belong to the bottom composer's lifecycle
   * (adding a message to the queue from inside an edit-in-progress
   * historical bubble would be confusing). The in-place ChatInput
   * runs with sensible inert defaults for them.
   */
  composerProps: {
    selectedModel?: string
    onModelChange?: (modelId: string) => void
    isPro: boolean
    onUpgradeClick?: () => void
  }

  /**
   * Native-only: register the in-place editor so a tap on the transcript
   * (or anywhere else) can hit-test the composer and cancel if it landed
   * outside. Returns an unsubscribe used when the row leaves edit mode.
   */
  registerInlineEditCancel: (
    cancel: (pageX: number, pageY: number) => void,
  ) => () => void
}

const MessageEditContext = createContext<MessageEditContextValue | null>(null)

/**
 * Native transcript taps (ScrollView onTouchEnd) call this so the
 * in-place editor can cancel when the press landed outside its box.
 * No-op when nothing is being edited.
 */
let nativeInlineEditTapHandler: ((pageX: number, pageY: number) => void) | null =
  null

export function dispatchNativeInlineEditTap(pageX: number, pageY: number): void {
  nativeInlineEditTapHandler?.(pageX, pageY)
}

export interface MessageEditProviderProps
  extends Omit<
    MessageEditContextValue,
    "registerInlineEditCancel"
  > {
  children: ReactNode
  /** Fired when a historical bubble enters or leaves inline edit mode. */
  onInlineEditingChange?: (editing: boolean) => void
}

export function MessageEditProvider({
  editMessage,
  retryFromMessage,
  countMessagesAfter,
  isStreaming,
  stopStreaming,
  editingMessageId,
  setEditingMessageId,
  inlineEditDirty,
  setInlineEditDirty,
  canEditMessage,
  pendingEdit,
  setPendingEdit,
  revertedNote,
  getPrecedingCheckpoint,
  composerProps,
  onInlineEditingChange,
  children,
}: MessageEditProviderProps) {
  const cancelRef = useRef<((pageX: number, pageY: number) => void) | null>(null)

  const registerInlineEditCancel = useCallback(
    (cancel: (pageX: number, pageY: number) => void) => {
      cancelRef.current = cancel
      onInlineEditingChange?.(true)
      nativeInlineEditTapHandler = (pageX, pageY) => {
        cancelRef.current?.(pageX, pageY)
      }
      return () => {
        if (cancelRef.current === cancel) {
          cancelRef.current = null
          nativeInlineEditTapHandler = null
          onInlineEditingChange?.(false)
        }
      }
    },
    [onInlineEditingChange],
  )

  const value = useMemo<MessageEditContextValue>(
    () => ({
      editMessage,
      retryFromMessage,
      countMessagesAfter,
      isStreaming,
      stopStreaming,
      editingMessageId,
      setEditingMessageId,
      inlineEditDirty,
      setInlineEditDirty,
      canEditMessage,
      pendingEdit,
      setPendingEdit,
      revertedNote,
      getPrecedingCheckpoint,
      composerProps,
      registerInlineEditCancel,
    }),
    [
      editMessage,
      retryFromMessage,
      countMessagesAfter,
      isStreaming,
      stopStreaming,
      editingMessageId,
      setEditingMessageId,
      inlineEditDirty,
      setInlineEditDirty,
      canEditMessage,
      pendingEdit,
      setPendingEdit,
      revertedNote,
      getPrecedingCheckpoint,
      composerProps,
      registerInlineEditCancel,
    ],
  )
  return (
    <MessageEditContext.Provider value={value}>
      {children}
    </MessageEditContext.Provider>
  )
}

/**
 * Returns the context value or null. Returning null (instead of
 * throwing) makes EditableUserMessage degrade gracefully — it just
 * skips rendering the actions when used outside a provider, which
 * matters for storybook / tests that mount TurnGroup standalone.
 */
export function useMessageEditContext(): MessageEditContextValue | null {
  return useContext(MessageEditContext)
}
