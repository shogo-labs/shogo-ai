// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Searchable text for chat attachments, stored in
 * `ConversationAttachment.extractedText`:
 *
 * - Text-like files (plain text, Markdown, CSV, JSON, source code, …)
 * - PDF (via unpdf)
 * - Word, PowerPoint, and Excel (.docx / .pptx / .xlsx, read from their XML)
 *
 * Other binary formats are skipped. Extraction runs after the upload
 * responds; see `extractAndStoreAttachmentText`.
 */

import { unzipSync } from 'fflate'
import { prisma } from '../lib/prisma'

const db = prisma as any

export const MAX_EXTRACTED_CHARS = 100_000
const MAX_SCAN_BYTES = 1024 * 1024
/** Larger documents are skipped rather than parsed. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
/** Cap on the uncompressed size of any Office XML part (zip-bomb guard). */
const MAX_OFFICE_PART_BYTES = 20 * 1024 * 1024
const PDF_TIMEOUT_MS = 20_000

const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|x-sh|javascript|typescript|x-typescript|sql|graphql|toml|x-ndjson|ld\+json))/i
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log',
  'xml', 'html', 'htm', 'svg', 'sql', 'graphql', 'gql', 'env', 'sh', 'bash', 'zsh',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'php', 'scala', 'lua', 'r', 'dart', 'vue', 'svelte', 'css', 'scss', 'less', 'prisma', 'proto', 'tf',
])

type OfficeKind = 'docx' | 'pptx' | 'xlsx'
const OFFICE_MIME: Record<string, OfficeKind> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}

function extension(name: string): string {
  return name.includes('.') ? name.toLowerCase().split('.').pop() ?? '' : ''
}

export function isTextLike(mimeType: string, name: string): boolean {
  if (TEXT_MIME.test(mimeType)) return true
  return TEXT_EXT.has(extension(name))
}

function isPdf(mimeType: string, name: string): boolean {
  return mimeType === 'application/pdf' || extension(name) === 'pdf'
}

function officeKind(mimeType: string, name: string): OfficeKind | null {
  const byMime = OFFICE_MIME[mimeType.toLowerCase()]
  if (byMime) return byMime
  const ext = extension(name)
  return ext === 'docx' || ext === 'pptx' || ext === 'xlsx' ? ext : null
}

/** Whether `extractAttachmentText` could produce text for this file. */
export function canExtract(mimeType: string, name: string, size: number): boolean {
  if (!size || size > MAX_DOCUMENT_BYTES) return false
  return isTextLike(mimeType, name) || isPdf(mimeType, name) || officeKind(mimeType, name) !== null
}

function tidy(text: string): string | null {
  const cleaned = text
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
  return cleaned ? cleaned.slice(0, MAX_EXTRACTED_CHARS) : null
}

function decodeText(bytes: Uint8Array, mimeType: string, name: string): string | null {
  const slice = bytes.subarray(0, MAX_SCAN_BYTES)
  for (let i = 0; i < Math.min(slice.length, 8192); i++) if (slice[i] === 0) return null
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(slice)
  const replacements = (decoded.match(/\uFFFD/g) ?? []).length
  if (replacements > decoded.length / 100) return null
  const markup = /\.(html?|svg|xml)$/i.test(name) || /html|xml|svg/i.test(mimeType)
  return tidy(markup ? decoded.replace(/<[^>]{0,200}>/g, ' ') : decoded)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function xmlText(xml: string, paragraphTag: string): string {
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<(w:br|a:br)\b[^>]*\/>/g, '\n')
    .replace(new RegExp(`</${paragraphTag}>`, 'g'), '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
}

function officeText(bytes: Uint8Array, kind: OfficeKind): string | null {
  const wanted = (name: string) =>
    kind === 'docx' ? /^word\/(document|header\d*|footer\d*|footnotes)\.xml$/.test(name)
      : kind === 'pptx' ? /^ppt\/slides\/slide\d+\.xml$/.test(name)
        : name === 'xl/sharedStrings.xml'
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, { filter: (f) => wanted(f.name) && f.originalSize <= MAX_OFFICE_PART_BYTES })
  } catch {
    return null
  }
  const order = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0)
  const names = Object.keys(files).sort((a, b) => {
    if (kind === 'docx') return (a.includes('document') ? 0 : 1) - (b.includes('document') ? 0 : 1) || a.localeCompare(b)
    return order(a) - order(b)
  })
  const paragraph = kind === 'docx' ? 'w:p' : kind === 'pptx' ? 'a:p' : 'si'
  const decoder = new TextDecoder()
  return tidy(names.map((n) => xmlText(decoder.decode(files[n]), paragraph)).join('\n'))
}

async function pdfText(bytes: Uint8Array): Promise<string | null> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('PDF extraction timed out')), PDF_TIMEOUT_MS)
  })
  try {
    const pdf = await Promise.race([getDocumentProxy(new Uint8Array(bytes)), timeout])
    const { text } = await Promise.race([extractText(pdf, { mergePages: true }), timeout])
    return tidy(Array.isArray(text) ? text.join('\n') : text)
  } finally {
    clearTimeout(timer)
  }
}

/** Searchable text for a file, or null for unsupported, binary, or unreadable files. */
export async function extractAttachmentText(bytes: Uint8Array, mimeType: string, name: string): Promise<string | null> {
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) return null
  try {
    if (isPdf(mimeType, name)) return await pdfText(bytes)
    const office = officeKind(mimeType, name)
    if (office) return officeText(bytes, office)
    if (isTextLike(mimeType, name)) return decodeText(bytes, mimeType, name)
  } catch {
    return null
  }
  return null
}

/**
 * Extract and save an attachment's text. If the file is already attached
 * to a message, that message's search vector is dropped so the indexer
 * re-embeds it with the file text.
 */
export async function extractAndStoreAttachmentText(
  attachmentId: string,
  bytes: Uint8Array,
  mimeType: string,
  name: string,
): Promise<string | null> {
  const text = await extractAttachmentText(bytes, mimeType, name)
  if (!text) return null
  const row = await db.conversationAttachment.update({
    where: { id: attachmentId },
    data: { extractedText: text },
    select: { messageId: true },
  }).catch(() => null)
  if (row?.messageId) await db.conversationMessageEmbedding.deleteMany({ where: { messageId: row.messageId } }).catch(() => {})
  return text
}
