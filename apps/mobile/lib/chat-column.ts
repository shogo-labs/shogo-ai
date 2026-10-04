// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The ONE definition of the chat column: the horizontal band that the
 * header, transcript, dock cards (Error, Changes, Queue, ...) and composer
 * all live in.
 *
 * Max-width and side gutter travel together here. Surfaces never pick
 * their own `max-w-*` / `px-*` for horizontal placement; they render
 * through `ChatColumn` (components/chat/ChatColumn.tsx) or spread
 * `chatColumnStyle(...)`, so their visible edges are identical by
 * construction. `lib/__tests__/chat-column.guard.test.ts` fails when a
 * chat surface reintroduces a private width.
 */
import { CHAT_TRANSCRIPT_MAX_WIDTH } from "./native-composer-keyboard"
import { NATIVE_PHONE_GUTTER } from "./native-phone-layout"

export type ChatColumnPresentation = "agent" | "studio"

/** Max outer width (gutters included) of the agent chat column. */
export const AGENT_CHAT_COLUMN_MAX_WIDTH = 760
/** Side gutter of the agent chat column on wide viewports. */
export const AGENT_CHAT_COLUMN_GUTTER = 24
/** Side gutter of the studio chat column on wide viewports. */
export const STUDIO_CHAT_COLUMN_GUTTER = 12

export interface ChatColumnOptions {
  presentation?: ChatColumnPresentation
  /** Phone chrome (native handset or narrow web viewport). */
  phone?: boolean
  /**
   * Pixel width measured from the window. Yoga cannot resolve `%` widths in
   * some native containers, so phones pass the window width here; it
   * replaces the `maxWidth` cap but keeps the same gutter.
   */
  measuredWidth?: number
}

export interface ChatColumnSpec {
  /** Outer max-width (gutters included). `undefined` when measured. */
  maxWidth: number | undefined
  /** Left/right padding applied to the column. */
  gutter: number
  /** Pixel width when measured, otherwise `undefined` (width is 100%). */
  measuredWidth: number | undefined
  /** Width available to content: outer width minus both gutters. */
  contentMaxWidth: number | undefined
}

export function chatColumn({
  presentation = "studio",
  phone = false,
  measuredWidth,
}: ChatColumnOptions = {}): ChatColumnSpec {
  const agent = presentation === "agent"
  const gutter = phone
    ? NATIVE_PHONE_GUTTER
    : agent
      ? AGENT_CHAT_COLUMN_GUTTER
      : STUDIO_CHAT_COLUMN_GUTTER
  const maxWidth = measuredWidth
    ? undefined
    : agent
      ? AGENT_CHAT_COLUMN_MAX_WIDTH
      : CHAT_TRANSCRIPT_MAX_WIDTH
  return {
    maxWidth,
    gutter,
    measuredWidth: measuredWidth || undefined,
    contentMaxWidth:
      maxWidth === undefined ? undefined : Math.max(0, maxWidth - gutter * 2),
  }
}

/**
 * Layout style for a surface that IS the column. Applied via `style` (not
 * `className`) so NativeWind css-interop can never drop it.
 */
export function chatColumnStyle(options: ChatColumnOptions = {}): {
  width: number | "100%"
  maxWidth?: number
  alignSelf: "center"
  paddingHorizontal: number
} {
  const column = chatColumn(options)
  return column.measuredWidth
    ? {
        width: column.measuredWidth,
        alignSelf: "center",
        paddingHorizontal: column.gutter,
      }
    : {
        width: "100%",
        maxWidth: column.maxWidth,
        alignSelf: "center",
        paddingHorizontal: column.gutter,
      }
}
