// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TurnFooterContext
 *
 * Lets `TurnFooter` (mounted once per completed assistant turn, deep
 * in the TurnList tree) request feedback / fork actions without
 * ChatPanel threading callbacks through TurnList -> TurnGroup ->
 * TurnFooter as props.
 *
 * Same rationale as `MessageEditContext`: `TurnGroup` is `memo`'d on
 * `prev.turn === next.turn`, so callback props would defeat that memo
 * on every ChatPanel render. Context keeps the memo intact — a
 * footer re-renders only when its own feedback state changes (via
 * `useSyncExternalStore`-style subscription below), not on every
 * parent render.
 *
 * ChatPanel is the producer (it owns the per-session
 * ChatMessageCollection / ChatSessionCollection and the session's
 * feedback map, loaded once via `getSessionFeedback`). `TurnFooter`
 * is the consumer.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react"

export type MessageFeedbackThumbs = "up" | "down"

export interface TurnFooterContextValue {
  /**
   * The caller's current reaction to a message, or `undefined` if
   * they haven't reacted. Backed by a plain object (not a Map) so
   * `TurnFooter` can read it directly in render without a subscribe
   * dance — ChatPanel re-renders on feedback change already own the
   * one prop that matters.
   */
  feedback: Record<string, MessageFeedbackThumbs>

  /**
   * Set (or flip) the caller's reaction to a message. Tapping the
   * currently-active thumb again calls `clearFeedback` instead — see
   * `TurnFooter`'s toggle logic.
   */
  setFeedback: (messageId: string, thumbs: MessageFeedbackThumbs) => Promise<void>

  /** Clear the caller's reaction to a message. */
  clearFeedback: (messageId: string) => Promise<void>

  /**
   * Fork the session at `messageId`: clones the history up to and
   * including that message into a brand-new session and switches the
   * active chat to it. Resolves once the switch has been requested —
   * callers don't need to do anything further with the result.
   */
  forkFromMessage: (messageId: string) => Promise<void>

  /**
   * Whether a message id is eligible for the footer's actions.
   * Optimistic / not-yet-persisted ids (`temp-*`, `optimistic-*`)
   * can't be reacted to or forked from server-side yet.
   */
  canActOnMessage: (messageId: string) => boolean
}

const TurnFooterContext = createContext<TurnFooterContextValue | null>(null)

export interface TurnFooterProviderProps extends TurnFooterContextValue {
  children: ReactNode
}

export function TurnFooterProvider({
  feedback,
  setFeedback,
  clearFeedback,
  forkFromMessage,
  canActOnMessage,
  children,
}: TurnFooterProviderProps) {
  const value = useMemo<TurnFooterContextValue>(
    () => ({ feedback, setFeedback, clearFeedback, forkFromMessage, canActOnMessage }),
    [feedback, setFeedback, clearFeedback, forkFromMessage, canActOnMessage],
  )
  return (
    <TurnFooterContext.Provider value={value}>
      {children}
    </TurnFooterContext.Provider>
  )
}

/**
 * Returns the context value or null. Returning null (instead of
 * throwing) makes `TurnFooter` degrade gracefully — it just renders
 * the copy button alone (no feedback/fork) when used outside a
 * provider, which matters for storybook / tests that mount
 * `TurnGroup` standalone.
 */
export function useTurnFooterContext(): TurnFooterContextValue | null {
  return useContext(TurnFooterContext)
}
