// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Edit File Utilities — curly quote normalization, quote-style preservation,
 * trailing whitespace stripping, encoding detection, CRLF preservation,
 * smart deletion, and structured diff generation for the edit_file tool.
 */

import { structuredPatch, type StructuredPatchHunk } from 'diff'
import { readFileSync, existsSync, statSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, parse as parsePath, relative, sep } from 'path'

export type LineEndingType = 'LF' | 'CRLF'

export interface FileMetadata {
  content: string
  encoding: BufferEncoding
  /** Line endings actually present on disk (best-effort detection). */
  lineEndings: LineEndingType
  /**
   * The line ending the file *should* use when written back. Honors any
   * `eol=` directive in a parent `.gitattributes`, otherwise falls back to
   * detection. Callers should pass this to `writeWithMetadata`.
   */
  targetLineEndings: LineEndingType
}

/**
 * Read a file and detect its encoding (UTF-16LE or UTF-8) and line endings.
 *
 * Detection is intentionally conservative: a file is only classified as
 * CRLF when ≥95% of its newlines are CRLF. This avoids the failure mode
 * where a single stray CRLF in an otherwise-LF file tips a majority-vote
 * detector and causes the writer to rewrite the entire file with CRLF.
 *
 * Callers should prefer `targetLineEndings` over the raw detected
 * `lineEndings` — `targetLineEndings` additionally honors `.gitattributes`.
 */
export function readFileWithMetadata(filePath: string): FileMetadata {
  const raw = readFileSync(filePath)

  // UTF-16LE BOM detection
  const isUtf16LE = raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE
  const encoding: BufferEncoding = isUtf16LE ? 'utf16le' : 'utf-8'
  const content = raw.toString(encoding)

  const lineEndings = detectLineEndings(content)
  const policy = resolveLineEndingPolicy(filePath)
  const targetLineEndings: LineEndingType = policy ?? lineEndings

  return { content, encoding, lineEndings, targetLineEndings }
}

/**
 * Classify a string's line endings. Returns 'CRLF' only when CRLFs make up
 * ≥95% of newlines (and there is at least one); otherwise 'LF'. This is
 * deliberately biased toward LF to prevent CRLF drift on systems where
 * stray CRLFs sneak in via editors, paste, or transport.
 */
export function detectLineEndings(content: string): LineEndingType {
  const crlfCount = (content.match(/\r\n/g) ?? []).length
  const lfCount = (content.match(/(?<!\r)\n/g) ?? []).length
  const total = crlfCount + lfCount
  if (crlfCount === 0 || total === 0) return 'LF'
  return crlfCount / total >= 0.95 ? 'CRLF' : 'LF'
}

/**
 * Normalize any mix of CR, LF, and CRLF line endings to a single target.
 * Used to align `new_string` / `old_string` with the file's target ending
 * before splicing, so CRLF-tainted edits can't poison an LF file (or vice
 * versa).
 */
export function normalizeLineEndings(s: string, target: LineEndingType): string {
  const lfOnly = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return target === 'CRLF' ? lfOnly.replace(/\n/g, '\r\n') : lfOnly
}

/**
 * Write content normalized to the requested line ending.
 *
 * NOTE: `target` is the *desired* line ending for the output, not a
 * description of the input. The function will normalize any mix of CR /
 * LF / CRLF in `content` to `target` before writing.
 */
export function writeWithMetadata(
  filePath: string,
  content: string,
  encoding: BufferEncoding,
  target: LineEndingType,
): void {
  const toWrite = normalizeLineEndings(content, target)
  writeFileSync(filePath, toWrite, { encoding })
}

// ---------------------------------------------------------------------------
// .gitattributes-driven line ending policy
// ---------------------------------------------------------------------------

interface GitAttributeRule {
  pattern: string
  eol: LineEndingType | null
  /** True if `-text` (binary) was set. */
  binary: boolean
}

interface GitAttributesFile {
  /** Absolute directory containing `.gitattributes`. */
  dir: string
  rules: GitAttributeRule[]
  /** mtimeMs captured at parse time; used to invalidate the cache. */
  mtime: number
}

const gitAttributesCache = new Map<string, GitAttributesFile | null>()

/**
 * Resolve the effective line ending policy for a file by walking parent
 * directories looking for `.gitattributes` files, parsing any `eol=` /
 * `text=auto eol=` / `-text` directives, and returning the directive set
 * by the most-specific (deepest, last-matching) rule that applies.
 *
 * Returns `null` when no policy applies and callers should fall back to
 * disk detection.
 */
