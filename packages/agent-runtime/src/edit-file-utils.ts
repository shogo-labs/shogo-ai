// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Edit File Utilities — curly quote normalization, quote-style preservation,
 * trailing whitespace stripping, encoding detection, CRLF preservation,
 * smart deletion, and structured diff generation for the edit_file tool.
 */

import { structuredPatch, type StructuredPatchHunk } from 'diff'
import { readFileSync } from 'fs'

export type LineEndingType = 'LF' | 'CRLF'

export interface FileMetadata {
  content: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
}

/**
 * Read a file and detect its encoding (UTF-16LE or UTF-8) and line endings.
 */
export function readFileWithMetadata(filePath: string): FileMetadata {
  const raw = readFileSync(filePath)

  // UTF-16LE BOM detection
  const isUtf16LE = raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE
  const encoding: BufferEncoding = isUtf16LE ? 'utf16le' : 'utf-8'
  const content = raw.toString(encoding)

  // Detect line endings by counting occurrences
  const crlfCount = (content.match(/\r\n/g) ?? []).length
  const lfCount = (content.match(/(?<!\r)\n/g) ?? []).length
  const lineEndings: LineEndingType = crlfCount > lfCount ? 'CRLF' : 'LF'

  return { content, encoding, lineEndings }
}

/**
 * Write content preserving the original encoding and line endings.
 */
export function writeWithMetadata(
  filePath: string,
  content: string,
  encoding: BufferEncoding,
  lineEndings: LineEndingType,
): void {
  let toWrite = content
  if (lineEndings === 'CRLF') {
    toWrite = content.replaceAll('\r\n', '\n').split('\n').join('\r\n')
  }
  const { writeFileSync } = require('fs') as typeof import('fs')
  writeFileSync(filePath, toWrite, { encoding })
}

/**
 * Apply an edit with smart deletion: when new_string is empty and old_string
 * doesn't end with '\n' but old_string + '\n' exists in the file, also
 * remove the trailing newline to prevent blank lines after deletion.
 */
export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
): string {
  const replacer = replaceAll
    ? (content: string, search: string, replace: string) => content.replaceAll(search, () => replace)
    : (content: string, search: string, replace: string) => content.replace(search, () => replace)

  if (newString !== '') {
    return replacer(originalContent, oldString, newString)
  }

  const stripTrailingNewline =
    !oldString.endsWith('\n') && originalContent.includes(oldString + '\n')

  return stripTrailingNewline
    ? replacer(originalContent, oldString + '\n', newString)
    : replacer(originalContent, oldString, newString)
}

/**
 * Count occurrences of `needle` in `haystack` using a single indexOf scan.
 * If `maxCount` is provided, stops early after finding that many — useful
 * when the caller only needs to distinguish "0 vs 1 vs 2+" without
 * materializing the full array that `haystack.split(needle)` would produce.
 */
export function countOccurrences(haystack: string, needle: string, maxCount?: number): number {
  if (!needle) return 0
  let count = 0
  let i = 0
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++
    if (maxCount !== undefined && count >= maxCount) return count
    i += needle.length
  }
  return count
}

/**
 * Single-pass splice that replaces `oldString` at `positions` with
 * `newString`. Avoids the secondary content scan that
 * `String.prototype.replace` does — the caller is expected to have already
 * located the positions (e.g. via `countOccurrences` + a parallel
 * `indexOf` walk, or a fuzzy matcher).
 *
 * When `consumeTrailingNewline` is true and `newString === ''`, also
 * consumes a single `\n` immediately after each occurrence so that
 * deleting "line2" from "line1\nline2\nline3\n" yields
 * "line1\nline3\n" (matches `applyEditToFile`'s smart deletion).
 */
export function applyExactEdit(
  content: string,
  positions: number[],
  oldLength: number,
  newString: string,
  consumeTrailingNewline: boolean = false,
): string {
  if (positions.length === 0) return content
  let result = ''
  let lastEnd = 0
  for (const i of positions) {
    result += content.substring(lastEnd, i) + newString
    lastEnd = i + oldLength
    if (consumeTrailingNewline && newString === '' && content[lastEnd] === '\n') {
      lastEnd += 1
    }
  }
  result += content.substring(lastEnd)
  return result
}

