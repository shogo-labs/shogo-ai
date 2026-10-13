// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Markdown helpers for the channel doc: toolbar formatting over a text
 * selection, and task-list items that can be ticked from the rendered view.
 */

export interface Selection {
  start: number
  end: number
}

export type DocFormat = 'h1' | 'h2' | 'h3' | 'bold' | 'italic' | 'strike' | 'code' | 'bullet' | 'numbered' | 'task' | 'quote' | 'link'

export interface FormatResult {
  text: string
  selection: Selection
}

const LINE_PREFIX: Partial<Record<DocFormat, string>> = {
  h1: '# ',
  h2: '## ',
  h3: '### ',
  bullet: '- ',
  numbered: '1. ',
  task: '- [ ] ',
  quote: '> ',
}

const WRAP: Partial<Record<DocFormat, string>> = {
  bold: '**',
  italic: '_',
  strike: '~~',
  code: '`',
}

/** Block prefixes a line can carry; toggling one replaces any other. */
const ANY_PREFIX = /^(#{1,6} |- \[[ xX]\] |[-*+] |\d+\. |> )/

function clamp(sel: Selection, length: number): Selection {
  const start = Math.max(0, Math.min(sel.start, length))
  const end = Math.max(start, Math.min(sel.end, length))
  return { start, end }
}

function toggleLinePrefix(text: string, sel: Selection, prefix: string): FormatResult {
  const lineStart = text.lastIndexOf('\n', sel.start - 1) + 1
  const nextBreak = text.indexOf('\n', sel.end)
  const lineEnd = nextBreak === -1 ? text.length : nextBreak
  const lines = text.slice(lineStart, lineEnd).split('\n')
  const allHave = lines.every((l) => l.startsWith(prefix))
  let delta = 0
  let firstDelta = 0
  const next = lines.map((line, i) => {
    let out: string
    if (allHave) {
      out = line.slice(prefix.length)
    } else {
      const existing = line.match(ANY_PREFIX)?.[0] ?? ''
      out = prefix + line.slice(existing.length)
    }
    if (i === 0) firstDelta = out.length - line.length
    delta += out.length - line.length
    return out
  })
  const replaced = text.slice(0, lineStart) + next.join('\n') + text.slice(lineEnd)
  return {
    text: replaced,
    selection: { start: Math.max(lineStart, sel.start + firstDelta), end: Math.max(lineStart, sel.end + delta) },
  }
}

function toggleWrap(text: string, sel: Selection, marker: string, placeholder: string): FormatResult {
  const before = text.slice(0, sel.start)
  const inner = text.slice(sel.start, sel.end)
  const after = text.slice(sel.end)
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return {
      text: before.slice(0, -marker.length) + inner + after.slice(marker.length),
      selection: { start: sel.start - marker.length, end: sel.end - marker.length },
    }
  }
  const body = inner || placeholder
  return {
    text: before + marker + body + marker + after,
    selection: { start: sel.start + marker.length, end: sel.start + marker.length + body.length },
  }
}

export function applyFormat(text: string, selection: Selection, format: DocFormat): FormatResult {
  const sel = clamp(selection, text.length)
  const prefix = LINE_PREFIX[format]
  if (prefix) return toggleLinePrefix(text, sel, prefix)
  const marker = WRAP[format]
  if (marker) return toggleWrap(text, sel, marker, format === 'code' ? 'code' : 'text')
  // link
  const label = text.slice(sel.start, sel.end) || 'link'
  const inserted = `[${label}](https://)`
  const urlStart = sel.start + label.length + 3
  return {
    text: text.slice(0, sel.start) + inserted + text.slice(sel.end),
    selection: { start: urlStart, end: urlStart + 'https://'.length },
  }
}

/** Insert `snippet` at the selection, replacing any selected text. */
export function insertAt(text: string, selection: Selection, snippet: string): FormatResult {
  const sel = clamp(selection, text.length)
  const pos = sel.start + snippet.length
  return { text: text.slice(0, sel.start) + snippet + text.slice(sel.end), selection: { start: pos, end: pos } }
}

// ─── Task lists ──────────────────────────────────────────────────────────────

export type DocSegment =
  | { type: 'markdown'; text: string }
  | { type: 'task'; line: number; checked: boolean; text: string; indent: number }

const TASK_LINE = /^(\s*)[-*+] \[([ xX])\] (.*)$/
const FENCE = /^\s*(```|~~~)/

/**
 * Split a doc into markdown runs and task items so the view can render tasks
 * as tappable checkboxes. Lines inside fenced code blocks are never tasks.
 */
export function splitTaskSegments(markdown: string): DocSegment[] {
  const out: DocSegment[] = []
  let buffer: string[] = []
  let inFence = false
  const flush = () => {
    if (buffer.length && buffer.some((l) => l.trim())) out.push({ type: 'markdown', text: buffer.join('\n') })
    buffer = []
  }
  markdown.split('\n').forEach((line, index) => {
    if (FENCE.test(line)) inFence = !inFence
    const task = !inFence ? line.match(TASK_LINE) : null
    if (!task) {
      buffer.push(line)
      return
    }
    flush()
    out.push({ type: 'task', line: index, checked: task[2] !== ' ', text: task[3], indent: Math.floor(task[1].length / 2) })
  })
  flush()
  return out
}

/** Flip the checkbox on line `line`; other text is untouched. */
export function toggleTask(markdown: string, line: number): string {
  const lines = markdown.split('\n')
  const current = lines[line]
  const task = current?.match(TASK_LINE)
  if (!task) return markdown
  lines[line] = current.replace(/\[([ xX])\]/, task[2] === ' ' ? '[x]' : '[ ]')
  return lines.join('\n')
}
