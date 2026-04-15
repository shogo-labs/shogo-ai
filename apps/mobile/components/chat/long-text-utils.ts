// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Long-text detection utilities.
 *
 * Hybrid approach: evaluates character count, byte size, line count,
 * and content type to decide whether text should be treated as a
 * "large content" block and rendered via the preview-card / modal
 * pattern instead of inline.
 */

const CHAR_THRESHOLD = 5_000
const BYTE_THRESHOLD = 5 * 1024 // 5 KB
const LINE_THRESHOLD = 150

/**
 * Detected content type used for display hints (icon, label, syntax).
 */
export type ContentKind = "json" | "code" | "markdown" | "plain"

export interface ContentSizeInfo {
  chars: number
  bytes: number
  lines: number
  kind: ContentKind
  isLong: boolean
  /** Human-readable size label, e.g. "42.3 KB" */
  sizeLabel: string
}

function byteLength(text: string): number {
  if (typeof Blob !== "undefined") {
    return new Blob([text]).size
  }
  // Fallback: approximate via UTF-8 heuristic
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      i++ // skip surrogate pair
    } else bytes += 3
  }
  return bytes
}

function detectKind(text: string): ContentKind {
  // Only inspect the first 2KB for kind detection to stay fast on huge inputs
  const sample = text.length > 2048 ? text.slice(0, 2048) : text
  const trimmed = sample.trimStart()

  const startsObj = trimmed.startsWith("{") || trimmed.startsWith("[")
  if (startsObj) {
    // Quick heuristic: looks like JSON but don't parse the full string
    const endChar = text.trimEnd().slice(-1)
    if ((trimmed[0] === "{" && endChar === "}") || (trimmed[0] === "[" && endChar === "]")) {
      return "json"
    }
  }

  const codePatterns =
    /^(import |export |const |let |var |function |class |def |fn |pub |package |#include|<\?php|from .+ import)/m
  if (codePatterns.test(trimmed)) return "code"

  const mdPatterns = /^(#{1,6} |\* |- |\d+\. |\[.*\]\(.*\))/m
  if (mdPatterns.test(trimmed)) return "markdown"

  return "plain"
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Analyse text and decide whether it's "long" based on multiple heuristics.
 */
function countLines(text: string): number {
  let count = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++
  }
  return count
}

export function analyzeContent(text: string): ContentSizeInfo {
  const chars = text.length
  const bytes = byteLength(text)
  const lines = countLines(text)
  const kind = detectKind(text)

  // Structured data (JSON) tends to be heavier to render – use lower threshold
  const effectiveCharThreshold =
    kind === "json" ? CHAR_THRESHOLD * 0.5 : CHAR_THRESHOLD
  const effectiveByteThreshold =
    kind === "json" ? BYTE_THRESHOLD * 0.5 : BYTE_THRESHOLD

  const isLong =
    chars > effectiveCharThreshold ||
    bytes > effectiveByteThreshold ||
    lines > LINE_THRESHOLD

  return { chars, bytes, lines, kind, isLong, sizeLabel: formatSize(bytes) }
}

/**
 * Generate a short human-readable snippet (first N characters, preserving word boundaries).
 */
export function textSnippet(text: string, maxLen = 300): string {
  if (text.length <= maxLen) return text
  const cut = text.lastIndexOf(" ", maxLen)
  const end = cut > maxLen * 0.6 ? cut : maxLen
  return text.slice(0, end) + "…"
}

/**
 * Label for the content kind (shown in the preview card).
 */
export function kindLabel(kind: ContentKind): string {
  switch (kind) {
    case "json":
      return "JSON"
    case "code":
      return "Code"
    case "markdown":
      return "Markdown"
    default:
      return "Text"
  }
}

/**
 * Shared layout for long-text chips in inputs and message bubbles: capped width, left-aligned.
 */
export const LONG_TEXT_CHIP_LAYOUT_CLASS =
  "w-full max-w-[min(100%,20rem)] self-start"
