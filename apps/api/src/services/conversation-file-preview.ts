// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The small, display-ready preview of a chat attachment, shown by the message
 * card under its file header (`FileAttachmentCard` → `AttachmentPreviewBody`).
 *
 * Deliberately not the same thing as `ConversationAttachment.extractedText`:
 * that holds up to 100 KB of text for search and is never sent to a client.
 * This is capped at ~2 KB because it rides inside every message payload. Both
 * are built in one pass over the same bytes, so no file is parsed twice.
 *
 * Everything here is pure. The work that needs I/O — unzipping an Office file,
 * opening a PDF — lives in `conversation-file-text.ts`, which hands finished
 * pieces to these builders.
 */

/** Bump when the shape below changes incompatibly; readers drop other versions. */
export const PREVIEW_VERSION = 1

/** Prose/code lines carried in a preview. The client shows fewer. */
export const MAX_PROSE_LINES = 8
export const MAX_CODE_LINES = 10
export const MAX_LINE_CHARS = 160
/** Slide 1 bullets. */
export const MAX_BULLETS = 6
export const MAX_TITLE_CHARS = 120
/** Table grid: an impression of the sheet, not the sheet. */
export const MAX_TABLE_ROWS = 6
export const MAX_TABLE_COLS = 5
export const MAX_CELL_CHARS = 40
/** Hard ceiling for the whole object, JSON-encoded. */
export const MAX_PREVIEW_CHARS = 2_000

export type TextPreview = { v: typeof PREVIEW_VERSION; kind: 'text'; lines: string[]; pages?: number }
export type CodePreview = { v: typeof PREVIEW_VERSION; kind: 'code'; lines: string[]; lang?: string }
export type SlidesPreview = { v: typeof PREVIEW_VERSION; kind: 'slides'; title: string; bullets: string[]; count: number }
export type TablePreview = {
  v: typeof PREVIEW_VERSION
  kind: 'table'
  rows: string[][]
  sheet?: string
  truncated: boolean
}

export type AttachmentPreview = TextPreview | CodePreview | SlidesPreview | TablePreview

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

function clean(value: string): string {
  return value.replace(CONTROL, '').replace(/\s+/g, ' ').trim()
}

