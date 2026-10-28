// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Repair pasted rich text that CommonMark reads differently than the person
 * who copied it meant it.
 *
 * Copying out of Docs, Word, Sheets or Outlook gives text that looks like a
 * list or a table on screen but is not markdown at all, so a CommonMark pass
 * mangles it:
 *
 * - `•` is not a bullet marker, so a run of them becomes one lazy paragraph
 *   and every line break collapses into a space.
 * - Rich-text lists indent each item with a tab or four spaces, which
 *   CommonMark reads as an indented *code block*.
 * - Spreadsheet cells are tab separated, and a tab is only whitespace, so a
 *   copied table arrives as a single run-on line.
 * - A plain `+` is a bullet marker in CommonMark, so a typed plus turns into
 *   a bullet dot.
 *
 * Only those four shapes are rewritten, and only outside code spans and
 * fences. This runs for display — the stored message keeps exactly what the
 * sender typed — and it is idempotent, so it is safe on a streaming buffer
 * that is re-normalized as it grows.
 */

/** Bullet glyphs rich text substitutes for a markdown marker. */
const BULLET_GLYPHS = '[\u2022\u2023\u25E6\u25AA\u25AB\u25CF\u25CB\u2219\u00B7]'
/** A bullet line, including one inside a quoted block: `> • item`. */
const BULLET_LINE_RE = new RegExp(`^([ \\t]*(?:>[ \\t]*)*)${BULLET_GLYPHS}[ \\t]*`)
/** A list item: `-`, `*`, `+` or `1.` / `1)` plus a space, or the marker alone. */
const LIST_ITEM_RE = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/
/** A `+` a person typed as a plus sign, not as a bullet marker. */
const TYPED_PLUS_RE = /^[ \t]{0,3}\+[ \t]/
/** A line that carries at least one tab, and so may be a spreadsheet row. */
const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
const INLINE_CODE_RE = /`[^`\n]+`/g

const TAB = '\t'
const TAB_WIDTH = 4

function mask(source: string, pattern: RegExp, bucket: string[], tag: string): string {
  return source.replace(pattern, (match) => {
    bucket.push(match)
    return `\u0000${tag}${bucket.length - 1}\u0000`
  })
}

function unmask(source: string, bucket: string[], tag: string): string {
  return source.replace(
    new RegExp(`\u0000${tag}(\\d+)\u0000`, 'g'),
    (_, index: string) => bucket[Number(index)] ?? '',
  )
}

/** Cells of a spreadsheet row, or null when the line is not one. */
function tableCells(line: string): string[] | null {
  if (!line.includes(TAB)) return null
  // `1. one<TAB>2. two` is a numbered list whose items are tab separated, not
  // a table with a `1. one` column.
  if (LIST_ITEM_RE.test(line.replace(/^[ \t]+/, ''))) return null
  const cells = line
    .replace(/[ \t]+$/, '')
    .split(TAB)
    .map((cell) => cell.trim())
  // An empty leading cell means the line is indented, not tabular: that is
  // the `\t1. item` shape, which the list rules below own.
  if (cells.length < 2 || cells.some((cell) => cell.length === 0)) return null
  return cells
}

function tableRow(cells: string[]): string {
  return `| ${cells.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`
}

function expandPrefix(line: string): string {
  const prefix = line.match(/^[ \t]*/)?.[0] ?? ''
  return prefix.replace(/\t/g, ' '.repeat(TAB_WIDTH)) + line.slice(prefix.length)
}

function leadingWidth(line: string): number {
  return expandPrefix(line).match(/^ */)?.[0].length ?? 0
}

function isListItemLine(line: string): boolean {
  return LIST_ITEM_RE.test(line.replace(/^[ \t]+/, ''))
}

/**
 * Turn a run of tab-separated lines into a GFM table. Rows must agree on
 * their column count — a ragged block is left alone rather than guessed at.
 */
function convertTableBlocks(lines: string[]): string[] {
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const first = tableCells(lines[index])
    if (!first) {
      out.push(lines[index])
      index += 1
      continue
    }
    let end = index + 1
    while (end < lines.length) {
      const next = tableCells(lines[end])
      if (!next || next.length !== first.length) break
      end += 1
    }
    if (end - index < 2) {
      out.push(lines[index])
      index += 1
      continue
    }
    const rows = lines.slice(index, end).map((line) => tableCells(line) as string[])
    out.push(tableRow(rows[0]))
    out.push(`| ${rows[0].map(() => '---').join(' | ')} |`)
    for (const row of rows.slice(1)) out.push(tableRow(row))
    index = end
  }
  return out
}

/**
 * Trim the indent a rich-text copy put in front of a whole list, so the list
 * parses as a list instead of an indented code block. Only a run that starts
 * at four columns or beyond is touched — what is left of it is already a
 * list, and a run at column zero is what someone typed by hand. Tabs in a
 * run's indent are expanded to columns so the widths can be compared, which
 * cannot change the nesting of the run.
 */
function stripListIndents(lines: string[]): void {
  let index = 0
  while (index < lines.length) {
    if (!isListItemLine(lines[index])) {
      index += 1
      continue
    }
    let end = index
    while (end < lines.length && isListItemLine(lines[end])) end += 1
    const run = lines.slice(index, end).map(expandPrefix)
    const trim = Math.min(...run.map(leadingWidth))
    const strip = trim >= TAB_WIDTH ? trim : 0
    for (let i = 0; i < run.length; i += 1) lines[index + i] = run[i].slice(strip)
    index = end
  }
}

/**
 * Escape a lone `+` line so it renders as a plus sign. Two or more `+` lines
 * is a list the sender meant to write, and stays a list.
 */
function escapeLoneTypedPlus(lines: string[]): void {
  const typed = lines.filter((line) => TYPED_PLUS_RE.test(line))
  if (typed.length !== 1) return
  const at = lines.indexOf(typed[0])
  lines[at] = lines[at].replace(/^([ \t]{0,3})\+/, '$1\\+')
}

export function normalizeRichTextPaste(text: string): string {
  if (!text) return text
  // Fences and inline code are protected. An indented block is deliberately
  // not: `    1. item` is exactly the shape this function exists to rescue.
  const fences: string[] = []
  const code: string[] = []
  let source = mask(text.replace(/\r\n?/g, '\n'), FENCE_RE, fences, 'FENCE')
  source = mask(source, INLINE_CODE_RE, code, 'CODE')

  // Bullet glyphs become real markers first, so a `•<TAB>item` row is read as
  // a list item and never mistaken for a spreadsheet row.
  const lines = source
    .split('\n')
    .map((line) => line.replace(BULLET_LINE_RE, '$1- '))
  const blocks = convertTableBlocks(lines)
  stripListIndents(blocks)
  escapeLoneTypedPlus(blocks)

  return unmask(unmask(blocks.join('\n'), code, 'CODE'), fences, 'FENCE')
}
