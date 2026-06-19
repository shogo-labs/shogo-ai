// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tool Discipline Evals
 *
 * Reproduces the two highest-volume production tool-call failures observed for
 * the Hoshi (mimo-v2.5) model (see HOSHI_CODING_FINDINGS.md):
 *
 *   A. Malformed `read_file` arguments — 818/858 read_file errors in a 7-day
 *      window were "offset: must be number / must be array / must match a schema
 *      in anyOf", i.e. the model passed a string/object where a number (or array
 *      of numbers) was required.
 *
 *   B. `edit_file` read-before-edit violations — 359 "File has not been read
 *      yet" + 52 stale-read errors, plus a handful of "old_string not found"
 *      (hallucinated file content).
 *
 * These tasks deliberately push the agent toward `offset`/`limit` reads and
 * toward editing existing files, then score whether the tool calls are
 * well-formed and error-free.
 *
 * Track: --track tool-discipline
 */

import type { AgentEval, EvalResult, ToolCallRecord } from './types'
import { usedTool } from './eval-helpers'

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function readFileCalls(r: EvalResult): ToolCallRecord[] {
  return r.toolCalls.filter(t => t.name === 'read_file')
}

/** A read_file `offset`/`limit` value is valid only if it's a number or an array of numbers. */
function isWellFormedRange(value: unknown): boolean {
  if (value === undefined || value === null) return true // optional
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(v => typeof v === 'number' && Number.isFinite(v))
  return false // strings, objects, booleans, etc. are all malformed
}

/** True if every read_file call passed well-formed `offset`/`limit` arguments. */
function readFileArgsWellFormed(r: EvalResult): boolean {
  return readFileCalls(r).every(t => {
    const input = t.input as Record<string, unknown>
    return isWellFormedRange(input.offset) && isWellFormedRange(input.limit)
  })
}

/** True if the agent used `offset` (or `limit`) on at least one read_file call. */
function usedRangedRead(r: EvalResult): boolean {
  return readFileCalls(r).some(t => {
    const input = t.input as Record<string, unknown>
    return input.offset !== undefined || input.limit !== undefined
  })
}

/** True if no read_file call errored (malformed args surface as tool errors). */
function noReadFileErrors(r: EvalResult): boolean {
  return !readFileCalls(r).some(t => t.error === true)
}

function editFileCalls(r: EvalResult): ToolCallRecord[] {
  return r.toolCalls.filter(t => t.name === 'edit_file')
}

function pathOf(t: ToolCallRecord): string {
  return String((t.input as Record<string, unknown>).path ?? '')
}

/** An edit_file that creates a new file (empty old_string) is exempt from read-before-edit. */
function isCreateEdit(t: ToolCallRecord): boolean {
  const input = t.input as Record<string, unknown>
  const oldStr = input.old_string ?? input.oldString
  return oldStr === '' || oldStr === undefined
}

/**
 * True if every edit_file targeting an existing file was preceded by a read_file
 * of that same path earlier in the run. Matches on exact path or suffix so we
 * tolerate absolute-vs-relative path forms.
 */
function readBeforeEachEdit(r: EvalResult): boolean {
  const readPaths: string[] = []
  for (const t of r.toolCalls) {
    if (t.name === 'read_file') {
      const p = pathOf(t)
      if (p) readPaths.push(p)
    } else if (t.name === 'edit_file' && !isCreateEdit(t)) {
      const p = pathOf(t)
      if (!p) continue
      const seen = readPaths.some(rp => rp === p || rp.endsWith(p) || p.endsWith(rp))
      if (!seen) return false
    }
  }
  return true
}

/** True if no edit_file call errored (covers "not read yet" + "old_string not found"). */
function noEditErrors(r: EvalResult): boolean {
  return !editFileCalls(r).some(t => t.error === true)
}

/** True if the agent edited a file whose path includes `substring`. */
function editedPath(r: EvalResult, substring: string): boolean {
  return editFileCalls(r).some(t => pathOf(t).includes(substring))
}

