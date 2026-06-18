// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Helpers for extracting a command line from xterm buffer + OSC633 Command records.
 */
import type { Terminal as XTerminal } from '@xterm/xterm'
import type { Command } from './osc633-tracker'

/** Extract the user-typed command text for clipboard / context menus. */
export function extractCommandText(command: Command, term: XTerminal | null): string {
  const fromOsc = command.commandLine?.trim()
  if (fromOsc) return fromOsc

  if (!term) return ''

  const promptLine = command.promptMarker?.line
  const startLine = command.startMarker?.line
  if (promptLine != null && startLine != null && startLine >= promptLine) {
    const base = term.buffer.active.baseY
    const raw = term.buffer.active.getLine(startLine - base)?.translateToString(true) ?? ''
    const lastDollar = Math.max(raw.lastIndexOf('$ '), raw.lastIndexOf('% '), raw.lastIndexOf('> '))
    if (lastDollar >= 0) return raw.slice(lastDollar + 2).trim()
    if (startLine > promptLine) return raw.trim()
  }

  if (promptLine != null) {
    const base = term.buffer.active.baseY
    const promptRow = term.buffer.active.getLine(promptLine - base)?.translateToString(true) ?? ''
    const lastDollar = Math.max(promptRow.lastIndexOf('$ '), promptRow.lastIndexOf('% '))
    if (lastDollar >= 0) return promptRow.slice(lastDollar + 2).trim()
  }

  return ''
}
