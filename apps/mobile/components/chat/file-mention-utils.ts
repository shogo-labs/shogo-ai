// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * file-mention-utils — pure helpers for the @-file mention feature.
 *
 * Concerns kept here so they can be unit-tested without RN:
 *   1. detectMentionTrigger: scan text + caret position for an active "@query".
 *   2. score / rankFiles: lightweight Cmd-P style fuzzy ranker.
 *   3. dedup / cap helpers used when adding mentions and sending payloads.
 *   4. resolveMentionsToAttachments: shape file content into the existing
 *      FileAttachment carrier the chat pipeline already understands.
 *
 * Trigger rules (matches Cursor's @File semantics):
 *   - the `@` must be at start-of-input or directly after whitespace, `(`, `[`,
 *     `,` or newline (so `me@x.com` doesn't trigger).
 *   - between the `@` and the caret there must be no whitespace.
 *   - query characters must be in [A-Za-z0-9._/\-]; anything else aborts.
 *   - `@@` is treated as a literal escape and aborts detection.
 *   - while IME composition is active the picker stays closed (caller passes
 *     `isComposing: true`).
 */

export interface MentionTrigger {
  /** True when the picker should be shown. */
  active: boolean
  /** Search text after the `@` (may be empty). */
  query: string
  /** Index of the `@` character in the source text. */
  anchor: number
}

const TRIGGER_PRECEDING_CHARS = new Set([" ", "\t", "\n", "(", "[", ",", "{"])
// Allowed inside the query (path-like): letters, digits, dot, dash, slash, underscore.
const QUERY_CHAR_RE = /^[A-Za-z0-9._/\-]$/

export interface DetectOptions {
  /** When true (CJK IME mid-compose) detection is suppressed. */
  isComposing?: boolean
}

export function detectMentionTrigger(
  text: string,
  caret: number,
  opts: DetectOptions = {},
): MentionTrigger {
  const inactive: MentionTrigger = { active: false, query: "", anchor: -1 }
  if (opts.isComposing) return inactive
  if (caret < 1 || caret > text.length) return inactive

  // Walk back from caret looking for the most recent `@` with valid query chars.
  let i = caret - 1
  while (i >= 0) {
    const ch = text[i]
    if (ch === "@") break
    if (!QUERY_CHAR_RE.test(ch)) return inactive
    i--
    if (caret - i > 256) return inactive // sanity bound for runaway scans
  }
  if (i < 0 || text[i] !== "@") return inactive

  // Reject `@@` — explicit escape for a literal at-sign.
  if (i > 0 && text[i - 1] === "@") return inactive

  // Preceding char must be start-of-input or one of the safe boundaries.
  if (i > 0) {
    const prev = text[i - 1]
    if (!TRIGGER_PRECEDING_CHARS.has(prev)) return inactive
  }

  const query = text.slice(i + 1, caret)
  return { active: true, query, anchor: i }
}

// ─── Fuzzy ranking ──────────────────────────────────────────────────────────

export interface RankableFile {
  path: string
  /** Optional precomputed lower-cased path (perf). */
  lower?: string
}

/**
 * score — higher is better. 0 means no match.
 * Mirrors VSCode/Cursor ordering: basename exact > prefix > contains > path
 * contains > subsequence (Cmd-P style).
 */
export function score(path: string, query: string): number {
  if (!query) return 1
  const p = path.toLowerCase()
  const q = query.toLowerCase()
  const slash = p.lastIndexOf("/")
  const base = slash === -1 ? p : p.slice(slash + 1)

  if (base === q) return 110
  if (p.endsWith(q)) return 100
  if (base.startsWith(q)) return 80
  if (base.includes(q)) return 60
  if (p.includes(q)) return 40

  // Subsequence match (each query char appears in order somewhere in the path).
  let qi = 0
  for (let i = 0; i < p.length && qi < q.length; i++) {
    if (p[i] === q[qi]) qi++
  }
  return qi === q.length ? 20 : 0
}

export interface RankedResult<T extends RankableFile> {
  file: T
  score: number
}

export function rankFiles<T extends RankableFile>(
  files: T[],
  query: string,
  limit = 50,
): T[] {
  const scored: RankedResult<T>[] = []
  for (const f of files) {
    const s = score(f.path, query)
    if (s > 0) scored.push({ file: f, score: s })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.file.path.length - b.file.path.length
  })
  return scored.slice(0, limit).map((r) => r.file)
}

// ─── Mention model ──────────────────────────────────────────────────────────

export interface FileMention {
  /** Stable id used as React key + dedup key. */
  id: string
  /** Project-relative path (e.g. "src/App.tsx"). */
  path: string
  /** Display label — usually basename, but full path on collisions. */
  displayName: string
  /** Optional file extension (".tsx") for icon selection. */
  extension?: string
  /** Reserved: line range like "10-50". Parser-ready, UI to come later. */
  range?: { start: number; end: number }
}

export const MAX_MENTIONS = 10
export const MAX_MENTION_BYTES = 256 * 1024 // 256 KB per file
export const MAX_TOTAL_MENTION_BYTES = 1024 * 1024 // 1 MB total per send

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
  ".mp4", ".webm", ".mov", ".avi",
  ".zip", ".gz", ".tar", ".7z",
  ".pdf", ".woff", ".woff2", ".ttf", ".eot",
])

