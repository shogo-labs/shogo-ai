// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TerminalSelection — captures text from xterm.js terminal.
 *
 * Used by the "Add to Chat" feature to grab the user's selection
 * or recent scrollback buffer content.
 */
import type { Terminal as XTerminal } from '@xterm/xterm'

export interface TerminalSelectionResult {
  /** The captured text content. */
  text: string
  /** Whether this was a user selection (true) or scrollback capture (false). */
  isSelection: boolean
  /** The working directory of the terminal, if known. */
  cwd: string | null
}

/**
 * Capture text from the terminal.
 *
 * Priority:
 *   1. If user has an active text selection, return it
 *   2. Otherwise, return the last `maxLines` lines of the scrollback buffer
 */
export function captureTerminalText(
  term: XTerminal,
  opts: { maxLines?: number; cwd?: string | null } = {},
): TerminalSelectionResult {
  const maxLines = opts.maxLines ?? 200
  const cwd = opts.cwd ?? null

  // 1. Try user selection
  const selection = term.getSelection()
  if (selection && selection.trim().length > 0) {
    return { text: selection, isSelection: true, cwd }
  }

  // 2. Fall back to recent scrollback
  const buffer = term.buffer.active
  const totalLines = buffer.length
  const startLine = Math.max(0, totalLines - maxLines)
  const lines: string[] = []

  for (let i = startLine; i < totalLines; i++) {
    const line = buffer.getLine(i)
    if (line) {
      lines.push(line.translateToString(true))
    }
  }

  // Trim leading empty lines
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift()
  }

  return {
    text: lines.join('\n'),
    isSelection: false,
    cwd,
  }
}

/**
 * Format captured terminal text for injection into a chat message.
 * Wraps in a collapsible [CONTEXT] block with clear delimiters.
 */
export function formatTerminalContextForChat(result: TerminalSelectionResult): string {
  const lines: string[] = []

  lines.push('[CONTEXT — auto-generated, do not cite directly]')
  lines.push('## Terminal')
  lines.push(result.text.trim())
  if (result.cwd) {
    lines.push(`cwd: ${result.cwd}`)
  }
  lines.push('[END CONTEXT]')

  return lines.join('\n')
}