function usedEditNotWrite(r: EvalResult, substring: string): boolean {
  const edited = editFileCalls(r).some(t => pathOf(t).includes(substring))
  const wrote = r.toolCalls.some(t => t.name === 'write_file' && pathOf(t).includes(substring))
  return edited && !wrote
}

// ---------------------------------------------------------------------------
// Workspace fixtures
// ---------------------------------------------------------------------------

// A deliberately long file so reading a specific section with offset/limit is
// the natural, instructed approach.
const PRICING_LIB = `// Billing + pricing utilities. Large on purpose.
export interface LineItem {
  sku: string
  quantity: number
  unitPriceCents: number
}

export interface Discount {
  code: string
  percentOff: number
}

export const TAX_RATES: Record<string, number> = {
  CA: 0.0725,
  NY: 0.08875,
  TX: 0.0625,
  WA: 0.065,
  FL: 0.06,
}

export function subtotalCents(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0)
}

export function applyDiscount(subtotal: number, discount: Discount | null): number {
  if (!discount) return subtotal
  const off = Math.round(subtotal * (discount.percentOff / 100))
  return Math.max(0, subtotal - off)
}

export function taxForState(amountCents: number, state: string): number {
  const rate = TAX_RATES[state] ?? 0
  return Math.round(amountCents * rate)
}

export function formatCents(cents: number): string {
  return '$' + (cents / 100).toFixed(2)
}

export function roundToCents(value: number): number {
  return Math.round(value)
}

export function isValidSku(sku: string): boolean {
  return /^[A-Z]{3}-\\d{4}$/.test(sku)
}

export function dedupeItems(items: LineItem[]): LineItem[] {
  const map = new Map<string, LineItem>()
  for (const item of items) {
    const existing = map.get(item.sku)
    if (existing) {
      existing.quantity += item.quantity
    } else {
      map.set(item.sku, { ...item })
    }
  }
  return Array.from(map.values())
}

export function cheapestItem(items: LineItem[]): LineItem | null {
  if (items.length === 0) return null
  return items.reduce((min, item) => (item.unitPriceCents < min.unitPriceCents ? item : min))
}

export function mostExpensiveItem(items: LineItem[]): LineItem | null {
  if (items.length === 0) return null
  return items.reduce((max, item) => (item.unitPriceCents > max.unitPriceCents ? item : max))
}

export interface InvoiceInput {
  items: LineItem[]
  discount: Discount | null
  state: string
  shippingCents: number
}

export interface InvoiceTotal {
  subtotalCents: number
  discountedCents: number
  taxCents: number
  shippingCents: number
  totalCents: number
}

// computeInvoiceTotal is the main entry point — it lives near the very bottom of
// this file on purpose, so reading it requires an offset/limit ranged read.
export function computeInvoiceTotal(input: InvoiceInput): InvoiceTotal {
  const sub = subtotalCents(input.items)
  const discounted = applyDiscount(sub, input.discount)
  const tax = taxForState(discounted, input.state)
  const total = discounted + tax + input.shippingCents
  return {
    subtotalCents: sub,
    discountedCents: discounted,
    taxCents: tax,
    shippingCents: input.shippingCents,
    totalCents: total,
  }
}
`

const TS_UTIL_CODEBASE: Record<string, string> = {
  'src/lib/strings.ts': `export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input
  return input.slice(0, max) + '...'
}

export function titleCase(input: string): string {
  return input.replace(/\\w\\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
}
`,
  'src/lib/dates.ts': `export function daysBetween(a: Date, b: Date): number {
  const ms = Math.abs(b.getTime() - a.getTime())
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}

export function isWeekend(d: Date): boolean {
  const day = d.getDay()
  return day === 0 || day === 6
}

export function formatISODate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
`,
  'src/lib/numbers.ts': `export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

export function average(values: number[]): number {
  if (values.length === 0) return 0
  return sum(values) / values.length
}
`,
}

// ---------------------------------------------------------------------------
// A. read_file argument-schema adherence (offset/limit must be number|number[])
// ---------------------------------------------------------------------------