export function isBinaryPath(path: string): boolean {
  const dot = path.lastIndexOf(".")
  if (dot === -1) return false
  return BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

export function extOf(path: string): string {
  const dot = path.lastIndexOf(".")
  if (dot === -1) return ""
  const slash = path.lastIndexOf("/")
  if (dot < slash) return ""
  return path.slice(dot)
}

export function basename(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? path : path.slice(slash + 1)
}

export function dedupMention(
  existing: FileMention[],
  candidate: { path: string },
): boolean {
  return existing.some((m) => m.path === candidate.path)
}

let __mentionCounter = 0
export function makeMention(path: string, displayName?: string): FileMention {
  __mentionCounter++
  return {
    id: `mention-${Date.now()}-${__mentionCounter}`,
    path,
    displayName: displayName ?? basename(path),
    extension: extOf(path) || undefined,
  }
}

// ─── Resolution to FileAttachment ──────────────────────────────────────────

/**
 * Shape returned by the batch-read endpoint or per-file fallback. One per
 * mention; absent paths yield an entry with `error`.
 */
export interface FileMentionContent {
  path: string
  content?: string
  truncated?: boolean
  size?: number
  error?: "not_found" | "too_large" | "read_failed" | "binary" | "budget_exceeded" | "invalid_path"
}

export interface MentionAttachmentLike {
  dataUrl: string
  name: string
  type: string
  source?: "upload" | "mention"
  path?: string
}

export interface ResolveResult {
  attachments: MentionAttachmentLike[]
  /** Mentions that failed to resolve (so the UI can report / strip them). */
  failures: { path: string; error: string }[]
  /** Mentions truncated to fit the per-file cap. */
  truncated: string[]
  /** Total bytes of attached file content (post-truncation). */
  totalBytes: number
}

function summarizeFailure(error: string): string {
  switch (error) {
    case "not_found":
      return "not found"
    case "too_large":
      return "too large"
    case "binary":
      return "binary file"
    case "budget_exceeded":
      return "context budget exceeded"
    case "invalid_path":
      return "invalid path"
    default:
      return "couldn't be read"
  }
}

function utf8ByteLength(input: string): number {
  return new TextEncoder().encode(input).byteLength
}

function truncateUtf8(input: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(input)
  if (bytes.byteLength <= maxBytes) return input

  if (typeof TextDecoder === "function") {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, maxBytes))
  }

  // Old React Native runtimes may lack TextDecoder; this conservative
  // fallback preserves the cap for ASCII and only over-trims multibyte text.
  let used = 0
  let out = ""
  for (const ch of input) {
    const n = new TextEncoder().encode(ch).byteLength
    if (used + n > maxBytes) break
    out += ch
    used += n
  }
  return out
}

