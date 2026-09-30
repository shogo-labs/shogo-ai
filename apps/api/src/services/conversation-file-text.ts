// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Searchable text for chat attachments. Text-like files (plain text,
 * Markdown, CSV, JSON, source code, …) are decoded and stored in
 * `ConversationAttachment.extractedText`; binary formats are skipped.
 */

export const MAX_EXTRACTED_CHARS = 100_000
const MAX_SCAN_BYTES = 1024 * 1024

const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|x-sh|javascript|typescript|x-typescript|sql|graphql|toml|x-ndjson|ld\+json))/i
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log',
  'xml', 'html', 'htm', 'svg', 'sql', 'graphql', 'gql', 'env', 'sh', 'bash', 'zsh',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'php', 'scala', 'lua', 'r', 'dart', 'vue', 'svelte', 'css', 'scss', 'less', 'prisma', 'proto', 'tf',
])

export function isTextLike(mimeType: string, name: string): boolean {
  if (TEXT_MIME.test(mimeType)) return true
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return name.includes('.') && TEXT_EXT.has(ext)
}

/** Decoded, whitespace-collapsed text, or null for binary or unsupported files. */
export function extractAttachmentText(bytes: Uint8Array, mimeType: string, name: string): string | null {
  if (!isTextLike(mimeType, name) || !bytes.length) return null
  const slice = bytes.subarray(0, MAX_SCAN_BYTES)
  let zeros = 0
  for (let i = 0; i < Math.min(slice.length, 8192); i++) if (slice[i] === 0) zeros++
  if (zeros > 0) return null
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(slice)
  const replacements = (decoded.match(/\uFFFD/g) ?? []).length
  if (replacements > decoded.length / 100) return null
  const text = decoded
    .replace(/<[^>]{0,200}>/g, (tag) => (/\.(html?|svg|xml)$/i.test(name) || /html|xml|svg/i.test(mimeType) ? ' ' : tag))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
  return text ? text.slice(0, MAX_EXTRACTED_CHARS) : null
}