const READ_ARG_EVALS: AgentEval[] = [
  {
    id: 'tool-discipline-ranged-read-target',
    name: 'Read a specific function via well-formed offset/limit',
    category: 'tool-usage',
    level: 2,
    input: [
      'The file `src/lib/pricing.ts` is long. The `computeInvoiceTotal` function is near the very bottom.',
      'Read ONLY the section around `computeInvoiceTotal` using the read_file `offset` and `limit` parameters',
      '(do not read the whole file), then explain in plain English what it computes and in what order.',
    ].join('\n'),
    workspaceFiles: { 'src/lib/pricing.ts': PRICING_LIB },
    validationCriteria: [
      {
        id: 'used-read-file',
        description: 'Agent used read_file',
        points: 2,
        phase: 'execution',
        validate: (r) => usedTool(r, 'read_file'),
      },
      {
        id: 'used-ranged-read',
        description: 'Agent used offset/limit to read a section (not the whole file)',
        points: 3,
        phase: 'execution',
        validate: (r) => usedRangedRead(r),
      },
      {
        id: 'offset-args-well-formed',
        description: 'Every read_file offset/limit is a number or array of numbers',
        points: 5,
        phase: 'execution',
        validate: (r) => readFileArgsWellFormed(r),
      },
      {
        id: 'no-read-errors',
        description: 'No read_file call errored (no malformed-argument rejections)',
        points: 3,
        phase: 'execution',
        validate: (r) => noReadFileErrors(r),
      },
      {
        id: 'explained-function',
        description: 'Response describes the total computation (subtotal/discount/tax)',
        points: 2,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('tax') && (text.includes('discount') || text.includes('subtotal'))
        },
      },
    ],
    antiPatterns: [
      'Passed a string or object as the read_file offset',
      'read_file rejected for malformed arguments',
    ],
    maxScore: 15,
  },

  {
    id: 'tool-discipline-paginated-scan',
    name: 'Paginate a large file with repeated offset reads',
    category: 'tool-usage',
    level: 3,
    input: [
      'Read `src/lib/pricing.ts` in two or three chunks using the read_file `offset` and `limit` parameters',
      '(do not request the entire file in one call), then list every exported function name you find.',
    ].join('\n'),
    workspaceFiles: { 'src/lib/pricing.ts': PRICING_LIB },
    validationCriteria: [
      {
        id: 'multiple-ranged-reads',
        description: 'Agent made at least two read_file calls using offset/limit',
        points: 4,
        phase: 'execution',
        validate: (r) => readFileCalls(r).filter(t => {
          const input = t.input as Record<string, unknown>
          return input.offset !== undefined || input.limit !== undefined
        }).length >= 2,
      },
      {
        id: 'offset-args-well-formed',
        description: 'Every read_file offset/limit is a number or array of numbers',
        points: 5,
        phase: 'execution',
        validate: (r) => readFileArgsWellFormed(r),
      },
      {
        id: 'no-read-errors',
        description: 'No read_file call errored',
        points: 3,
        phase: 'execution',
        validate: (r) => noReadFileErrors(r),
      },
      {
        id: 'listed-entry-point',
        description: 'Response lists computeInvoiceTotal',
        points: 3,
        phase: 'execution',
        validate: (r) => r.responseText.toLowerCase().includes('computeinvoicetotal'),
      },
    ],
    antiPatterns: [
      'Passed a string or object as the read_file offset',
    ],
    maxScore: 15,
  },
]

// ---------------------------------------------------------------------------
// B. edit_file read-before-edit + error-free edits
// ---------------------------------------------------------------------------

