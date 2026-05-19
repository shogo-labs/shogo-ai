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