/**
 * Walk `content` and collect every starting index of `needle`. Stops early
 * when `maxCount` is hit. Returns positions in left-to-right order.
 */
export function findAllOccurrences(content: string, needle: string, maxCount?: number): number[] {
  if (!needle) return []
  const positions: number[] = []
  let i = 0
  while ((i = content.indexOf(needle, i)) !== -1) {
    positions.push(i)
    if (maxCount !== undefined && positions.length >= maxCount) return positions
    i += needle.length
  }
  return positions
}

/**
 * Generate a structured diff patch for the edit (for UI/display purposes).
 */
export function getStructuredPatch(
  filePath: string,
  oldContent: string,
  newContent: string,
): StructuredPatchHunk[] {
  const patch = structuredPatch(filePath, filePath, oldContent, newContent, undefined, undefined, { context: 4 })
  return patch.hunks
}

/**
 * Generate a structured diff over a window around `spliceIndex`. Avoids
 * running Myers diff over the entire file when the change is small. The
 * window extends `windowLines` lines before and after the splice point.
 *
 * Returns hunks with line numbers translated back to the full file's
 * coordinates, so consumers can render them as if `getStructuredPatch`
 * had been called over the whole content.
 *
 * Falls back to a full-file diff when the window would cover the entire
 * file anyway (small files) or the splice index can't be located in
 * either side (e.g. content was rewritten end-to-end).
 */
export function getLocalStructuredPatch(
  filePath: string,
  oldContent: string,
  newContent: string,
  spliceIndex: number,
  windowLines: number = 64,
): StructuredPatchHunk[] {
  // For small files, the full diff is already cheap and avoids edge cases.
  const SMALL_FILE_THRESHOLD = 64 * 1024 // 64 KB
  if (oldContent.length <= SMALL_FILE_THRESHOLD && newContent.length <= SMALL_FILE_THRESHOLD) {
    return getStructuredPatch(filePath, oldContent, newContent)
  }

  // Locate the splice line index in the OLD content. Counting newlines up
  // to spliceIndex is O(spliceIndex) but that's much cheaper than running
  // diff over the whole file.
  let oldSpliceLine = 0
  for (let i = 0; i < spliceIndex && i < oldContent.length; i++) {
    if (oldContent.charCodeAt(i) === 10 /* \n */) oldSpliceLine++
  }

  // Estimate the matching line index in NEW content. Lines before the
  // splice are unchanged, so they share the same line index in old and new.
  const newSpliceLine = oldSpliceLine

  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')

  const oldStart = Math.max(0, oldSpliceLine - windowLines)
  const oldEnd = Math.min(oldLines.length, oldSpliceLine + windowLines + 1)
  const newStart = Math.max(0, newSpliceLine - windowLines)
  const newEnd = Math.min(newLines.length, newSpliceLine + windowLines + 1)

  // If the window covers (almost) the whole file, just do a full diff.
  if (oldStart === 0 && oldEnd === oldLines.length && newStart === 0 && newEnd === newLines.length) {
    return getStructuredPatch(filePath, oldContent, newContent)
  }

  const oldWindow = oldLines.slice(oldStart, oldEnd).join('\n')
  const newWindow = newLines.slice(newStart, newEnd).join('\n')
  const patch = structuredPatch(filePath, filePath, oldWindow, newWindow, undefined, undefined, { context: 4 })

  // Translate hunk line numbers from window-relative to file-relative.
  return patch.hunks.map((h) => ({
    ...h,
    oldStart: h.oldStart + oldStart,
    newStart: h.newStart + newStart,
  }))
}

const LEFT_SINGLE_CURLY = '\u2018'  // '
const RIGHT_SINGLE_CURLY = '\u2019' // '
const LEFT_DOUBLE_CURLY = '\u201C'  // "
const RIGHT_DOUBLE_CURLY = '\u201D' // "

/**
 * Convert curly/smart quotes to straight ASCII quotes.
 */
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY, "'")
    .replaceAll(RIGHT_SINGLE_CURLY, "'")
    .replaceAll(LEFT_DOUBLE_CURLY, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY, '"')
}

