// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * MEMORY.md → the always-on `## Memory` prompt section, under a token budget.
 *
 * Why this exists (SHO-78): `MEMORY.md` was the only part of the system prompt
 * that was both uncapped and uncached. The whole file was pushed into the
 * dynamic zone, so every byte of it was re-billed at full input price on every
 * request, forever, and it grew because nothing ever rewrote it. This module is
 * the insert-point budget — exactly like the `STACK.md` preview — so the files
 * on disk are never rewritten and `read_file` / `memory_search` keep seeing the
 * whole thing.
 *
 * Three shapes, in priority order:
 *   1. **Fits** (`## Memory` + file ≤ budget) → the file is injected verbatim,
 *      byte-for-byte what the prompt had before this change.
 *   2. **Core block** (`<!-- memory:core:start -->` … `<!-- memory:core:end -->`)
 *      → exactly that block is injected; the rest of the file is archive,
 *      indexed and searchable but not in the prompt.
 *   3. **No core block, over budget** → the preamble plus whole `##` sections
 *      newest-first until the budget is spent, re-emitted in document order
 *      (`MEMORY.md` grows by appending, so this decays the oldest observations
 *      first), then an overflow notice naming what was not loaded.
 *
 * Budget: `MEMORY_BUDGET_TOKENS`, default {@link MEMORY_BUDGET_TOKENS_DEFAULT},
 * clamped to [400, 8000]. Accounting is in characters (4 per token) because
 * that is exactly how `lastPromptBreakdown.estTokens` is computed upstream, so
 * `estTokens <= budget` holds by construction.
 */

/** Heading the injected block always carries — unchanged from the pre-SHO-78 prompt. */
export const MEMORY_SECTION_HEADING = '## Memory'

/** Default budget in tokens; see `MEMORY_BUDGET_TOKENS`. */
export const MEMORY_BUDGET_TOKENS_DEFAULT = 1500

export const MEMORY_BUDGET_TOKENS_MIN = 400
export const MEMORY_BUDGET_TOKENS_MAX = 8000

/** Marks the always-on core of a memory file; everything outside is archive. */
export const MEMORY_CORE_START = '<!-- memory:core:start -->'
export const MEMORY_CORE_END = '<!-- memory:core:end -->'

const CHARS_PER_TOKEN = 4
const MAX_LISTED_DROPPED = 12
const MAX_HEADING_CHARS_IN_NOTICE = 60
/**
 * How much of the budget the overflow notice may claim. Without a cap a small
 * budget plus long headings would let the notice eat the block it describes.
 */
const NOTICE_BUDGET_SHARE = 0.3
const NOTICE_MIN_CHARS = 240
/** Candidate listing sizes, tried in order until the notice fits its cap. */
const NOTICE_ENTRY_STEPS = [MAX_LISTED_DROPPED, 8, 4, 2, 1] as const
const SECTION_SEPARATOR = '\n\n'

export interface MemorySectionInput {
  /** Raw `MEMORY.md` contents. */
  markdown: string
  /** Overrides `MEMORY_BUDGET_TOKENS`; clamped to [400, 8000]. */
  budgetTokens?: number
}

export interface DroppedMemorySection {
  /** The `## …` heading line, trimmed. */
  heading: string
  /** 1-based, inclusive. */
  lineStart: number
  /** 1-based, inclusive. */
  lineEnd: number
}

export interface MemorySection {
  /** What to inject, `## Memory` heading included. Empty when there is no memory. */
  content: string
  truncated: boolean
  /** Tokens in {@link content} — always `<= budgetTokens`. */
  usedTokens: number
  /** Tokens in the whole file. */
  totalTokens: number
  /** Headings of the sections that made it into {@link content}. */
  includedSections: string[]
  droppedSections: DroppedMemorySection[]
}

/**
 * Resolve the budget from the environment, clamped so a typo or a stray `0`
 * cannot empty the block or let it swallow the prompt.
 */
