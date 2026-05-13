// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * User message extraction for AI SDK v3 (`parts`) and legacy (`content`)
 * message shapes. Useful when you need plain text from a chat history —
 * e.g. for fingerprinting, logging, or short-circuit routing decisions
 * before the message hits an LLM.
 *
 * Lifted into the SDK from `@shogo/shared-runtime` (was AGPL) under MIT.
 * The original `@shogo/shared-runtime/chat-message` re-exports this
 * module unchanged for backwards compatibility.
 */

/** Find the last user message in a messages array. */
export function findLastUserMessage(messages: any[]): any | null {
  return [...messages].reverse().find((m: any) => m.role === 'user') ?? null
}

/**
 * Extract plain text from a user message object.
 * Handles AI SDK v3 `parts` format, legacy `content` string,
 * and legacy `content` array format.
 */
export function extractUserText(message: any): string {
  if (typeof message.content === 'string') {
    return message.content
  }
  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('\n')
  }
  return String(message.content ?? '')
}