/**
 * Find the actual string in file content that matches the search string,
 * accounting for curly quote normalization. Returns the original file
 * substring (preserving curly quotes) so splicing works correctly.
 *
 * Returns null if no match is found even after normalization.
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  if (fileContent.includes(searchString)) return searchString

  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)

  const idx = normalizedFile.indexOf(normalizedSearch)
  if (idx !== -1) {
    return fileContent.substring(idx, idx + searchString.length)
  }

  return null
}

/**
 * When old_string matched via quote normalization (curly quotes in file,
 * straight quotes from model), apply the same curly quote style to new_string
 * so the edit preserves the file's typography.
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) return newString

  const hasDouble =
    actualOldString.includes(LEFT_DOUBLE_CURLY) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY)
  const hasSingle =
    actualOldString.includes(LEFT_SINGLE_CURLY) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY)

  if (!hasDouble && !hasSingle) return newString

  let result = newString
  if (hasDouble) result = applyCurlyDoubleQuotes(result)
  if (hasSingle) result = applyCurlySingleQuotes(result)
  return result
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) return true
  const prev = chars[index - 1]
  return (
    prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' ||
    prev === '(' || prev === '[' || prev === '{' ||
    prev === '\u2014' || prev === '\u2013' // em/en dash
  )
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(isOpeningContext(chars, i) ? LEFT_DOUBLE_CURLY : RIGHT_DOUBLE_CURLY)
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      const prev = i > 0 ? chars[i - 1] : undefined
      const next = i < chars.length - 1 ? chars[i + 1] : undefined
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev)
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next)
      // Apostrophes in contractions (e.g. "don't") get right curly
      if (prevIsLetter && nextIsLetter) {
        result.push(RIGHT_SINGLE_CURLY)
      } else {
        result.push(isOpeningContext(chars, i) ? LEFT_SINGLE_CURLY : RIGHT_SINGLE_CURLY)
      }
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

/**
 * Strip trailing whitespace from each line while preserving line endings.
 * Markdown files should skip this since trailing spaces are meaningful.
 */
export function stripTrailingWhitespace(str: string): string {
  const parts = str.split(/(\r\n|\n|\r)/)
  let result = ''
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== undefined) {
      result += i % 2 === 0
        ? parts[i].replace(/\s+$/, '') // line content
        : parts[i]                      // line ending
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Fuzzy-match helpers — line-anchored matchers + indent translation
//
// Used by the edit_file fuzzy-match cascade to fix three classes of silent
// corruption that the older substring-search-based stages produced:
//   - Bug #1: mid-line splices snapped to start-of-line
//   - Bug #2: CRLF-aware match returned a normalized-content offset
//   - Bug #3: whitespace-flexible match dropped the file's indentation
// ---------------------------------------------------------------------------

/** Stage that produced a fuzzy match. Surfaced in result telemetry so
 *  operators can spot which non-exact path the model is leaning on. */
export type FuzzyStage =
  | 'unescape-quote'
  | 'crlf-normalize'
  | 'trailing-ws'
  | 'indent-translate'

/** Result of a fuzzy stage. `reindentPrefix` is prepended to each non-empty
 *  line of `new_string` before splicing. */
export type FuzzyMatch = {
  index: number
  match: string
  reindentPrefix?: string
  /** Which stage of the cascade produced this match. */
  stage?: FuzzyStage
}

/** Internal: leading whitespace ([ \t]*) of a single line. */
function leadingWhitespace(line: string): string {
  let i = 0
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
  return line.substring(0, i)
}

/** Internal: per-line byte offset table for `content.split('\n')`. Position
 *  `offsets[i]` is the byte index where line `i` starts. */
function lineStartOffsets(lines: string[]): number[] {
  const offsets = new Array<number>(lines.length)
  let pos = 0
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = pos
    pos += lines[i].length + 1 // +1 for the '\n' separator
  }
  return offsets
}

/**
 * CRLF-aware match: find `needle` in `content` ignoring \r\n vs \n
 * differences. Returns indices into the ORIGINAL content (not the normalized
 * copy), so the splice in the caller stays byte-aligned. Refuses ambiguous
 * matches.
 *
 * Replaces the buggy Stage 3 that returned `{ index: normIdx, ... }` — a
 * normalized-content offset against unnormalized bytes.
 */
