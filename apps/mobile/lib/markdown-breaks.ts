// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Treat a typed newline as a line break.
 *
 * In CommonMark a single newline is a *soft* break, which renderers collapse to
 * a space — so text typed one line per entry arrives as one run-on paragraph.
 * That is fine for prose written in paragraphs, and wrong for the way people
 * actually use a channel doc or a chat message: a schedule, an address, a list
 * of links.
 *
 * A line ending in two or more spaces (or a backslash) is a *hard* break, which
 * is part of the spec rather than an extension, so every renderer we ship
 * honours it — remark on web and marked on native alike. Fixing it here, once,
 * avoids wiring a `breaks` option into two different markdown stacks (and
 * `react-native-marked` exposes no such option).
 *
 * Fenced code and table rows keep their exact layout: indentation inside a
 * fence is content, and a table's structure depends on its line boundaries.
 */

const FENCE_OPEN = /^(```|~~~)/
const ALREADY_HARD = /(?:[ ]{2,}|\\)$/

/**
 * Append a hard break to every soft-broken line.
 *
 * Idempotent: a line that already ends in a hard break is left alone, so this
 * is safe to apply to text that has passed through it before.
 */
export function withHardBreaks(markdown: string): string {
  // Nothing to break — also the common case (a one-line message).
  if (!markdown.includes('\n')) return markdown

  const out: string[] = []
  let inFence = false
  const lines = markdown.split('\n')

  for (const [index, raw] of lines.entries()) {
    // A hard break only matters where another line follows.
    const isLast = index === lines.length - 1
    // Preserve CRLF: the transform must not rewrite line endings.
    const carriage = raw.endsWith('\r') ? '\r' : ''
    const line = carriage ? raw.slice(0, -1) : raw

    if (FENCE_OPEN.test(line.trimStart())) {
      inFence = !inFence
      out.push(raw)
      continue
    }
    if (
      isLast ||
      inFence ||
      !line.trim() || // blank line already separates the blocks
      line.trimStart().startsWith('|') || // table row
      ALREADY_HARD.test(line)
    ) {
      out.push(raw)
      continue
    }
    out.push(`${line}  ${carriage}`)
  }

  return out.join('\n')
}
