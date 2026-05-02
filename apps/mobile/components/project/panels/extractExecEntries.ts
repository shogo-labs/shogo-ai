// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pure helper that pulls exec / Bash tool calls out of `useChat` messages
 * so the runtime-log store can fold them in alongside server-derived
 * entries without dragging in `react-native`.
 *
 * `TerminalPanel.tsx` re-exports these for backwards compat with existing
 * imports.
 */

export interface ExecEntry {
  id: string
  command: string
  stdout: string
  stderr: string
  exitCode: number
  durationMs?: number
  timestamp: number
}

export function extractExecEntries(messages: any[]): ExecEntry[] {
  const entries: ExecEntry[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const parts = msg.parts as any[] | undefined
    if (!parts) continue
    for (const part of parts) {
      const isToolInvocation = part.type === 'tool-invocation'
      const isDynamicTool = part.type === 'dynamic-tool'
      if (!isToolInvocation && !isDynamicTool) continue

      const toolName = isToolInvocation ? part.toolInvocation?.toolName : part.toolName
      if (toolName !== 'exec' && toolName !== 'Bash') continue

      const args = isToolInvocation ? part.toolInvocation?.args : part.input
      const result = isToolInvocation ? part.toolInvocation?.result : part.output
      const state = isToolInvocation ? part.toolInvocation?.state : part.state
      const id = isToolInvocation ? part.toolInvocation?.toolCallId : part.id

      if (!args?.command) continue
      // `state === 'pending'` (no result yet) → exitCode -1 sentinel; the
      // runtime-log store skips these so the buffer doesn't churn while
      // a long-running exec is in flight.
      const hasResult = state === 'result' || state === 'output-available'

      const r =
        typeof result === 'object' && result !== null
          ? (result as Record<string, unknown>)
          : {}
      entries.push({
        id: id || `exec-${entries.length}`,
        command: args.command as string,
        stdout:
          typeof r.stdout === 'string'
            ? r.stdout
            : typeof result === 'string'
              ? result
              : '',
        stderr: typeof r.stderr === 'string' ? r.stderr : '',
        exitCode:
          typeof r.exitCode === 'number' ? r.exitCode : hasResult ? 0 : -1,
        durationMs:
          typeof r.durationMs === 'number' ? r.durationMs : undefined,
        timestamp: msg.createdAt
          ? new Date(msg.createdAt).getTime()
          : Date.now(),
      })
    }
  }
  return entries
}
