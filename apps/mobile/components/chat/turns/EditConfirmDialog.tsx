// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Destructive confirmation for "edit and resend" / "retry from here".
 *
 * Mirrors the Cursor "Submit from a previous message?" affordance —
 * a single AlertDialog on web, with a "Don't ask again" toggle that
 * persists per-action-kind in localStorage. On native (where this UI
 * is currently web-first) we fall back to the system `Alert.alert`
 * so the action still has friction even without a custom modal.
 *
 * Two destructive things can happen on confirm:
 *
 *   1. Chat history is truncated from this message onward
 *      (always — that's the whole point of edit/retry).
 *   2. Project files are reverted to the checkpoint that was the
 *      latest one before this message (OPTIONAL, only offered when
 *      the dialog was given a non-null checkpoint to revert to).
 *
 * The "Also revert project files" checkbox defaults ON when a
 * checkpoint is available — matching the Cursor reference UX where
 * "Revert" is the primary path. When NO checkpoint is available
 * (folder-mode project, feature-scoped chat, or just no prior
 * checkpoint exists) the checkbox is omitted and the dialog
 * degrades to the original truncate-only confirmation.
 *
 * "Don't ask again" intentionally only applies when there is NO
 * checkpoint to potentially revert. File state is a much bigger
 * deal than chat history, so we always force the user to make a
 * fresh choice when a rollback is on offer — even if they
 * previously dismissed the truncate-only flavor of the dialog.
 *
 * The actual destructive work happens in ChatPanel
 * (`handleEditMessageFromBubble` / `handleRetryFromBubbleMessage`);
 * this component only renders the prompt and resolves the request
 * back to the caller.
 */

import { useCallback, useEffect, useState } from "react"
import { Platform, View, Pressable, Alert } from "react-native"
import { Check } from "lucide-react-native"
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogBody,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog"
import { Heading } from "@/components/ui/heading"
import { Text as UIText } from "@/components/ui/text"
import { Button, ButtonText } from "@/components/ui/button"
import { cn } from "@shogo/shared-ui/primitives"

export type EditConfirmKind = "edit" | "retry"

/**
 * Compact summary of the checkpoint the dialog is offering as a
 * file-revert target. Shallow projection of `PrecedingCheckpoint`
 * from shared-app so this module doesn't take a runtime dependency
 * on it (only types) and stays renderable in isolation.
 */
export interface EditConfirmCheckpoint {
  id: string
  projectId: string
  /** ISO-8601 timestamp; used to render relative time + as event detail. */
  createdAt: string
  /** Auto-checkpoint git commit message — surfaced as a tooltip / sublabel. */
  commitMessage: string
  /** Stats from the checkpoint row; used as a small "(N files)" hint. */
  filesChanged: number
  /** Whether the checkpoint includes a pg_dump snapshot. */
  includesDb: boolean
}

export interface EditConfirmResult {
  confirmed: boolean
  /**
   * True when the user explicitly opted into the "Also revert
   * project files" toggle. Always false when no checkpoint was on
   * offer (caller must guard against doing a rollback in that case
   * — the dialog can't manufacture a checkpoint).
   */
  revertFiles: boolean
}

export interface EditConfirmRequest {
  kind: EditConfirmKind
  /** How many subsequent messages will be deleted. Drives copy + button label. */
  discardCount: number
  /**
   * The checkpoint that would be the rollback target if the user
   * opts in. `null` means no rollback is available — the dialog
   * still shows the truncate confirmation but hides the file-revert
   * checkbox entirely.
   */
  checkpoint: EditConfirmCheckpoint | null
  /** Resolves with both flags. */
  resolve: (result: EditConfirmResult) => void
}

const DONT_ASK_KEY = {
  edit: "shogo:editMessageDontAsk",
  retry: "shogo:retryMessageDontAsk",
} as const

/**
 * Read the persisted "don't ask again" flag for a given action kind.
 * Web only — native always asks because there's no system-level
 * "ephemeral preference" surface here that doesn't pull in
 * AsyncStorage unconditionally; the dialog is destructive enough
 * that asking each time on mobile is the safer default.
 */
function readDontAsk(kind: EditConfirmKind): boolean {
  if (Platform.OS !== "web") return false
  try {
    return globalThis.localStorage?.getItem(DONT_ASK_KEY[kind]) === "1"
  } catch {
    return false
  }
}

function writeDontAsk(kind: EditConfirmKind, value: boolean): void {
  if (Platform.OS !== "web") return
  try {
    if (value) {
      globalThis.localStorage?.setItem(DONT_ASK_KEY[kind], "1")
    } else {
      globalThis.localStorage?.removeItem(DONT_ASK_KEY[kind])
    }
  } catch {
    // Storage may be unavailable (incognito, server render). Best-effort.
  }
}

/**
 * Imperative entry point used by EditableUserMessage. Returns a
 * promise that resolves with `{ confirmed, revertFiles }`.
 *
 * Decision matrix:
 *
 *   discard | checkpoint | dontAsk | behavior
 *   --------|------------|---------|---------------------------------------
 *   0       | n/a        | n/a     | instant {true, false}
 *   >0      | null       | true    | instant {true, false}
 *   >0      | null       | false   | dialog (no revert checkbox)
 *   >0      | present    | n/a     | dialog (revert checkbox shown; dontAsk
 *                                    is IGNORED — file state is too
 *                                    important to silently skip)
 */
export function requestEditConfirmation(
  kind: EditConfirmKind,
  discardCount: number,
  checkpoint: EditConfirmCheckpoint | null,
): Promise<EditConfirmResult> {
  if (discardCount <= 0) {
    return Promise.resolve({ confirmed: true, revertFiles: false })
  }
  // "Don't ask again" only short-circuits the truncate-only flavor.
  // If a checkpoint is on offer we ALWAYS show the dialog so the user
  // can make an explicit choice about file state.
  if (readDontAsk(kind) && !checkpoint) {
    return Promise.resolve({ confirmed: true, revertFiles: false })
  }

  if (Platform.OS !== "web") {
    return new Promise<EditConfirmResult>((resolve) => {
      const title =
        kind === "edit" ? "Edit message?" : "Retry from this message?"
      const body = composeBodyText(kind, discardCount, checkpoint)
      // Native Alert can't host arbitrary controls, so we expose
      // the file-revert option as a SEPARATE destructive button.
      // The order matters — Cancel must be index 0 with "cancel"
      // style on iOS, otherwise it doesn't get the bold treatment.
      const buttons: Array<{
        text: string
        style?: "cancel" | "destructive" | "default"
        onPress: () => void
      }> = [
        {
          text: "Cancel",
          style: "cancel",
          onPress: () => resolve({ confirmed: false, revertFiles: false }),
        },
        {
          text: kind === "edit" ? "Edit & Discard" : "Retry & Discard",
          style: checkpoint ? "default" : "destructive",
          onPress: () => resolve({ confirmed: true, revertFiles: false }),
        },
      ]
      if (checkpoint) {
        buttons.push({
          text: kind === "edit" ? "Edit & Revert files" : "Retry & Revert files",
          style: "destructive",
          onPress: () => resolve({ confirmed: true, revertFiles: true }),
        })
      }
      Alert.alert(title, body, buttons)
    })
  }

  return new Promise<EditConfirmResult>((resolve) => {
    pushRequest({ kind, discardCount, checkpoint, resolve })
  })
}

function composeBodyText(
  kind: EditConfirmKind,
  discardCount: number,
  checkpoint: EditConfirmCheckpoint | null,
): string {
  const noun = discardCount === 1 ? "message" : "messages"
  const lead =
    kind === "edit"
      ? `Editing this message will permanently remove the ${discardCount} ${noun} after it — including the assistant's reply and any tool calls — and re-run from this point.`
      : `Retrying from this message will permanently remove the ${discardCount} ${noun} after it — including the assistant's reply and any tool calls — and re-run the agent from this point.`
  const filesNote = checkpoint
    ? ` You can optionally revert project files to the checkpoint from before this message.`
    : ""
  return `${lead}${filesNote} This cannot be undone.`
}

/**
 * Best-effort relative time for the checkpoint label
 * ("3 minutes ago", "yesterday"). Avoids pulling in a date-fns
 * dependency just for this — the dialog only needs a short hint.
 */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
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

// ─── Host wiring ────────────────────────────────────────────────────────────
// Requests are queued in a tiny module-level array and surfaced to the
// host component via a subscriber callback. This indirection means
// EditableUserMessage can call `requestEditConfirmation(...)` from any
// nested bubble without having a ref to the host.

type Subscriber = (request: EditConfirmRequest | null) => void

let activeRequest: EditConfirmRequest | null = null
const subscribers = new Set<Subscriber>()

function pushRequest(request: EditConfirmRequest) {
  // If a prior request is still open, auto-cancel it. Two-at-a-time
  // is a UX bug, not a feature — the user clicking Edit twice should
  // collapse to the latest invocation.
  if (activeRequest) {
    activeRequest.resolve({ confirmed: false, revertFiles: false })
  }
  activeRequest = request
  for (const sub of subscribers) sub(request)
}

function clearRequest() {
  activeRequest = null
  for (const sub of subscribers) sub(null)
}

/**
 * Mount once near the top of the chat tree (e.g. inside ChatPanel).
 * Renders nothing until a request comes in. On web, hosts an
 * AlertDialog; on native, this component is a no-op (Alert.alert
 * handles it directly from requestEditConfirmation).
 */
export function EditConfirmDialogHost() {
  const [request, setRequest] = useState<EditConfirmRequest | null>(null)
  const [dontAsk, setDontAsk] = useState(false)
  // Defaults ON when a checkpoint is available — matches the Cursor
  // reference UX where "Revert" is the primary action. Reset on each
  // new request below.
  const [revertFiles, setRevertFiles] = useState(false)

  useEffect(() => {
    subscribers.add(setRequest)
    return () => {
      subscribers.delete(setRequest)
    }
  }, [])

  // Reset the per-dialog toggles whenever a fresh request opens. We
  // do NOT carry "Don't ask again" across requests on purpose —
  // that's a one-shot opt-out per dialog instance.
  useEffect(() => {
    if (request) {
      setDontAsk(false)
      setRevertFiles(Boolean(request.checkpoint))
    }
  }, [request])

  const handleConfirm = useCallback(() => {
    if (!request) return
    // Persist "Don't ask again" only for the truncate-only flavor.
    // When a checkpoint is on offer we forced the dialog open
    // regardless of the prior preference, so don't let the toggle
    // change that preference either — it'd be a confusing footgun.
    if (dontAsk && !request.checkpoint) {
      writeDontAsk(request.kind, true)
    }
    request.resolve({
      confirmed: true,
      // Only respect the toggle when a checkpoint was actually offered.
      revertFiles: Boolean(request.checkpoint) && revertFiles,
    })
    clearRequest()
  }, [request, dontAsk, revertFiles])

  const handleCancel = useCallback(() => {
    if (!request) return
    request.resolve({ confirmed: false, revertFiles: false })
    clearRequest()
  }, [request])

  if (Platform.OS !== "web") return null
  if (!request) return null

  const title =
    request.kind === "edit" ? "Edit message?" : "Retry from this message?"

  // Two-line confirm button when revertFiles is enabled — the
  // primary destructive action label changes to reflect that we'll
  // ALSO roll back files. Matches the implicit Cursor convention
  // of one prominent destructive button per dialog rather than
  // two competing CTAs.
  const confirmLabel = (() => {
    const base = request.kind === "edit" ? "Edit" : "Retry"
    const tail = ` & Discard ${request.discardCount}`
    const filesSuffix =
      request.checkpoint && revertFiles ? " · Revert files" : ""
    return `${base}${tail}${filesSuffix}`
  })()

  return (
    <AlertDialog isOpen onClose={handleCancel} size="sm">
      <AlertDialogBackdrop />
      <AlertDialogContent>
        <AlertDialogHeader>
          <Heading size="md" className="text-typography-950">
            {title}
          </Heading>
        </AlertDialogHeader>
        <AlertDialogBody className="mt-3 mb-4">
          <UIText size="sm" className="text-typography-700">
            {composeBodyText(request.kind, request.discardCount, request.checkpoint)}
          </UIText>

          {request.checkpoint && (
            <Pressable
              onPress={() => setRevertFiles((v) => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: revertFiles }}
              accessibilityLabel="Also revert project files to the checkpoint before this message"
              className="mt-4 flex-row items-start gap-2"
            >
              <View
                className={cn(
                  "h-4 w-4 mt-0.5 rounded border items-center justify-center",
                  revertFiles
                    ? "bg-primary border-primary"
                    : "border-muted-foreground/50 bg-transparent",
                )}
              >
                {revertFiles && (
                  <Check className="h-3 w-3 text-primary-foreground" />
                )}
              </View>
              <View className="flex-1">
                <UIText size="sm" className="text-typography-700 font-medium">
                  Also revert project files
                </UIText>
                <UIText size="xs" className="text-typography-500 mt-0.5">
                  {`Rolls files back to the checkpoint from ${formatRelativeTime(
                    request.checkpoint.createdAt,
                  )}`}
                  {request.checkpoint.filesChanged > 0
                    ? ` (${request.checkpoint.filesChanged} file${
                        request.checkpoint.filesChanged === 1 ? "" : "s"
                      } changed).`
                    : "."}
                  {" Your current files are auto-saved first so you can roll forward again from the Checkpoints panel."}
                </UIText>
              </View>
            </Pressable>
          )}

          {!request.checkpoint && (
            <Pressable
              onPress={() => setDontAsk((v) => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: dontAsk }}
              accessibilityLabel="Don't ask again for this action"
              className="mt-4 flex-row items-center gap-2"
            >
              <View
                className={cn(
                  "h-4 w-4 rounded border items-center justify-center",
                  dontAsk
                    ? "bg-primary border-primary"
                    : "border-muted-foreground/50 bg-transparent",
                )}
              >
                {dontAsk && (
                  <Check className="h-3 w-3 text-primary-foreground" />
                )}
              </View>
              <UIText size="sm" className="text-typography-600">
                Don't ask again
              </UIText>
            </Pressable>
          )}
        </AlertDialogBody>
        <AlertDialogFooter>
          <Button
            variant="outline"
            action="secondary"
            onPress={handleCancel}
          >
            <ButtonText>Cancel</ButtonText>
          </Button>
          <Button action="negative" onPress={handleConfirm}>
            <ButtonText>{confirmLabel}</ButtonText>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