function clamp(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * Lines for prose. Blank runs are dropped so a preview shows content rather
 * than the gaps between paragraphs.
 */
export function proseLines(text: string, max = MAX_PROSE_LINES): string[] {
  return text
    .split('\n')
    .map((line) => clean(line))
    .filter(Boolean)
    .slice(0, max)
    .map((line) => clamp(line, MAX_LINE_CHARS))
}

/**
 * Lines for source code. Layout is preserved (indentation is the point), but
 * trailing whitespace goes. Callers pass raw decoded text, not the tidied
 * search text, because tidy collapses the indentation away.
 */
export function codeLines(text: string, max = MAX_CODE_LINES): string[] {
  return text
    .split('\n')
    .slice(0, max)
    .map((line) => line.replace(CONTROL, '').replace(/\s+$/, '').slice(0, MAX_LINE_CHARS))
}

export function buildTextPreview(text: string, opts: { pages?: number } = {}): TextPreview | null {
  const lines = proseLines(text)
  if (!lines.length) return null
  const preview: TextPreview = { v: PREVIEW_VERSION, kind: 'text', lines }
  if (opts.pages && opts.pages > 0) preview.pages = opts.pages
  return preview
}

export function buildCodePreview(rawText: string, opts: { lang?: string } = {}): CodePreview | null {
  const lines = codeLines(rawText)
  while (lines.length && !lines[0].trim()) lines.shift()
  if (!lines.some((line) => line.trim())) return null
  const preview: CodePreview = { v: PREVIEW_VERSION, kind: 'code', lines }
  if (opts.lang) preview.lang = opts.lang
  return preview
}

/**
 * Slide 1 of a deck: its first line becomes the title, the next few become
 * bullets, and `count` is the deck's slide count so the card can say
 * "Slide 1 of 12".
 */
export function buildSlidesPreview(slideTexts: string[], opts: { title?: string } = {}): SlidesPreview | null {
  const count = slideTexts.length
  if (!count) return null
  const first = proseLines(slideTexts[0], MAX_BULLETS + 1)
  const deckTitle = clean(opts.title ?? '')
  const title = first.length ? first[0] : deckTitle
  const bullets = (first.length ? first.slice(1) : []).slice(0, MAX_BULLETS)
  if (!title && !bullets.length) return null
  return {
    v: PREVIEW_VERSION,
    kind: 'slides',
    title: clamp(title, MAX_TITLE_CHARS),
    bullets: bullets.map((b) => clamp(b, MAX_LINE_CHARS)),
    count,
  }
}

export function buildTablePreview(
  rows: string[][],
  opts: { sheet?: string; truncated?: boolean } = {},
): TablePreview | null {
  const shaped = rows
    .slice(0, MAX_TABLE_ROWS)
    .map((row) => row.slice(0, MAX_TABLE_COLS).map((cell) => clamp(cell, MAX_CELL_CHARS)))
    .filter((row) => row.some((cell) => cell.length))
  if (!shaped.length) return null
  const overflowed =
    opts.truncated || rows.length > MAX_TABLE_ROWS || rows.some((row) => row.length > MAX_TABLE_COLS)
  const preview: TablePreview = { v: PREVIEW_VERSION, kind: 'table', rows: shaped, truncated: !!overflowed }
  if (opts.sheet) preview.sheet = clamp(opts.sheet, MAX_CELL_CHARS)
  return preview
}

/**
 * Drop trailing content until the encoded preview fits the ceiling. Reports
 * `true` when something was dropped so callers can assert on it.
 */
export function fitPreview(preview: AttachmentPreview | null): { preview: AttachmentPreview | null; dropped: boolean } {
  if (!preview) return { preview: null, dropped: false }
  const size = (candidate: AttachmentPreview) => JSON.stringify(candidate).length
  if (size(preview) <= MAX_PREVIEW_CHARS) return { preview, dropped: false }

  const shrunken: AttachmentPreview = JSON.parse(JSON.stringify(preview))
  let dropped = false
  while (size(shrunken) > MAX_PREVIEW_CHARS) {
    const list =
      shrunken.kind === 'text' || shrunken.kind === 'code'
        ? shrunken.lines
        : shrunken.kind === 'slides'
          ? shrunken.bullets
          : shrunken.rows
    if (list.length > 1) {
      list.pop()
      if (shrunken.kind === 'table') shrunken.truncated = true
      dropped = true
      continue
    }
    if (shrunken.kind === 'slides' && shrunken.title) { shrunken.title = ''; dropped = true; continue }
    if (shrunken.kind === 'code' && shrunken.lang) { delete shrunken.lang; dropped = true; continue }
    if (shrunken.kind === 'text' && shrunken.pages) { delete shrunken.pages; dropped = true; continue }
    return { preview: null, dropped: true }
  }
  return { preview: shrunken, dropped }
}

const isStringArray = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) && value.length <= max && value.every((v) => typeof v === 'string' && v.length <= MAX_LINE_CHARS)

/**
 * Read-side guard. `previewData` also holds rows written by older builds and by
 * hand, and it is handed straight to a renderer, so anything that is not
 * exactly the shape above is dropped rather than trusted.
 */
export function publicPreview(value: unknown): AttachmentPreview | null {
  let raw: unknown = value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = raw as Record<string, unknown>
  if (candidate.v !== PREVIEW_VERSION) return null
  if (JSON.stringify(candidate).length > MAX_PREVIEW_CHARS) return null
  switch (candidate.kind) {
    case 'text': {
      if (!isStringArray(candidate.lines, MAX_PROSE_LINES) || !candidate.lines.length) return null
      const preview: TextPreview = { v: PREVIEW_VERSION, kind: 'text', lines: candidate.lines }
      if (typeof candidate.pages === 'number' && Number.isFinite(candidate.pages) && candidate.pages > 0) {
        preview.pages = Math.floor(candidate.pages)
      }
      return preview
    }
    case 'code': {
      if (!isStringArray(candidate.lines, MAX_CODE_LINES) || !candidate.lines.length) return null
      const preview: CodePreview = { v: PREVIEW_VERSION, kind: 'code', lines: candidate.lines }
      if (typeof candidate.lang === 'string' && candidate.lang) preview.lang = candidate.lang.slice(0, 20)
      return preview
    }
    case 'slides': {
      const title = typeof candidate.title === 'string' ? candidate.title : ''
      if (title.length > MAX_TITLE_CHARS) return null
      if (!isStringArray(candidate.bullets, MAX_BULLETS)) return null
      if (!title && !candidate.bullets.length) return null
      if (typeof candidate.count !== 'number' || !Number.isFinite(candidate.count) || candidate.count < 1) return null
      return {
        v: PREVIEW_VERSION,
        kind: 'slides',
        title,
        bullets: candidate.bullets,
        count: Math.floor(candidate.count),
      }
    }
    case 'table': {
      const rows = candidate.rows
      if (!Array.isArray(rows) || rows.length > MAX_TABLE_ROWS || !rows.length) return null
      if (!rows.every((row) => isStringArray(row, MAX_TABLE_COLS))) return null
      const preview: TablePreview = {
        v: PREVIEW_VERSION,
        kind: 'table',
        rows: rows as string[][],
        truncated: candidate.truncated === true,
      }
      if (typeof candidate.sheet === 'string' && candidate.sheet) preview.sheet = candidate.sheet.slice(0, MAX_CELL_CHARS)
      return preview
    }
    default:
      return null
  }
}