const EDIT_DISCIPLINE_EVALS: AgentEval[] = [
  {
    id: 'tool-discipline-read-before-edit',
    name: 'Edit an existing util only after reading it',
    category: 'edit-file',
    level: 2,
    input: [
      'In `src/lib/strings.ts`, the `truncate` function appends "..." after slicing.',
      'Change it to append the single-character ellipsis "\u2026" instead, keeping everything else the same.',
    ].join('\n'),
    workspaceFiles: TS_UTIL_CODEBASE,
    validationCriteria: [
      {
        id: 'read-the-target',
        description: 'Agent read src/lib/strings.ts',
        points: 3,
        phase: 'intention',
        validate: (r) => r.toolCalls.some(t => t.name === 'read_file' && pathOf(t).includes('strings.ts')),
      },
      {
        id: 'read-before-edit',
        description: 'Every edit was preceded by a read of that file',
        points: 5,
        phase: 'execution',
        validate: (r) => readBeforeEachEdit(r),
      },
      {
        id: 'no-edit-errors',
        description: 'No edit_file call errored (no "not read yet" / "old_string not found")',
        points: 4,
        phase: 'execution',
        validate: (r) => noEditErrors(r) && editFileCalls(r).length > 0,
      },
      {
        id: 'edited-correct-file',
        description: 'Agent edited strings.ts with edit_file (not a full rewrite)',
        points: 3,
        phase: 'execution',
        validate: (r) => usedEditNotWrite(r, 'strings.ts'),
      },
    ],
    antiPatterns: [
      'Called edit_file before reading the file',
      'edit_file failed because old_string was not found',
    ],
    maxScore: 15,
  },

  {
    id: 'tool-discipline-exact-old-string',
    name: 'edit_file old_string must match real file content',
    category: 'edit-file',
    level: 3,
    input: [
      'In `src/lib/numbers.ts`, the `average` function returns 0 for an empty array.',
      'Change it to return `NaN` for an empty array instead. Make the change with edit_file.',
    ].join('\n'),
    workspaceFiles: TS_UTIL_CODEBASE,
    validationCriteria: [
      {
        id: 'read-before-edit',
        description: 'Agent read numbers.ts before editing',
        points: 4,
        phase: 'execution',
        validate: (r) => readBeforeEachEdit(r),
      },
      {
        id: 'edit-succeeded',
        description: 'edit_file was called and did not error (old_string matched real content)',
        points: 6,
        phase: 'execution',
        validate: (r) => editedPath(r, 'numbers.ts') && noEditErrors(r),
      },
      {
        id: 'used-edit-not-write',
        description: 'Agent used edit_file, not a write_file rewrite',
        points: 3,
        phase: 'execution',
        validate: (r) => usedEditNotWrite(r, 'numbers.ts'),
      },
    ],
    antiPatterns: [
      'edit_file failed because old_string did not match the file',
    ],
    maxScore: 13,
  },

  {
    id: 'tool-discipline-sequential-multi-file-edits',
    name: 'Read each file before editing it across multiple files',
    category: 'edit-file',
    level: 3,
    input: [
      'Make two small changes:',
      '1. In `src/lib/strings.ts`, make `slugify` also collapse underscores to hyphens.',
      '2. In `src/lib/dates.ts`, make `isWeekend` treat Friday (day 5) as part of the weekend too.',
      'Read each file before you edit it.',
    ].join('\n'),
    workspaceFiles: TS_UTIL_CODEBASE,
    validationCriteria: [
      {
        id: 'read-before-each-edit',
        description: 'Every edit was preceded by a read of that specific file',
        points: 6,
        phase: 'execution',
        validate: (r) => readBeforeEachEdit(r),
      },
      {
        id: 'no-edit-errors',
        description: 'No edit_file call errored across either file',
        points: 4,
        phase: 'execution',
        validate: (r) => noEditErrors(r) && editFileCalls(r).length >= 2,
      },
      {
        id: 'edited-both-files',
        description: 'Agent edited both strings.ts and dates.ts',
        points: 4,
        phase: 'execution',
        validate: (r) => editedPath(r, 'strings.ts') && editedPath(r, 'dates.ts'),
      },
    ],
    antiPatterns: [
      'Edited a file that was never read',
      'edit_file failed because the file had not been read yet',
    ],
    maxScore: 14,
  },
]

// ---------------------------------------------------------------------------
// Export combined
// ---------------------------------------------------------------------------

export const TOOL_DISCIPLINE_EVALS: AgentEval[] = [
  ...READ_ARG_EVALS,
  ...EDIT_DISCIPLINE_EVALS,
]
