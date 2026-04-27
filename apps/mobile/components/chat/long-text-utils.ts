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
export const MAX_PASTED_TEXTS = 10

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

  const codePatterns =
    /^(import |export |const |let |var |function |class |def |fn |pub |package |#include|<\?php|from .+ import)/m
  if (codePatterns.test(trimmed)) return "code"

  const startsObj = trimmed.startsWith("{") || trimmed.startsWith("[")
  if (startsObj) {
    const endChar = text.trimEnd().slice(-1)
    if ((trimmed[0] === "{" && endChar === "}") || (trimmed[0] === "[" && endChar === "]")) {
      // Disambiguate: only call it JSON if the first line looks like a JSON
      // key/value or array element, not a code block (CSS, Go, Rust, etc.)
      const nlIdx = trimmed.indexOf("\n")
      const firstLine = trimmed.slice(0, nlIdx >= 0 ? nlIdx : 200)
      const looksLikeJson = /^\s*[\[{]\s*$/.test(firstLine) || /"[^"]*"\s*:/.test(firstLine)
      if (looksLikeJson) return "json"
    }
  }

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

/**
 * Minimum size (in characters) for a newly-inserted chunk to be treated
 * as a "paste large block" action. Below this, we leave the text in the
 * TextInput so short pastes (URLs, sentences) behave normally.
 */
export const LONG_PASTE_MIN_CHARS = 2_000

/**
 * A single pasted-text block that has been extracted from the TextInput
 * and is now rendered as a compact file-like chip.
 */
export interface PastedTextEntry {
  id: string
  content: string
  info: ContentSizeInfo
}

/**
 * Compare a previous and next value from an onChangeText event and, if a
 * single large chunk was inserted, return the inserted chunk along with
 * the text that should be restored to the input (i.e. prev minus any
 * selection that was replaced by the paste).
 *
 * Returns null if the insertion isn't large enough to qualify as a long
 * paste — in that case the caller should let the change through normally.
 */
export function extractLongPaste(
  prev: string,
  next: string
): { inserted: string; restored: string; info: ContentSizeInfo } | null {
  // Quick exit: if next is shorter or barely longer, no large paste happened.
  if (next.length <= prev.length) return null

  let prefixLen = 0
  const minLen = Math.min(prev.length, next.length)
  while (
    prefixLen < minLen &&
    prev.charCodeAt(prefixLen) === next.charCodeAt(prefixLen)
  ) {
    prefixLen++
  }

  let suffixLen = 0
  const maxSuffix = minLen - prefixLen
  while (
    suffixLen < maxSuffix &&
    prev.charCodeAt(prev.length - 1 - suffixLen) ===
      next.charCodeAt(next.length - 1 - suffixLen)
  ) {
    suffixLen++
  }

  const inserted = next.slice(prefixLen, next.length - suffixLen)
  // Threshold is on the *inserted* content, not the delta — this ensures
  // select-all-then-paste of a large block is still detected even when the
  // replaced selection shrinks the net delta below the threshold.
  if (inserted.length < LONG_PASTE_MIN_CHARS) return null

  const info = analyzeContent(inserted)
  if (!info.isLong) return null

  const restored =
    prev.slice(0, prefixLen) + prev.slice(prev.length - suffixLen)
  return { inserted, restored, info }
}

/**
 * Encode a text blob as a base64 data URL. Used to ship pasted long-text
 * blocks as file attachments so they render as separate file chips in the
 * chat transcript (ChatGPT-style) instead of being inlined as a single
 * long-text preview card.
 */
function encodeTextAsDataUrl(content: string, mediaType: string): string {
  try {
    const bytes = new TextEncoder().encode(content)
    let binary = ""
    // Process in chunks to avoid call-stack overflow with Function.apply
    for (let i = 0; i < bytes.length; i += 0x8000) {
      const chunk = bytes.subarray(i, i + 0x8000)
      for (let j = 0; j < chunk.length; j++) {
        binary += String.fromCharCode(chunk[j])
      }
    }
    // eslint-disable-next-line no-restricted-globals
    const b64 = (globalThis as any).btoa?.(binary)
    if (typeof b64 === "string") {
      return `data:${mediaType};base64,${b64}`
    }
  } catch {
    // fall through to the percent-encoded form
  }
  return `data:${mediaType};charset=utf-8,${encodeURIComponent(content)}`
}

const MEDIA_TYPE_BY_KIND: Record<ContentKind, string> = {
  json: "application/json",
  code: "text/plain",
  markdown: "text/markdown",
  plain: "text/plain",
}

const EXT_BY_KIND: Record<ContentKind, string> = {
  json: "json",
  code: "txt",
  markdown: "md",
  plain: "txt",
}

/**
 * Convert a pasted long-text entry to a file attachment so the chat can
 * render it as a discrete chip (one chip per paste) instead of merging
 * everything into a single blob.
 *
 * `kindIndex` is the 0-based occurrence of this kind within the current
 * batch (e.g. the second JSON paste has kindIndex=1). Use
 * `buildPastedAttachments` to compute these automatically.
 */
export function pastedEntryToAttachment(
  entry: PastedTextEntry,
  kindIndex = 0
): { dataUrl: string; name: string; type: string } {
  const { content, info } = entry
  const mediaType = MEDIA_TYPE_BY_KIND[info.kind]
  const ext = EXT_BY_KIND[info.kind]
  const base = `Pasted ${kindLabel(info.kind).toLowerCase()}`
  const name = kindIndex === 0 ? `${base}.${ext}` : `${base} (${kindIndex + 1}).${ext}`
  return {
    dataUrl: encodeTextAsDataUrl(content, mediaType),
    name,
    type: mediaType,
  }
}

/**
 * Convert all pasted entries to file attachments with per-kind numbering.
 */
export function buildPastedAttachments(
  entries: PastedTextEntry[]
): { dataUrl: string; name: string; type: string }[] {
  const kindCounts: Record<string, number> = {}
  return entries.map((entry) => {
    const k = entry.info.kind
    const idx = kindCounts[k] ?? 0
    kindCounts[k] = idx + 1
    return pastedEntryToAttachment(entry, idx)
  })
}