export function resolveMemoryBudgetTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEMORY_BUDGET_TOKENS
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return MEMORY_BUDGET_TOKENS_DEFAULT
  return clampBudgetTokens(parsed)
}

function clampBudgetTokens(value: number): number {
  if (!Number.isFinite(value)) return MEMORY_BUDGET_TOKENS_DEFAULT
  const rounded = Math.floor(value)
  if (rounded < MEMORY_BUDGET_TOKENS_MIN) return MEMORY_BUDGET_TOKENS_MIN
  if (rounded > MEMORY_BUDGET_TOKENS_MAX) return MEMORY_BUDGET_TOKENS_MAX
  return rounded
}

/** Mirrors `pushStable`'s estimate so the budget and the breakdown agree. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

interface ParsedSection {
  heading: string
  lineStart: number
  lineEnd: number
  text: string
}

interface ParsedMemory {
  preamble: string
  sections: ParsedSection[]
}

/**
 * Split a memory file into its preamble (everything before the first `## `
 * line) and its `## ` sections, keeping 1-based line numbers for the notice.
 */
function parseMemory(markdown: string): ParsedMemory {
  const lines = markdown.split(/\r?\n/)
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^##[ \t]/.test(lines[i])) starts.push(i)
  }
  if (starts.length === 0) {
    return { preamble: markdown.trim(), sections: [] }
  }
  const preamble = lines.slice(0, starts[0]).join('\n').trim()
  const sections: ParsedSection[] = starts.map((start, index) => {
    // Exclusive 0-based end index → same number is the inclusive 1-based last line.
    const end = index + 1 < starts.length ? starts[index + 1] : lines.length
    return {
      heading: lines[start].trim(),
      lineStart: start + 1,
      lineEnd: end,
      text: lines.slice(start, end).join('\n').trim(),
    }
  })
  return { preamble, sections }
}

/** The contents of the core block, or `null` when the file has no (valid) pair of markers. */
function extractCoreBody(markdown: string): string | null {
  const start = markdown.indexOf(MEMORY_CORE_START)
  if (start === -1) return null
  const end = markdown.indexOf(MEMORY_CORE_END, start + MEMORY_CORE_START.length)
  if (end === -1) return null
  return markdown.slice(start + MEMORY_CORE_START.length, end).trim()
}

/**
 * Cut at the last line break that fits. Falls back to the last space, then to a
 * hard cut, so a single-paragraph file still yields something instead of ''.
 */