export function findCRLFNormalizedMatch(content: string, needle: string): FuzzyMatch | null {
  if (!content.includes('\r') && !needle.includes('\r')) return null

  const normalizedNeedle = needle.replace(/\r\n/g, '\n')
  const normalizedContent = content.replace(/\r\n/g, '\n')

  const firstNorm = normalizedContent.indexOf(normalizedNeedle)
  if (firstNorm === -1) return null
  const secondNorm = normalizedContent.indexOf(normalizedNeedle, firstNorm + normalizedNeedle.length)
  if (secondNorm !== -1) return null // ambiguous

  // Walk the original content, advancing the "normalized cursor" by 1 for
  // each byte we consume (treating \r\n as a single normalized step). Stops
  // when the normalized cursor reaches firstNorm — that's the start of the
  // match in original-content bytes.
  let origStart = 0
  let normPos = 0
  while (normPos < firstNorm) {
    if (content[origStart] === '\r' && content[origStart + 1] === '\n') {
      origStart += 2
    } else {
      origStart += 1
    }
    normPos += 1
  }

  // Walk forward by normalizedNeedle.length normalized chars to find the end.
  let origEnd = origStart
  let normEnd = 0
  while (normEnd < normalizedNeedle.length) {
    if (content[origEnd] === '\r' && content[origEnd + 1] === '\n') {
      origEnd += 2
    } else {
      origEnd += 1
    }
    normEnd += 1
  }

  return { index: origStart, match: content.substring(origStart, origEnd), stage: 'crlf-normalize' }
}

/**
 * Trailing-whitespace tolerant, line-anchored match. Each needle line must
 * equal the corresponding file line after `trimEnd()`. The match span is a
 * contiguous run of full file lines, so the splice can never "snap" mid-line.
 *
 * Replaces the buggy Stage 4 that did a substring search in a trim-trailing
 * copy and snapped to start-of-line for any hit. Refuses ambiguous matches.
 *
 * `contentLines` may be supplied to share a pre-computed `content.split('\n')`
 * across multiple fuzzy stages (saves an O(n) split per stage on large files).
 */
export function findLineAnchoredTrailingWS(
  content: string,
  needle: string,
  contentLines?: string[],
): FuzzyMatch | null {
  const lines = contentLines ?? content.split('\n')
  const needleLines = needle.split('\n')
  if (needleLines.length === 0 || needleLines.length > lines.length) return null

  const offsets = lineStartOffsets(lines)
  const trimmedNeedle = needleLines.map((l) => l.trimEnd())

  let firstHit: FuzzyMatch | null = null
  for (let i = 0; i + needleLines.length <= lines.length; i++) {
    let matched = true
    for (let j = 0; j < needleLines.length; j++) {
      if (lines[i + j]!.trimEnd() !== trimmedNeedle[j]) { matched = false; break }
    }
    if (!matched) continue
    const startPos = offsets[i]!
    const matchStr = lines.slice(i, i + needleLines.length).join('\n')
    if (firstHit !== null) return null // ambiguous
    firstHit = { index: startPos, match: matchStr, stage: 'trailing-ws' }
  }
  return firstHit
}

/**
 * Whitespace-flexible, line-anchored match with indent translation.
 *
 * Each needle line must equal the corresponding file line after `lstrip()`,
 * AND the per-line "extra prefix" the file has over the needle must be
 * identical across every matched line. That common extra prefix is returned
 * as `reindentPrefix` so the caller can prepend it to every non-empty line
 * of `new_string` before splicing — preserving the file's existing
 * indentation.
 *
 * Replaces the buggy Stage 5 that fully `trim()`d each line and spliced
 * `new_string` as-is, silently dropping the file's indentation.
 *
 * Indent units must be consistent (e.g. 4 spaces of needle prefix mapped to
 * 1 tab of file prefix on EVERY matched line). Inconsistent translations
 * are refused — the agent should retry with a corrected needle.
 */