export function formatMentionIssueSummary(
  failures: ResolveResult["failures"],
  truncated: string[],
): string | null {
  if (failures.length === 0 && truncated.length === 0) return null

  const parts: string[] = []
  const byError = new Map<string, string[]>()
  for (const failure of failures) {
    const label = summarizeFailure(failure.error)
    const names = byError.get(label) ?? []
    names.push(failure.path.split("/").pop() || failure.path)
    byError.set(label, names)
  }

  for (const [label, names] of byError) {
    parts.push(`${names.length} ${label} (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", ..." : ""})`)
  }
  if (truncated.length > 0) {
    parts.push(`${truncated.length} truncated to fit context`)
  }

  return parts.length > 0 ? `Some tagged files were skipped or shortened: ${parts.join("; ")}` : null
}

/**
 * b64encode — RN/web safe base64 of a UTF-8 string.
 * Falls back to a manual encoder when neither btoa nor Buffer exist.
 */
function b64encode(input: string): string {
  // Prefer Buffer (bun, node, expo-cli)
  const B = (globalThis as any).Buffer
  if (B && typeof B.from === "function") {
    return B.from(input, "utf8").toString("base64")
  }
  if (typeof btoa === "function") {
    // btoa wants binary string; encode UTF-8 first.
    let bin = ""
    const bytes = new TextEncoder().encode(input)
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
  }
  // Last resort: very small manual encoder (RFC 4648).
  const bytes = new TextEncoder().encode(input)
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const triplet = (a << 16) | (b << 8) | c
    out += alphabet[(triplet >> 18) & 0x3f]
    out += alphabet[(triplet >> 12) & 0x3f]
    out += i + 1 < bytes.length ? alphabet[(triplet >> 6) & 0x3f] : "="
    out += i + 2 < bytes.length ? alphabet[triplet & 0x3f] : "="
  }
  return out
}

/**
 * buildMentionAttachments — pack resolved file contents into the same
 * FileAttachment shape uploads use, so the existing chat pipeline carries
 * them untouched. Enforces total payload cap and per-file cap.
 *
 * The marker prefix is a small header explaining to the model that the
 * blob is a tagged code reference, not a paste.
 */
export function buildMentionAttachments(
  contents: FileMentionContent[],
): ResolveResult {
  const result: ResolveResult = {
    attachments: [],
    failures: [],
    truncated: [],
    totalBytes: 0,
  }

  for (const c of contents) {
    if (c.error) {
      result.failures.push({ path: c.path, error: c.error })
      continue
    }
    let body = c.content ?? ""
    let trimmed = false
    if (utf8ByteLength(body) > MAX_MENTION_BYTES) {
      body = truncateUtf8(body, MAX_MENTION_BYTES) + "\n...[truncated]"
      trimmed = true
    }
    if (c.truncated) trimmed = true
    if (trimmed) result.truncated.push(c.path)

    const header =
      `// @-mention: ${c.path}` +
      (trimmed ? " (truncated)" : "") +
      "\n"
    const text = header + body
    const textBytes = utf8ByteLength(text)

    if (result.totalBytes + textBytes > MAX_TOTAL_MENTION_BYTES) {
      result.failures.push({ path: c.path, error: "budget_exceeded" })
      if (trimmed) {
        result.truncated = result.truncated.filter((path) => path !== c.path)
      }
      continue
    }

    result.totalBytes += textBytes
    result.attachments.push({
      dataUrl: `data:text/plain;base64,${b64encode(text)}`,
      name: c.path,
      type: "text/x-mention",
      source: "mention",
      path: c.path,
    })
  }

  return result
}
