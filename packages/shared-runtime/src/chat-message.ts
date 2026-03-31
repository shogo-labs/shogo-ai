// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * User message extraction for AI SDK v3 (parts) and legacy (content) formats.
 * Shared between runtime and agent-runtime.
 */

/**
 * Find the last user message in a messages array.
 */
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