export function resolveLineEndingPolicy(filePath: string): LineEndingType | null {
  if (!isAbsolute(filePath)) return null

  const attrs = collectGitAttributes(dirname(filePath))
  if (attrs.length === 0) return null

  // Iterate from shallowest (closest to root) to deepest. Within each
  // file, later matching rules override earlier ones. Across files, the
  // deeper file overrides the shallower (since it's checked last).
  let resolved: LineEndingType | null = null
  for (const file of attrs) {
    const rel = toPosix(relative(file.dir, filePath))
    for (const rule of file.rules) {
      if (!matchesGitAttributesPattern(rule.pattern, rel)) continue
      if (rule.binary) {
        // Explicit binary — no line-ending normalization should apply.
        resolved = null
        continue
      }
      if (rule.eol) resolved = rule.eol
    }
  }
  return resolved
}

/** Clear the .gitattributes cache. Exposed for tests. */
export function clearGitAttributesCache(): void {
  gitAttributesCache.clear()
}

function collectGitAttributes(startDir: string): GitAttributesFile[] {
  const files: GitAttributesFile[] = []
  let current = startDir
  const { root } = parsePath(current)
  // Guard against infinite loop on degenerate inputs.
  for (let i = 0; i < 256; i++) {
    const cached = loadGitAttributes(current)
    if (cached) files.unshift(cached) // shallowest first
    if (current === root) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return files
}

function loadGitAttributes(dir: string): GitAttributesFile | null {
  const path = `${dir}${sep}.gitattributes`
  let mtime = 0
  try {
    if (!existsSync(path)) {
      gitAttributesCache.set(dir, null)
      return null
    }
    mtime = statSync(path).mtimeMs
  } catch {
    gitAttributesCache.set(dir, null)
    return null
  }

  const cached = gitAttributesCache.get(dir)
  if (cached && cached.mtime === mtime) return cached

  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    gitAttributesCache.set(dir, null)
    return null
  }

  const rules = parseGitAttributes(raw)
  const entry: GitAttributesFile = { dir, rules, mtime }
  gitAttributesCache.set(dir, entry)
  return entry
}

function parseGitAttributes(text: string): GitAttributeRule[] {
  const out: GitAttributeRule[] = []
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.replace(/^\s+|\s+$/g, '')
    if (!line || line.startsWith('#')) continue
    // Quoted patterns: "with spaces"
    const tokens: string[] = []
    let i = 0
    while (i < line.length) {
      while (i < line.length && /\s/.test(line[i]!)) i++
      if (i >= line.length) break
      if (line[i] === '"') {
        const end = line.indexOf('"', i + 1)
        if (end === -1) {
          tokens.push(line.slice(i + 1))
          break
        }
        tokens.push(line.slice(i + 1, end))
        i = end + 1
      } else {
        let j = i
        while (j < line.length && !/\s/.test(line[j]!)) j++
        tokens.push(line.slice(i, j))
        i = j
      }
    }
    if (tokens.length < 2) continue
    const pattern = tokens[0]!
    let eol: LineEndingType | null = null
    let binary = false
    for (let t = 1; t < tokens.length; t++) {
      const tok = tokens[t]!
      if (tok === '-text' || tok === 'binary') {
        binary = true
        continue
      }
      const eq = tok.indexOf('=')
      if (eq === -1) continue
      const key = tok.slice(0, eq).toLowerCase()
      const value = tok.slice(eq + 1).toLowerCase()
      if (key === 'eol') {
        if (value === 'lf') eol = 'LF'
        else if (value === 'crlf') eol = 'CRLF'
      }
    }
    out.push({ pattern, eol, binary })
  }
  return out
}

/**
 * Minimal `.gitattributes` glob matcher. Handles the patterns we actually
 * see in this repo and common variants: `*`, `*.ext`, `**`, `dir/**`,
 * `path/to/file`, and leading `/` (anchored). Not a full fnmatch — but
 * sufficient for line-ending policy resolution.
 */
export function matchesGitAttributesPattern(pattern: string, relPath: string): boolean {
  // Strip a single leading slash (anchored to the .gitattributes dir).
  let pat = pattern
  if (pat.startsWith('/')) pat = pat.slice(1)
  const anchored = pattern.startsWith('/') || pat.includes('/')

  // Build a regex from the glob. Order matters: handle ** before *.
  const re = globToRegex(pat)
  if (anchored) return re.test(relPath)
  // Unanchored patterns may match the basename or any path segment.
  if (re.test(relPath)) return true
  const segments = relPath.split('/')
  return segments.some((seg) => re.test(seg))
}

function globToRegex(glob: string): RegExp {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i += 2
        if (glob[i] === '/') i++ // consume the slash so `dir/**/file` works
      } else {
        re += '[^/]*'
        i++
      }
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else if (c === '.' || c === '+' || c === '(' || c === ')' || c === '|' ||
               c === '^' || c === '$' || c === '{' || c === '}' || c === '\\') {
      re += '\\' + c
      i++
    } else {
      re += c
      i++
    }
  }
  return new RegExp(`^${re}$`)
}

function toPosix(p: string): string {
  return p.split(sep).join('/')
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
