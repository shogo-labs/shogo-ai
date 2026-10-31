// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared fixture for the SHO-263 edit-and-resend RTL tests. Builds a real
 * `MessageEditProvider` so the tests exercise the context wiring the bubbles
 * and `TurnList` actually read (not a hand-rolled stub).
 */

import { createElement, useMemo, useState, type ReactNode } from "react"
import { MessageEditProvider, type PendingEditDraft } from "../MessageEditContext"

export interface EditContextOverrides {
  editingMessageId?: string | null
  pendingEdit?: PendingEditDraft | null
  revertedNotes?: Record<string, string>
  countMessagesAfter?: (messageId: string) => number
  isStreaming?: boolean
  inlineEditDirty?: boolean
  getPrecedingCheckpoint?: (messageId: string) => Promise<any>
  editMessage?: (...args: any[]) => Promise<void>
  retryFromMessage?: (...args: any[]) => Promise<void>
  stopStreaming?: () => Promise<void>
  /** Observes `setPendingEdit`, which the fixture keeps in local state. */
  onPendingEdit?: (next: PendingEditDraft | null) => void
  children?: ReactNode
}

export function EditContextHost({
  editingMessageId: initialEditing = null,
  pendingEdit: initialPending = null,
  revertedNotes = {},
  countMessagesAfter = () => 0,
  isStreaming = false,
  inlineEditDirty = false,
  getPrecedingCheckpoint,
  editMessage,
  retryFromMessage,
  stopStreaming,
  onPendingEdit,
  children,
}: EditContextOverrides) {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(
    initialEditing,
  )
  const [pendingEdit, setPendingEdit] = useState<PendingEditDraft | null>(
    initialPending,
  )
  const ctx = useMemo(
    () => ({
      editingMessageId,
      setEditingMessageId,
      pendingEdit,
      setPendingEdit: (next: PendingEditDraft | null) => {
        onPendingEdit?.(next)
        setPendingEdit(next)
      },
      revertedNote: (messageId: string) => revertedNotes[messageId] ?? null,
      countMessagesAfter,
      isStreaming,
      inlineEditDirty,
      setInlineEditDirty: () => {},
      canEditMessage: (message: any) => message?.role === "user",
      getPrecedingCheckpoint:
        getPrecedingCheckpoint ??
        (async () => ({ ok: true, checkpoint: null, reason: "no_checkpoint" })),
      editMessage: editMessage ?? (async () => {}),
      retryFromMessage: retryFromMessage ?? (async () => {}),
      stopStreaming: stopStreaming ?? (async () => {}),
      composerProps: { isPro: false },
    }),
    [
      editingMessageId,
      pendingEdit,
      revertedNotes,
      countMessagesAfter,
      isStreaming,
      inlineEditDirty,
      getPrecedingCheckpoint,
      editMessage,
      retryFromMessage,
      stopStreaming,
      onPendingEdit,
    ],
  )

  return createElement(MessageEditProvider, { ...(ctx as any) }, children)
}

/** A UIMessage-shaped user message with one text part. */
export function userMessage(id: string, text: string): any {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  }
}
