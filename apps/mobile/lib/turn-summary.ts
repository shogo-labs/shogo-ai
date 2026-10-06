// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** The one-line recap under a finished turn: how many steps ran, what failed, which files changed. */

export interface TurnToolLike {
  toolName: string
  state: 'streaming' | 'success' | 'error' | string
  args?: Record<string, unknown>
}

export interface TurnToolSummary {
  steps: number
  failed: number
  /** Distinct files edited or written, in the order first touched. */
  files: string[]
}

const EDIT_TOOLS = /^(edit_file|str_replace|write_file|create_file|apply_patch|edit|write)$/i

function pathOf(args: Record<string, unknown> | undefined): string | null {
  for (const key of ['path', 'file_path', 'target_file']) {
    const value = args?.[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

export function summarizeTurnTools(tools: readonly TurnToolLike[]): TurnToolSummary {
  const files: string[] = []
  for (const tool of tools) {
    if (!EDIT_TOOLS.test(tool.toolName)) continue
    const path = pathOf(tool.args)
    if (path && !files.includes(path)) files.push(path)
  }
  return { steps: tools.length, failed: tools.filter((t) => t.state === 'error').length, files }
}

/** "4 steps · 2 files changed · 1 failed", or null when nothing ran. */
export function turnSummaryText(summary: TurnToolSummary): string | null {
  if (summary.steps === 0) return null
  const parts = [`${summary.steps} step${summary.steps === 1 ? '' : 's'}`]
  if (summary.files.length) parts.push(`${summary.files.length} file${summary.files.length === 1 ? '' : 's'} changed`)
  if (summary.failed) parts.push(`${summary.failed} failed`)
  return parts.join(' · ')
}
