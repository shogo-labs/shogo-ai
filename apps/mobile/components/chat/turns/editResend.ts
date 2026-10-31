// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure helpers behind the Cursor/Lovable-style edit-and-resend flow
 * (SHO-263). Kept framework-free so the behaviour can be unit tested
 * without mounting the composer.
 */

/** The two things that define "the draft changed" for an open editor. */
export interface EditDraftSnapshot {
  text: string
  fileCount: number
}

/** The checkpoint offered as the file-revert target for an edit/retry. */
export interface EditCheckpointSummary {
  id: string
  projectId: string
  /** ISO-8601 timestamp of the checkpoint. */
  createdAt: string
  /** Stats from the checkpoint row; rendered as an "(N files)" hint. */
  filesChanged: number
  /** Whether the checkpoint includes a database snapshot. */
  includesDb: boolean
}

function normalize(text: string): string {
  return text.replace(/\s+$/, "")
}

/**
 * A draft counts as changed once the text differs from the original
 * (ignoring trailing whitespace) or the attachment set changed. An
 * unchanged editor closes on an outside click; a changed one never
 * closes on its own.
 */
export function isDraftDirty(
  original: EditDraftSnapshot,
  draft: EditDraftSnapshot,
): boolean {
  return (
    normalize(original.text) !== normalize(draft.text) ||
    original.fileCount !== draft.fileCount
  )
}

/**
 * Elements whose own click handlers must win over "click the bubble to
 * edit": links, mention chips, code blocks and attachment thumbnails.
 */
const INTERACTIVE_SELECTOR = [
  "a[href]",
  '[role="link"]',
  "[data-mention]",
  "[data-attachment]",
  "code",
  "pre",
].join(",")

/**
 * True when a press on a past message must NOT open the editor —
 * either the user is selecting text (so the press is a drag /
 * selection gesture) or the press landed inside something clickable.
 */
export function isEditGestureIgnored(
  target: unknown,
  hasSelection: boolean,
): boolean {
  if (hasSelection) return true
  const node = target as { closest?: (selector: string) => unknown } | null
  if (!node || typeof node.closest !== "function") return false
  return Boolean(node.closest(INTERACTIVE_SELECTOR))
}

/** `window.getSelection()` in a shape that survives SSR / native. */
export function hasNonEmptySelection(win?: {
  getSelection?: () => { toString: () => string } | null
} | null): boolean {
  try {
    const selection = win?.getSelection?.()
    return Boolean(selection && selection.toString().trim())
  } catch {
    return false
  }
}

export const EDIT_RESEND_REVERT_KEY = "shogo:editResendRevertFiles"

interface KeyValueStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function defaultStorage(): KeyValueStorage | null {
  try {
    return (globalThis as { localStorage?: KeyValueStorage }).localStorage ?? null
  } catch {
    return null
  }
}

/**
 * The user's last revert choice. First run defaults ON, matching the
 * Cursor/Lovable reference where reverting is the primary path.
 */
export function readRevertFilesPreference(
  storage: KeyValueStorage | null = defaultStorage(),
): boolean {
  if (!storage) return true
  try {
    const raw = storage.getItem(EDIT_RESEND_REVERT_KEY)
    if (raw === null) return true
    return raw !== "0"
  } catch {
    return true
  }
}

export function writeRevertFilesPreference(
  value: boolean,
  storage: KeyValueStorage | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(EDIT_RESEND_REVERT_KEY, value ? "1" : "0")
  } catch {
    // Storage unavailable (private mode, native without polyfill) — best effort.
  }
}

/** Button label that states exactly what the send will do. */
export function editSubmitLabel(opts: {
  hasLaterMessages: boolean
  revertFiles: boolean
}): string {
  if (!opts.hasLaterMessages) return "Send"
  return opts.revertFiles ? "Revert & resend" : "Resend"
}

export function retrySubmitLabel(revertFiles: boolean): string {
  return revertFiles ? "Revert & retry" : "Retry"
}

/** "3 messages below will be replaced" — the divider above the dimmed turns. */
export function replacedTurnsLabel(count: number): string {
  if (count <= 0) return ""
  return `${count} message${count === 1 ? "" : "s"} below will be replaced`
}

/** Footer hint under the inline editor. */
export function editorFooterHint(streaming: boolean): string {
  return streaming
    ? "Esc to cancel · ⏎ to send · Stops the current run"
    : "Esc to cancel · ⏎ to send"
}

/** "Files reverted to the checkpoint from 3 minutes ago" note on the resent message. */
export function filesRevertedNote(relative: string): string {
  return relative
    ? `Files reverted to the checkpoint from ${relative}`
    : "Files reverted to the checkpoint before this message"
}

/**
 * Best-effort relative time for the checkpoint hint ("3 minutes ago").
 * Avoids a date-fns dependency for a single short string.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const seconds = Math.max(0, Math.floor((now - then) / 1000))
  if (seconds < 5) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`
  return new Date(iso).toLocaleDateString()
}

/**
 * Index of the first turn that must be dimmed while `editingMessageId`
 * is being edited, or -1 when nothing is being edited. The turn that
 * owns the edited message dims only its tail (the assistant reply).
 */
export function firstDimmedTurnIndex(
  turns: Array<{ userMessage?: { id?: string } | null }>,
  editingMessageId: string | null,
): number {
  if (!editingMessageId) return -1
  const index = turns.findIndex((turn) => turn.userMessage?.id === editingMessageId)
  if (index === -1) return -1
  return index + 1
}
