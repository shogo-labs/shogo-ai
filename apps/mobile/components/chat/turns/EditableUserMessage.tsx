// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * EditableUserMessage
 *
 * Renders a previously-sent user message as a full-width row that
 * the user can click to enter edit mode. Edit mode swaps the row
 * for a full `<ChatInput>` pre-populated with the original text +
 * attachments (via `restoreDraftRequest`) and the same model picker
 * the bottom composer uses (via `MessageEditContext.composerProps`).
 *
 * Why reuse ChatInput instead of a bespoke <TextInput>:
 *   - One source of truth for shortcuts, paste handling, file
 *     attachments, model picker, voice input, and skill picker —
 *     the editing experience is identical to writing a brand new
 *     message, just rooted at this position in history.
 *   - The model picker is shared with the bottom composer, so
 *     switching models inside an edit also affects subsequent
 *     fresh sends — matching user mental model.
 *
 * Display vs edit:
 *   - DISPLAY: full-width Pressable with the original text +
 *     attachments inside. Clicking anywhere on the row enters edit
 *     mode (child Pressables on image / file thumbnails capture
 *     their own presses, so opening a thumbnail does NOT trigger
 *     edit). On web a single hover-revealed "Retry from here" icon
 *     sits on the right; on native it is always visible.
 *   - EDIT: full ChatInput + a Cancel button below. ChatInput's
 *     own send button (or ⌘↩) triggers `onSubmit`, which we route
 *     through the same destructive-confirmation + optional file
 *     revert pipeline as the previous in-place TextInput flow.
 *     Escape cancels (web).
 *
 * Guards (same as the previous v1):
 *   - Disabled entirely while the agent is streaming — editing
 *     mid-stream would race the in-flight `useChat` request.
 *   - Disabled for optimistic / temp ids — those rows have no
 *     server presence yet, so `truncate-from` would 404.
 *   - When no MessageEditProvider is mounted (Storybook,
 *     isolated tests) the row degrades to a plain MessageContent
 *     display with no actions.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { View, Pressable, Platform, ActivityIndicator } from "react-native"
import { RotateCcw } from "lucide-react-native"
import type { UIMessage } from "@ai-sdk/react"
import { cn } from "@shogo/shared-ui/primitives"
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
import {
  ChatInput,
  type FileAttachment,
  type RestoreDraftRequest,
} from "../ChatInput"

