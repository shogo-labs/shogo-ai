// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Layout lint pass for read_lints (SHO-371 part D).
 *
 * Shogo used to fix narrow previews by injecting `!important` CSS into every
 * canvas (`canvas-bridge.js`): every `grid-cols-2…6` collapsed to one column,
 * `.truncate` was un-truncated, `[role=tablist]` was rewritten and `flex
 * h-screen` shells were turned into columns. Agents then fought CSS they never
 * wrote, and a deliberate 2-up stat row rendered wrong at 390px.
 *
 * That block is gone. The replacement is a warning at write time, on the code
 * the agent actually authored:
 *
 *   1. `grid-cols-N` (N >= 3) with no responsive `grid-cols` sibling — a
 *      desktop-only grid that will overflow a 390px canvas.
 *   2. A fixed-width sidebar (`w-48`…`w-80`, `w-[<n>px]`) in a file whose
 *      viewport shell (`flex h-screen` / `h-dvh`) has no `flex-col` +
 *      `md:flex-row` — the classic "sidebar eats the phone" layout.
 *
 * `grid-cols-2` is deliberately NOT flagged: a 2-up stat row or a 2-tab
 * `TabsList` at 390px is often intentional, and flagging it would bring back
 * exactly the noise this replaces.
 *
 * These are warnings, never errors — they never make `read_lints` fail.
 */

export interface LayoutWarning {
  /** 1-based line number in the file. */
  line: number
  message: string
}

/** Only JSX/TSX carries `className`; `.ts`/`.js`/`.py` are skipped. */
const JSX_EXTENSION_RE = /\.(tsx|jsx)$/

/** `grid-cols-3` … `grid-cols-12`, unprefixed only. */
const BARE_GRID_COLS_RE = /^grid-cols-(\d+)$/

/** Any responsive grid-cols sibling: `sm:grid-cols-2`, `lg:grid-cols-4`, … */
const RESPONSIVE_GRID_COLS_RE = /^(?:sm|md|lg|xl|2xl):grid-cols-\d+$/

/** Tailwind's fixed sidebar widths, plus an arbitrary pixel width. */
const FIXED_SIDEBAR_WIDTH_RE = /^w-(?:48|52|56|60|64|72|80)$|^w-\[\d+px\]$/

/** A full-viewport flex shell. */
const VIEWPORT_SHELL_HEIGHT_RE = /^(?:min-)?h-(?:screen|dvh)$/

/** A responsive escape hatch for a sidebar layout. */
const RESPONSIVE_ROW_RE = /^(?:sm|md|lg|xl|2xl):flex-row$/

/** Every quoted string literal on a line — covers `className="…"` and `cn('…', …)`. */
const STRING_LITERAL_RE = /"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`\\\n]*)`/g

interface ClassLine {
  line: number
  tokens: string[]
}

/**
 * Class tokens per line, for lines that mention `className`.
 *
 * Line-based on purpose: a JSX attribute can span lines, but the class list
 * almost always sits on one, and a warning that points at the right line is
 * worth more than a parser this pass does not need.
 */
function classLines(content: string): ClassLine[] {
  const out: ClassLine[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (!text.includes('className')) continue
    const tokens: string[] = []
    STRING_LITERAL_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = STRING_LITERAL_RE.exec(text)) !== null) {
      const value = match[1] ?? match[2] ?? match[3] ?? ''
      for (const token of value.split(/\s+/)) {
        if (token) tokens.push(token)
      }
    }
    if (tokens.length > 0) out.push({ line: i + 1, tokens })
  }
  return out
}

/**
 * Warnings for one file. Returns `[]` for anything that is not JSX/TSX.
 */
export function scanFileForLayoutWarnings(relPath: string, content: string): LayoutWarning[] {
  if (!JSX_EXTENSION_RE.test(relPath)) return []

  const lines = classLines(content)
  if (lines.length === 0) return []

  const warnings: LayoutWarning[] = []

  for (const { line, tokens } of lines) {
    const bareGrid = tokens
      .map((t) => BARE_GRID_COLS_RE.exec(t))
      .find((m): m is RegExpExecArray => m !== null && Number(m[1]) >= 3)
    if (bareGrid && !tokens.some((t) => RESPONSIVE_GRID_COLS_RE.test(t))) {
      warnings.push({
        line,
        message:
          `\`${bareGrid[0]}\` has no responsive sibling, so it stays ${bareGrid[1]} columns at 390px and overflows. ` +
          `Add a breakpoint (e.g. \`grid-cols-1 sm:${bareGrid[0]}\`) or use \`grid-cols-2\` if 2-up is intended.`,
      })
    }
  }

  // Sidebar check: the shell and the sidebar can be on different lines, so the
  // shell is resolved once for the file and the warning is reported where the
  // fixed width is.
  const shell = lines.find(({ tokens }) => {
    if (!tokens.includes('flex')) return false
    if (!tokens.some((t) => VIEWPORT_SHELL_HEIGHT_RE.test(t))) return false
    return !(tokens.includes('flex-col') && tokens.some((t) => RESPONSIVE_ROW_RE.test(t)))
  })
  if (shell) {
    for (const { line, tokens } of lines) {
      const width = tokens.find((t) => FIXED_SIDEBAR_WIDTH_RE.test(t))
      if (!width) continue
      warnings.push({
        line,
        message:
          `\`${width}\` is a fixed-width sidebar inside a \`flex h-screen\` shell with no \`flex-col md:flex-row\` (line ${shell.line}). ` +
          `At 390px it takes the whole canvas. Stack the panes: \`flex flex-col md:flex-row\` and \`w-full md:${width}\`.`,
      })
    }
  }

  return warnings
}
