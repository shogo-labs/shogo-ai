// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { diffArrays } from 'diff'

function asRecord(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'object') return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object'
        ? parsed as Record<string, unknown>
        : {}
    } catch {
      return {}
    }
  }
  return {}
}

function lineCount(value: string): number {
  if (!value) return 0
  const normalized = value.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.length
}

/**
 * Return the line additions/removals represented by a completed file-writing
 * tool call. For replace_all edits, the successful tool result can provide
 * the exact replacement count. This deliberately ignores non-file tools and
 * never throws for malformed tool arguments.
 */
export function countLineChanges(
  toolName: string,
  rawArgs: unknown,
  rawResult?: unknown,
): { linesAdded: number; linesRemoved: number } {
  const args = asRecord(rawArgs)

  if (toolName === 'write_file') {
    return {
      linesAdded: typeof args.content === 'string' ? lineCount(args.content) : 0,
      linesRemoved: 0,
    }
  }

  if (toolName !== 'edit_file') {
    return { linesAdded: 0, linesRemoved: 0 }
  }

  const oldString = typeof args.old_string === 'string' ? args.old_string : ''
  const newString = typeof args.new_string === 'string' ? args.new_string : ''
  if (!oldString && !newString) return { linesAdded: 0, linesRemoved: 0 }

  const oldLines = oldString.replace(/\r\n/g, '\n').split('\n')
  const newLines = newString.replace(/\r\n/g, '\n').split('\n')
  if (oldLines.at(-1) === '') oldLines.pop()
  if (newLines.at(-1) === '') newLines.pop()
  const changes = diffArrays(oldLines, newLines)
  const result = asRecord(rawResult)
  const replacements = args.replace_all === true && typeof result.replacements === 'number'
    ? Math.max(1, Math.floor(result.replacements))
    : 1
  let linesAdded = 0
  let linesRemoved = 0
  for (const change of changes) {
    if (change.added) linesAdded += (change.count ?? change.value.length) * replacements
    if (change.removed) linesRemoved += (change.count ?? change.value.length) * replacements
  }

  return { linesAdded, linesRemoved }
}