function cutAtLineBoundary(text: string, maxChars: number): { text: string; cut: boolean } {
  if (text.length <= maxChars) return { text, cut: false }
  if (maxChars <= 0) return { text: '', cut: true }
  const window = text.slice(0, maxChars)
  const newline = window.lastIndexOf('\n')
  if (newline > 0) return { text: window.slice(0, newline).trimEnd(), cut: true }
  const space = window.lastIndexOf(' ')
  if (space > 0) return { text: window.slice(0, space).trimEnd(), cut: true }
  return { text: window.trimEnd(), cut: true }
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

function noticeHeading(heading: string): string {
  const trimmed = heading.trim()
  if (trimmed.length <= MAX_HEADING_CHARS_IN_NOTICE) return trimmed
  return `${trimmed.slice(0, MAX_HEADING_CHARS_IN_NOTICE - 1)}…`
}

function formatDroppedList(listed: DroppedMemorySection[], hasMore: boolean): string {
  const entries = listed.map((d) => `"${noticeHeading(d.heading)}" (L${d.lineStart}-${d.lineEnd})`).join(', ')
  return hasMore ? `${entries}, …` : entries
}

interface NoticeContext {
  bytes: number
  totalTokens: number
  shownTokens: number
  includedSections: number
  totalSections: number
  budgetTokens: number
}

const MEMORY_TAIL_HINT = (budgetTokens: number) =>
  `Use memory_search to reach these. Move durable facts into a <!-- memory:core:start/end --> block of ≤${formatNumber(budgetTokens)} tokens; long-form detail belongs in memory/<slug>.md.`

/**
 * Render the overflow notice, listing as many dropped sections as fit in
 * `maxChars`. The count steps down rather than bisecting: there are at most a
 * handful of steps and the result is stable for a given file.
 */
function buildOverflowNotice(
  ctx: NoticeContext,
  dropped: DroppedMemorySection[],
  maxChars: number = Number.POSITIVE_INFINITY,
  preambleTruncated: boolean = false,
): string {
  const render = (count: number): string => {
    const listed = dropped.slice(0, count)
    const hasMore = dropped.length > count
    const head =
      `(MEMORY.md is ${formatNumber(ctx.bytes)} B / ~${formatNumber(ctx.totalTokens)} tokens; ` +
      `showing ${formatNumber(ctx.shownTokens)} tokens across ${ctx.includedSections} of ${ctx.totalSections} sections.`
    const opening = preambleTruncated ? 'the rest of the opening section' : ''
    const notLoaded = listed.length > 0
      ? `Not loaded: ${opening ? `${opening}, plus ` : ''}${formatDroppedList(listed, hasMore)}`
      : `Not loaded: ${opening || 'the rest of the opening section'}.`
    return [head, notLoaded, `${MEMORY_TAIL_HINT(ctx.budgetTokens)})`].join('\n')
  }

  for (const count of NOTICE_ENTRY_STEPS) {
    const n = Math.min(count, dropped.length)
    if (n <= 0) break
    const text = render(n)
    if (text.length <= maxChars) return text
  }
  return render(Math.min(1, dropped.length))
}

function buildHeadinglessNotice(ctx: NoticeContext): string {
  const head =
    `(MEMORY.md is ${formatNumber(ctx.bytes)} B / ~${formatNumber(ctx.totalTokens)} tokens; ` +
    `showing ${formatNumber(ctx.shownTokens)} tokens — the file is cut at a line boundary.`
  return [
    head,
    `Use memory_search to reach the rest. Split it into ## sections, keep durable facts in a <!-- memory:core:start/end --> block of ≤${formatNumber(ctx.budgetTokens)} tokens, and move long-form detail into memory/<slug>.md.)`,
  ].join('\n')
}

function buildCoreOverflowNotice(ctx: NoticeContext): string {
  const head =
    `(MEMORY.md is ${formatNumber(ctx.bytes)} B / ~${formatNumber(ctx.totalTokens)} tokens; ` +
    `the <!-- memory:core:start/end --> block alone is over the ${formatNumber(ctx.budgetTokens)}-token budget, so it is cut at a line boundary.`
  return [
    head,
    `Use memory_search to reach what is not loaded. Keep the core block under ~${formatNumber(ctx.budgetTokens)} tokens and move long-form detail into memory/<slug>.md.)`,
  ].join('\n')
}

/**
 * Emitted when the core block fits and only the archive around it was left out.
 * Deliberately shorter than {@link buildCoreOverflowNotice} — that one is the
 * reserve the cut is fitted against, so this can never push past the budget.
 */
function buildCoreArchiveNotice(ctx: NoticeContext): string {
  return (
    `(MEMORY.md is ${formatNumber(ctx.bytes)} B / ~${formatNumber(ctx.totalTokens)} tokens; showing only the ` +
    `<!-- memory:core:start/end --> core block. Everything outside it is archive — reach it with memory_search.)`
  )
}

/**
 * How many characters to reserve for the overflow notice before fitting the
 * sections.
 *
 * The bound has to hold for *any* notice we may end up emitting, because the
 * content is assembled once: `min(worst case, max(minimum viable notice,
 * NOTICE_MIN_CHARS, NOTICE_BUDGET_SHARE of the budget))`. `worstCase` uses every
 * droppable entry at the maximum heading width; the floor guarantees the
 * shortest notice we can produce still fits the reserve, so a section is never
 * admitted that the notice then pushes back over budget.
 */
function noticeReserveChars(ctx: NoticeContext, sectionCount: number): number {
  if (sectionCount === 0) {
    return Math.min(
      buildHeadinglessNotice({ ...ctx, shownTokens: ctx.budgetTokens }).length,
      Math.max(NOTICE_MIN_CHARS, Math.floor(ctx.budgetTokens * CHARS_PER_TOKEN * NOTICE_BUDGET_SHARE)),
    )
  }

  const pseudo = (count: number): DroppedMemorySection[] =>
    Array.from({ length: count }, () => ({
      heading: 'x'.repeat(MAX_HEADING_CHARS_IN_NOTICE),
      lineStart: 999_999,
      lineEnd: 999_999,
    }))

  const worstCase = buildOverflowNotice(ctx, pseudo(Math.min(sectionCount, MAX_LISTED_DROPPED)), undefined, true).length
  const floor =
    ctx.budgetTokens * CHARS_PER_TOKEN * NOTICE_BUDGET_SHARE > NOTICE_MIN_CHARS
      ? Math.floor(ctx.budgetTokens * CHARS_PER_TOKEN * NOTICE_BUDGET_SHARE)
      : NOTICE_MIN_CHARS
  const smallestViable = buildOverflowNotice(ctx, pseudo(1), undefined, true).length
  return Math.min(worstCase, Math.max(floor, smallestViable))
}

interface FitResult {
  preamble: string
  kept: ParsedSection[]
  dropped: ParsedSection[]
  preambleTruncated: boolean
}

/**
 * Keep the preamble (mandatory) and then whole sections newest-first, stopping
 * at the first one that no longer fits.
 */
function fitSections(preamble: string, sections: ParsedSection[], availableChars: number): FitResult {
  let remaining = availableChars + SECTION_SEPARATOR.length
  let keptPreamble = preamble
  let preambleTruncated = false

  if (preamble) {
    if (preamble.length + SECTION_SEPARATOR.length <= remaining) {
      remaining -= preamble.length + SECTION_SEPARATOR.length
    } else {
      // The separator that follows the preamble is only free when a section is
      // joined after it (`remaining` is seeded with one spare separator). Spend
      // it here, or the preamble overruns the budget by 2 chars — which is a
      // token once it crosses a multiple of 4 (QA, SHO-78: a headingless file
      // at MEMORY_BUDGET_TOKENS=400 reported 401 tokens).
      const cut = cutAtLineBoundary(
        preamble,
        Math.max(0, remaining - SECTION_SEPARATOR.length),
      )
      keptPreamble = cut.text
      preambleTruncated = cut.cut
      remaining = SECTION_SEPARATOR.length
    }
  }

  const keptIndexes = new Set<number>()
  for (let i = sections.length - 1; i >= 0; i--) {
    const cost = sections[i].text.length + SECTION_SEPARATOR.length
    if (cost > remaining) break
    remaining -= cost
    keptIndexes.add(i)
  }

  const kept = sections.filter((_, i) => keptIndexes.has(i))
  const dropped = sections.filter((_, i) => !keptIndexes.has(i))
  return { preamble: keptPreamble, kept, dropped, preambleTruncated }
}

function assemble(heading: string, body: string, notice: string): string {
  const parts = body ? [heading, body] : [heading]
  return `${parts.join('\n')}${SECTION_SEPARATOR}${notice}`
}

/**
 * Build the `## Memory` prompt section for a memory file.
 *
 * Pure and synchronous: no file access, no caching. The caller decides when to
 * re-run it (the gateway re-runs it only when `MEMORY.md`'s mtime or size
 * changes, so a turn does not invalidate the prompt cache).
 */
export function buildMemorySection(input: MemorySectionInput): MemorySection {
  const markdown = input.markdown ?? ''
  const budgetTokens = clampBudgetTokens(input.budgetTokens ?? resolveMemoryBudgetTokens())
  const budgetChars = budgetTokens * CHARS_PER_TOKEN
  const heading = MEMORY_SECTION_HEADING
  const totalTokens = estimateTokens(markdown.length)
  const bytes = Buffer.byteLength(markdown, 'utf8')
  const trimmed = markdown.trim()

  if (!trimmed) {
    return {
      content: '',
      truncated: false,
      usedTokens: 0,
      totalTokens,
      includedSections: [],
      droppedSections: [],
    }
  }

  const fits = `${heading}\n${trimmed}`
  if (fits.length <= budgetChars) {
    return {
      content: fits,
      truncated: false,
      usedTokens: estimateTokens(fits.length),
      totalTokens,
      includedSections: parseMemory(trimmed).sections.map((s) => s.heading),
      droppedSections: [],
    }
  }

  const coreBody = extractCoreBody(trimmed)
  if (coreBody !== null) {
    return renderCore({ coreBody, heading, budgetChars, budgetTokens, totalTokens, bytes })
  }
  return renderSections({ trimmed, heading, budgetChars, budgetTokens, totalTokens, bytes })
}

function renderCore(args: {
  coreBody: string
  heading: string
  budgetChars: number
  budgetTokens: number
  totalTokens: number
  bytes: number
}): MemorySection {
  const { coreBody, heading, budgetChars, budgetTokens, totalTokens, bytes } = args
  const ctx: NoticeContext = {
    bytes,
    totalTokens,
    shownTokens: totalTokens,
    includedSections: 0,
    totalSections: 0,
    budgetTokens,
  }
  const cutNotice = buildCoreOverflowNotice(ctx)
  const available = budgetChars - heading.length - 1 - SECTION_SEPARATOR.length - cutNotice.length

  if (coreBody.length <= available) {
    const content = assemble(heading, coreBody, buildCoreArchiveNotice(ctx))
    return {
      content,
      truncated: true,
      usedTokens: estimateTokens(content.length),
      totalTokens,
      includedSections: parseMemory(coreBody).sections.map((s) => s.heading),
      droppedSections: [],
    }
  }

  const cut = cutAtLineBoundary(coreBody, Math.max(0, available))
  const content = assemble(heading, cut.text, cutNotice)
  return {
    content,
    truncated: true,
    usedTokens: estimateTokens(content.length),
    totalTokens,
    includedSections: parseMemory(cut.text).sections.map((s) => s.heading),
    droppedSections: [],
  }
}

function renderSections(args: {
  trimmed: string
  heading: string
  budgetChars: number
  budgetTokens: number
  totalTokens: number
  bytes: number
}): MemorySection {
  const { trimmed, heading, budgetChars, budgetTokens, totalTokens, bytes } = args
  const parsed = parseMemory(trimmed)
  const ctx: NoticeContext = {
    bytes,
    totalTokens,
    // Filled in once the body is known; the reserve only needs its digit width.
    shownTokens: budgetTokens,
    includedSections: parsed.sections.length,
    totalSections: parsed.sections.length,
    budgetTokens,
  }

  const reserve = noticeReserveChars(ctx, parsed.sections.length)
  const available = budgetChars - heading.length - 1 - SECTION_SEPARATOR.length - reserve
  const fit = fitSections(parsed.preamble, parsed.sections, Math.max(0, available))

  const bodyParts = [fit.preamble, ...fit.kept.map((s) => s.text)].filter(Boolean)
  const body = bodyParts.join(SECTION_SEPARATOR)
  const shownTokens = estimateTokens(heading.length + 1 + body.length)

  const dropped: DroppedMemorySection[] = fit.dropped.map((s) => ({
    heading: s.heading,
    lineStart: s.lineStart,
    lineEnd: s.lineEnd,
  }))
  const noticeCtx: NoticeContext = {
    ...ctx,
    shownTokens,
    includedSections: fit.kept.length,
  }
  const notice = parsed.sections.length === 0
    ? buildHeadinglessNotice(noticeCtx)
    : buildOverflowNotice(noticeCtx, dropped, reserve, fit.preambleTruncated)

  const content = assemble(heading, body, notice)
  return {
    content,
    truncated: true,
    usedTokens: estimateTokens(content.length),
    totalTokens,
    includedSections: fit.kept.map((s) => s.heading),
    droppedSections: dropped,
  }
}