export function findLineAnchoredFlexibleIndent(
  content: string,
  needle: string,
  contentLines?: string[],
): FuzzyMatch | null {
  const lines = contentLines ?? content.split('\n')
  const needleLines = needle.split('\n')
  if (needleLines.length === 0 || needleLines.length > lines.length) return null

  const offsets = lineStartOffsets(lines)
  const lstripNeedle = needleLines.map((l) => l.replace(/^[ \t]*/, ''))

  let firstHit: FuzzyMatch | null = null
  for (let i = 0; i + needleLines.length <= lines.length; i++) {
    // Quick reject: lstripped lines must agree
    let matched = true
    for (let j = 0; j < needleLines.length; j++) {
      if (lines[i + j]!.replace(/^[ \t]*/, '') !== lstripNeedle[j]) { matched = false; break }
    }
    if (!matched) continue

    // Verify a consistent extra-prefix across all non-empty matched lines.
    // The file line's leading ws must be: <commonExtra> + <needleLeadingWs>.
    let commonExtra: string | null = null
    let consistent = true
    for (let j = 0; j < needleLines.length; j++) {
      const fileLine = lines[i + j]!
      const needleLine = needleLines[j]!
      // Skip blank lines from the consistency check
      if (needleLine.length === 0 && fileLine.length === 0) continue
      const fileIndent = leadingWhitespace(fileLine)
      const needleIndent = leadingWhitespace(needleLine)
      if (!fileIndent.endsWith(needleIndent)) { consistent = false; break }
      const extra = fileIndent.substring(0, fileIndent.length - needleIndent.length)
      if (commonExtra === null) commonExtra = extra
      else if (commonExtra !== extra) { consistent = false; break }
    }
    if (!consistent) continue

    const startPos = offsets[i]!
    const matchStr = lines.slice(i, i + needleLines.length).join('\n')
    const reindentPrefix = commonExtra ?? ''
    if (firstHit !== null) return null // ambiguous
    firstHit = { index: startPos, match: matchStr, reindentPrefix, stage: 'indent-translate' }
  }
  return firstHit
}

/**
 * Best-effort search for the file region the model's `needle` was probably
 * trying to match. Returns the file's VERBATIM text for that region — the
 * exact string the agent should have sent — or `null` if nothing remotely
 * similar is found.
 *
 * Intended purely for hints in error/note payloads. The matchers themselves
 * use stricter rules and refuse ambiguous matches; this helper is allowed
 * to pick a single best candidate even when the strict matchers refused
 * (e.g. inconsistent indent translation, or trailing-ws differences across
 * multiple sites). Never use the return value to splice — only to display.
 */
export function suggestCorrectedNeedle(
  content: string,
  needle: string,
  contentLines?: string[],
): string | null {
  const lines = contentLines ?? content.split('\n')
  const needleLines = needle.split('\n')
  if (needleLines.length === 0 || needleLines.length > lines.length) return null

  // Tier 1: equal after stripping each line's leading whitespace. Catches
  // indent-mismatch (tabs vs spaces, different outer indent depth).
  const lstripNeedle = needleLines.map((l) => l.replace(/^[ \t]*/, ''))
  for (let i = 0; i + needleLines.length <= lines.length; i++) {
    let ok = true
    for (let j = 0; j < needleLines.length; j++) {
      if (lines[i + j]!.replace(/^[ \t]*/, '') !== lstripNeedle[j]) { ok = false; break }
    }
    if (ok) return lines.slice(i, i + needleLines.length).join('\n')
  }

  // Tier 2: equal after full trim. Catches trailing-ws AND indent mismatch.
  const trimNeedle = needleLines.map((l) => l.trim())
  for (let i = 0; i + needleLines.length <= lines.length; i++) {
    let ok = true
    for (let j = 0; j < needleLines.length; j++) {
      if (lines[i + j]!.trim() !== trimNeedle[j]) { ok = false; break }
    }
    if (ok) return lines.slice(i, i + needleLines.length).join('\n')
  }

  // Tier 3: first-line lstrip match. When the multi-line needle has drifted
  // (extra/missing lines), at least anchor on a meaningful first line.
  const firstNeedleStripped = lstripNeedle[0]
  if (firstNeedleStripped && firstNeedleStripped.length >= 5) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.replace(/^[ \t]*/, '') === firstNeedleStripped) {
        const end = Math.min(lines.length, i + needleLines.length)
        return lines.slice(i, end).join('\n')
      }
    }
  }

  return null
}

/**
 * Prepend `prefix` to every non-empty line of `newString`. Empty lines stay
 * empty (no trailing-whitespace pollution). Used by the indent-translation
 * stage to keep the file's outer indent on the replacement.
 */
export function reindentNewString(newString: string, prefix: string): string {
  if (prefix === '') return newString
  return newString
    .split('\n')
    .map((line) => (line.length === 0 ? line : prefix + line))
    .join('\n')
}
