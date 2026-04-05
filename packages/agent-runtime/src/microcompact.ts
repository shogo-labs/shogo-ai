// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Layer 2: Microcompact — zero-cost head/tail compression of old tool results.
 *
 * Aggressively compresses tool results that are large but not yet worth
 * summarizing via LLM. Pure string manipulation — no API calls.
 */

import type { Message, ToolResultMessage, TextContent, ToolCall } from '@mariozechner/pi-ai'

export interface MicrocompactConfig {
  /** Char threshold above which a tool result gets compressed (default: 2000) */
  threshold: number
  /** Lines to keep from the beginning of a large result (default: 20) */
  headLines: number
  /** Lines to keep from the end of a large result (default: 10) */
  tailLines: number
  /** Number of recent assistant turns to protect from compression (default: 3) */
  keepRecentTurns: number
}

const DEFAULT_CONFIG: MicrocompactConfig = {
  threshold: 2000,
  headLines: 20,
  tailLines: 10,
  keepRecentTurns: 3,
}

/** Tools whose output represents file content — safe to replace with a minimal placeholder */
const FILE_CONTENT_TOOLS = new Set(['read_file'])

/** All tools whose output is safe to aggressively compress */
const COMPACTABLE_TOOLS = new Set([
  'read_file', 'grep', 'glob', 'ls', 'list_files',
  'search', 'exec', 'web_search',
])

/**
 * Compress tool results older than `keepRecentTurns` using head/tail
 * line extraction. Returns a new array — never mutates the input.
 *
 * For file-read-like tools, replaces the content with a minimal
 * placeholder when the preceding assistant message requested a read.
 */
export function microcompact(
  messages: Message[],
  config?: Partial<MicrocompactConfig>,
): { messages: Message[]; tokensSaved: number } {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  const turnBoundaries: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') turnBoundaries.push(i)
  }
  const protectedStart = turnBoundaries.length >= cfg.keepRecentTurns
    ? turnBoundaries[cfg.keepRecentTurns - 1]
    : 0

  let tokensSaved = 0

  const result = messages.map((msg, idx) => {
    if (msg.role !== 'toolResult') return msg
    if (idx >= protectedStart) return msg

    const trm = msg as ToolResultMessage
    const textParts = trm.content.filter((c): c is TextContent => c.type === 'text')
    const totalChars = textParts.reduce((sum, c) => sum + c.text.length, 0)

    const toolName = findToolName(messages, idx)
    const isFileRead = toolName !== null && FILE_CONTENT_TOOLS.has(toolName)

    if (isFileRead) {
      const lineCount = textParts.reduce((sum, c) => sum + c.text.split('\n').length, 0)
      const placeholder = `[File content read — ${lineCount} lines, ${totalChars} chars]`
      tokensSaved += Math.ceil((totalChars - placeholder.length) / 4)
      return {
        ...trm,
        content: [{ type: 'text' as const, text: placeholder }],
      } as ToolResultMessage
    }

    if (totalChars <= cfg.threshold) return msg

    const newContent = trm.content.map((c) => {
      if (c.type !== 'text' || c.text.length <= cfg.threshold) return c

      const lines = c.text.split('\n')
      if (lines.length > cfg.headLines + cfg.tailLines + 1) {
        const head = lines.slice(0, cfg.headLines).join('\n')
        const tail = lines.slice(-cfg.tailLines).join('\n')
        const omitted = lines.length - cfg.headLines - cfg.tailLines
        const compressed = `${head}\n\n[... ${omitted} lines omitted ...]\n\n${tail}`
        tokensSaved += Math.ceil((c.text.length - compressed.length) / 4)
        return { type: 'text' as const, text: compressed }
      }

      // Few lines but still over threshold — char-based head/tail
      const headChars = Math.floor(cfg.threshold * 0.7)
      const tailChars = Math.floor(cfg.threshold * 0.2)
      const compressed = c.text.substring(0, headChars)
        + `\n\n[... ${c.text.length - headChars - tailChars} chars omitted ...]\n\n`
        + c.text.substring(c.text.length - tailChars)
      tokensSaved += Math.ceil((c.text.length - compressed.length) / 4)
      return { type: 'text' as const, text: compressed }
    })

    return { ...trm, content: newContent } as ToolResultMessage
  })

  return { messages: result, tokensSaved }
}

/**
 * Walk backwards from a toolResult to find the tool name from the
 * preceding assistant message's tool_use content block.
 */
function findToolName(messages: Message[], toolResultIdx: number): string | null {
  const trm = messages[toolResultIdx] as ToolResultMessage
  const callId = trm.toolCallId

  for (let i = toolResultIdx - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    for (const block of msg.content) {
      if (block.type === 'toolCall' && (block as ToolCall).id === callId) {
        return (block as ToolCall).name
      }
    }
    break
  }
  return null
}