// ─── Delimited text (CSV / TSV) ──────────────────────────────────────────────

/**
 * Split delimited text into a grid, honouring quoted fields (including
 * embedded delimiters, newlines and "" escapes). Deliberately not a full RFC
 * 4180 parser: it reads a bounded prefix for display only, never for import.
 */
export function parseDelimited(
  text: string,
  delimiter: string,
  opts: { maxRows?: number; maxCols?: number } = {},
): { rows: string[][]; truncated: boolean } {
  const maxRows = opts.maxRows ?? MAX_TABLE_ROWS
  const maxCols = opts.maxCols ?? MAX_TABLE_COLS
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let truncated = false

  for (let i = 0; i < text.length && rows.length <= maxRows; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += char
      continue
    }
    if (char === '"' && !field) { quoted = true; continue }
    if (char === delimiter) { row.push(field); field = ''; continue }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.length > maxCols) truncated = true
      rows.push(row)
      row = []
      continue
    }
    field += char
  }
  if (field || row.length) {
    row.push(field)
    if (row.length > maxCols) truncated = true
    rows.push(row)
  }
  if (rows.length > maxRows) truncated = true
  return { rows: rows.slice(0, maxRows), truncated }
}

// ─── Spreadsheet XML ─────────────────────────────────────────────────────────

export function decodeXmlEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return named[entity.toLowerCase()] ?? match
  })
}

function plainXml(fragment: string): string {
  return decodeXmlEntities(fragment.replace(/<[^>]+>/g, ''))
}

/** The `<si>` entries of `xl/sharedStrings.xml`, in index order. */
export function parseSharedStrings(xml: string): string[] {
  return Array.from(xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g), (match) => plainXml(match[1]))
}

function columnIndex(reference: string | undefined, fallback: number): number {
  const letters = /^([A-Z]+)/.exec(reference ?? '')?.[1]
  if (!letters) return fallback
  let index = 0
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64)
  return index - 1
}

/**
 * First rows of a worksheet as a grid, resolving shared-string and inline
 * cells. Reads only what the preview shows, so a 100k-row sheet costs the same
 * as a small one.
 */
export function parseSheetGrid(
  worksheetXml: string,
  sharedStrings: string[],
  opts: { maxRows?: number; maxCols?: number } = {},
): { rows: string[][]; truncated: boolean } {
  const maxRows = opts.maxRows ?? MAX_TABLE_ROWS
  const maxCols = opts.maxCols ?? MAX_TABLE_COLS
  const rows: string[][] = []
  let truncated = false

  for (const rowMatch of worksheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= maxRows) { truncated = true; break }
    const cells: string[] = []
    let auto = 0
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? ''
      const body = cellMatch[2] ?? ''
      const index = columnIndex(/\br="([A-Z]+\d+)"/.exec(attrs)?.[1], auto)
      auto = index + 1
      if (index >= maxCols) { truncated = true; continue }
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? ''
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let text = ''
      if (type === 's') {
        const position = Number(value)
        text = Number.isInteger(position) ? sharedStrings[position] ?? '' : ''
      } else if (type === 'inlineStr') {
        text = plainXml(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '')
      } else if (type === 'str') {
        text = plainXml(value ?? '')
      } else {
        text = value ?? ''
      }
      while (cells.length < index) cells.push('')
      cells[index] = clean(text)
    }
    while (cells.length && cells[cells.length - 1] === '') cells.pop()
    rows.push(cells)
  }
  return { rows, truncated }
}

/** The first worksheet's display name from `xl/workbook.xml`. */
export function parseSheetName(workbookXml: string): string | undefined {
  const name = /\bsheet\b[^>]*\bname="([^"]*)"/.exec(workbookXml)?.[1]
  return name ? clean(decodeXmlEntities(name)) : undefined
}