export interface EditableUserMessageProps {
  message: UIMessage
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
 * Build the `FileAttachment[]` shape ChatInput expects from a UI
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
  className,
}: EditableUserMessageProps) {
  const ctx = useMessageEditContext()

  const [isEditing, setIsEditing] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restoreDraftRequest, setRestoreDraftRequest] =
    useState<RestoreDraftRequest | null>(null)

  // Monotonically-increasing nonce so a second click on the same
  // bubble (e.g. user cancels, then clicks again) forces ChatInput
  // to re-run its restore-draft effect even though the content
  // string itself didn't change.
  const draftNonceRef = useRef(0)

  // Ref to the edit-mode container so the global outside-click
  // listener (web only) can distinguish "click inside the edit
  // surface" from "click somewhere else in the page" via
  // `node.contains(event.target)`. On RN Web, a View's ref is the
  // underlying DOM element — we cast through `unknown` to access
  // DOM APIs without dragging in DOM types in the public surface.
  const containerRef = useRef<View>(null)

  const originalText = useMemo(() => extractTextContent(message), [message])
  const originalFiles = useMemo(() => extractFileAttachments(message), [message])

  const editable = ctx ? ctx.canEditMessage(message) : false
  const interactive = Boolean(ctx && editable && !ctx.isStreaming && !busy)

  // Retry icon on the right of the bubble. Web: hover-revealed to
  // keep historical turns visually quiet. Native (no hover): always
  // visible — same convention as the queued-message row in
  // ChatInput.tsx (~774).
  const showRetryIcon = Boolean(
    interactive && !isEditing && (Platform.OS !== "web" || hovered),
  )

  const handleStartEdit = useCallback(() => {
    if (!interactive) return
    draftNonceRef.current += 1
    setRestoreDraftRequest({
      nonce: draftNonceRef.current,
      content: originalText,
      files: originalFiles,
    })
    setIsEditing(true)
  }, [interactive, originalText, originalFiles])

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false)
    setBusy(false)
    setRestoreDraftRequest(null)
  }, [])

  // Escape cancels the edit (web only — native keyboard dismissal
  // is handled by the OS chrome around the TextInput). We attach
  // to the window because ChatInput's TextInput doesn't expose a
  // dedicated escape callback and we don't want to fork it.
  useEffect(() => {
    if (Platform.OS !== "web") return
    if (!isEditing) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        handleCancelEdit()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [isEditing, handleCancelEdit])

  // Click-outside cancels (web only). The classic "popover dismiss"
  // pattern: any mousedown that lands outside the edit container
  // OR outside an interaction surface that logically belongs to the
  // edit (a portaled popover, the destructive-confirm dialog, the
  // attach sheet, the model menu, etc.) collapses the row back to
  // display mode.
  //
  // We use `mousedown` instead of `click` so the dismiss feels
  // snappy (matches the "blur" mental model — same instant the
  // press lands). Capture phase so we observe the event before any
  // inner stopPropagation can hide it.
  //
  // The exempted-roles list mirrors the ARIA surfaces Gluestack's
  // Popover / Menu / Modal / AlertDialog primitives render with;
  // missing one would mean opening a model picker from inside an
  // edit and clicking a model option would cancel the edit out
  // from under the user. `aria-modal="true"` is the broad
  // catch-all that picks up any future surface we forget.
  useEffect(() => {
    if (Platform.OS !== "web") return
    if (!isEditing) return

    const handler = (e: MouseEvent) => {
      const target = e.target
      if (!(target instanceof Element)) return

      // Click landed inside the edit container itself — that's the
      // ChatInput, its toolbar, the Cancel button, etc. Stay in
      // edit mode.
      const node = containerRef.current as unknown as Element | null
      if (node && node.contains(target)) return

      // Click landed inside a portaled overlay (popover / menu /
      // dropdown / dialog). These render outside our container's
      // subtree, but logically belong to the in-edit interaction
      // — e.g. the model picker popover the user just opened from
      // inside the in-place ChatInput, or the destructive-confirm
      // dialog that opens when they hit Send. Cancelling on those
      // would yank the editor out from under them mid-decision.
      if (
        target.closest(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]',
        )
      ) {
        return
      }

      handleCancelEdit()
    }

    window.addEventListener("mousedown", handler, true)
    return () => window.removeEventListener("mousedown", handler, true)
  }, [isEditing, handleCancelEdit])

  /**
   * Resolve the checkpoint (if any) to offer as a file-revert target
   * for the upcoming dialog. We only bother querying when there are
   * messages that would actually be discarded — when `discardCount`
   * is 0 the user is editing the most recent message and there's no
   * agent work to roll back.
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
   * confirm semantics + file-revert plumbing.
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

  /**
   * Wraps ChatInput's `onSubmit(content, files, modelId)` and routes
   * it through the destructive-confirmation + optional file revert
   * pipeline before triggering the actual truncate + resend.
   *
   * We deliberately ignore `modelId` here even though ChatInput
   * passes it. The model is already wired through
   * `composerProps.onModelChange` (see `MessageEditContext.tsx`),
   * which keeps the bottom composer in sync — so by the time the
   * resend fires, ChatPanel's selectedModel is already the user's
   * chosen value and `sendMessageInternal` picks it up naturally.
   */
  const handleChatInputSubmit = useCallback(
    async (content: string, files?: FileAttachment[]) => {
      if (!ctx) return
      const trimmed = content.trim()
      const hasFiles = !!files && files.length > 0
      // ChatInput already enforces non-empty before firing, but
      // double-check so a stray programmatic submit can't wipe the
      // assistant turn with literally nothing.
      if (!trimmed && !hasFiles) return
      await dispatchRewind("edit", async (options) => {
        await ctx.editMessage(message.id, trimmed, files, options)
        // On success the message id will disappear from the parent
        // collection and THIS component unmounts. We still reset
        // local state defensively in case the parent decides to
        // keep us mounted (e.g. dedicated edit panel in a future
        // layout).
        setIsEditing(false)
        setRestoreDraftRequest(null)
      })
    },
    [ctx, message.id, dispatchRewind],
  )

  const handleRetry = useCallback(async () => {
    await dispatchRewind("retry", async (options) => {
      if (!ctx) return
      await ctx.retryFromMessage(message.id, options)
    })
  }, [ctx, message.id, dispatchRewind])

  // ─── EDIT MODE ────────────────────────────────────────────────
  // Just ChatInput rendered inline, with `highlighted` toggled on
  // so the accent ring sits directly on the visible input box (no
  // outer wrapper styling, no padding, no banner, no separate
  // cancel chrome). The ring is the only mode signal. Cancellation
  // is handled by the global Escape handler and the
  // outside-mousedown handler above (web), or by submitting (which
  // routes through the destructive-confirm dialog regardless).
  //
  // We can't draw the ring from a wrapping <View> at this level
  // because ChatInput's outermost element carries `p-3 pt-0` of
  // its own — wrapping it with a ring/padding from outside would
  // leave a 12px gap on three sides. The ring lives inside
  // ChatInput where it can hug the actual rounded box.
  //
  // The wrapping <View> below adds NO visual chrome — it exists
  // solely to give the outside-click handler a stable DOM node to
  // check `node.contains(event.target)` against. ChatInput itself
  // is memoized and not forward-ref'd, so we can't get the same
  // handle from the component directly without an invasive change.
  if (isEditing && ctx) {
    return (
      <View ref={containerRef} className="w-full">
        <ChatInput
          onSubmit={handleChatInputSubmit}
          disabled={busy}
          isStreaming={busy}
          placeholder="Edit your message…"
          restoreDraftRequest={restoreDraftRequest}
          selectedModel={ctx.composerProps.selectedModel}
          onModelChange={ctx.composerProps.onModelChange}
          isPro={ctx.composerProps.isPro}
          onUpgradeClick={ctx.composerProps.onUpgradeClick}
          highlighted
          // `flush` strips ChatInput's default `p-3` outer wrapper
          // (it'd otherwise inset the bordered box 12px from the
          // bubble's edges — visually fatter than the display row
          // it replaces). The display Pressable already provides
          // an `px-3` text inset; the inline editor doesn't add
          // its own on top.
          flush
          // The queue, interaction-mode and quick-actions surfaces
          // belong to the bottom composer's lifecycle — exposing
          // them from inside a historical edit would mean the user
          // could queue a message from an edit-in-progress bubble,
          // which is confusing. Keep them inert here.
          queuedMessages={[]}
          dimWhenDisabled={false}
        />
      </View>
    )
  }

  // ─── DISPLAY MODE ─────────────────────────────────────────────
  // Full-width Pressable. Click anywhere on the row → edit mode.
  // Image / file thumbnails inside MessageContent each own a
  // Pressable, so their `onPress` captures the gesture before it
  // bubbles to this outer Pressable — opening an attachment does
  // NOT switch the bubble into edit mode.
  return (
    <Pressable
      onPress={handleStartEdit}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      disabled={!interactive}
      accessibilityRole={interactive ? "button" : undefined}
      accessibilityLabel={
        interactive ? "Edit this message and re-run from here" : undefined
      }
      accessibilityHint={
        interactive
          ? "Activates an inline composer pre-filled with this message."
          : undefined
      }
      className={cn(
        "w-full rounded-md px-3 py-2 flex-row items-start gap-2",
        // Resting fill is intentionally subtler than the previous
        // chat-bubble bg-secondary so a long thread of historical
        // user messages doesn't read as a row of stacked CTAs.
        "bg-secondary/60",
        Platform.OS === "web" &&
          interactive &&
          "hover:bg-secondary cursor-text",
        busy && "opacity-60",
        className,
      )}
    >
      <View className="flex-1 min-w-0">
        <MessageContent message={message} />
      </View>
      {showRetryIcon && (
        <Pressable
          onPress={handleRetry}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Retry from this message"
          className={cn(
            "h-6 w-6 items-center justify-center rounded-md",
            Platform.OS === "web" && "hover:bg-muted/60",
            busy && "opacity-40",
          )}
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
      )}
    </Pressable>
  )
})

export default EditableUserMessage
