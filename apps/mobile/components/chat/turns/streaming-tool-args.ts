// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ToolCallData } from "../tools/types"

/**
 * Streaming file-tool arguments grow on every chunk (a `write_file` can stream
 * hundreds of KB). Widgets for a still-streaming call render a size and line
 * count only, and compare props with these O(keys) helpers instead of
 * stringifying the whole argument object per chunk.
 */

export function countLines(text: string): number {
  if (!text) return 0
  let lines = 1
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++
  return lines
}

/**
 * Cheap identity for streaming args: string values by length, other
 * primitives by value, nested objects by key only. Streamed arguments only
 * grow, so a changed length is a changed value.
 */
export function streamingArgsKey(args: Record<string, unknown> | undefined | null): string {
  if (!args) return ""
  let key = ""
  for (const name of Object.keys(args)) {
    const value = args[name]
    if (typeof value === "string") key += `${name}:s${value.length};`
    else if (value === null || typeof value !== "object") key += `${name}:${String(value)};`
    else key += `${name}:o;`
  }
  return key
}

function stableStringify(val: unknown): string {
  if (val === null || val === undefined) return ""
  if (typeof val === "string") return val
  try { return JSON.stringify(val) } catch { return "" }
}

export interface FileToolWidgetProps {
  tool: ToolCallData
  isExpanded?: boolean
  onToggle?: () => void
  className?: string
}

/**
 * Memo equality for the file tool widgets. `groupConsecutiveParts` upstream
 * rebuilds the `tool` object reference on every commit, so we can't use
 * referential equality on `tool` itself. Instead:
 *   - If `tool.id` matches AND state hasn't changed AND we're in a terminal
 *     state (success / error), args + result are frozen, so bail out with
 *     cheap primitive comparisons. This is the common case during long
 *     subagent runs where most widgets are already complete.
 *   - While streaming, the widget renders only a size/line summary, so
 *     compare the args by `streamingArgsKey` (string lengths) rather than
 *     stringifying a payload that can be hundreds of KB on every chunk.
 *   - Otherwise (state transition), fall back to the full content-equality
 *     JSON.stringify check. That's still cheaper than re-rendering the
 *     entire widget subtree.
 */
export function fileToolWidgetPropsEqual(prev: FileToolWidgetProps, next: FileToolWidgetProps): boolean {
  if (
    prev.isExpanded !== next.isExpanded ||
    prev.onToggle !== next.onToggle ||
    prev.className !== next.className
  ) {
    return false
  }
  if (prev.tool.state !== next.tool.state) return false
  if (prev.tool.error !== next.tool.error) return false
  if (prev.tool.id === next.tool.id) {
    if (next.tool.state !== "streaming") return true
    return streamingArgsKey(prev.tool.args) === streamingArgsKey(next.tool.args)
  }
  return (
    stableStringify(prev.tool.args) === stableStringify(next.tool.args) &&
    stableStringify(prev.tool.result) === stableStringify(next.tool.result)
  )
}
