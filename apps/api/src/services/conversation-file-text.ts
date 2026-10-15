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
 *
 * The same pass builds the small display preview stored in `previewData` (see
 * `conversation-file-preview.ts`), so a file is parsed once for both the search
 * text and the card. The two are shaped differently on purpose: search wants
 * everything, the card wants a bounded, readable sample.
 */

import { unzipSync } from 'fflate'
import { prisma } from '../lib/prisma'
import {
  buildCodePreview,
  buildSlidesPreview,
  buildTablePreview,
  buildTextPreview,
  decodeXmlEntities,
  fitPreview,
  parseDelimited,
  parseSharedStrings,
  parseSheetGrid,
  parseSheetName,
  type AttachmentPreview,
} from './conversation-file-preview'

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

/** Extensions whose preview reads better as monospace with its own layout. */
const CODE_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'php', 'scala', 'lua', 'r', 'dart', 'vue', 'svelte', 'css', 'scss', 'less', 'sh', 'bash', 'zsh', 'sql',
  'graphql', 'gql', 'prisma', 'proto', 'tf', 'json', 'jsonl', 'ndjson', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
])

/** A bounded prefix of a delimited file is enough to show its shape. */
const PREVIEW_SCAN_BYTES = 8 * 1024

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

function isMarkup(mimeType: string, name: string): boolean {
  return /\.(html?|svg|xml)$/i.test(name) || /html|xml|svg/i.test(mimeType)
}

type DecodedText = { raw: string; search: string | null; markup: boolean }

/**
 * Decode a text-like file once. The preview needs `raw` because `tidy`
 * collapses runs of spaces and tabs, which destroys a source file's
 * indentation; search needs the tidied text.
 */
function decodeTextBytes(bytes: Uint8Array, mimeType: string, name: string): DecodedText | null {
  const slice = bytes.subarray(0, MAX_SCAN_BYTES)
  for (let i = 0; i < Math.min(slice.length, 8192); i++) if (slice[i] === 0) return null
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(slice)
  const replacements = (decoded.match(/\uFFFD/g) ?? []).length
  if (replacements > decoded.length / 100) return null
  const markup = isMarkup(mimeType, name)
  return { raw: decoded, search: tidy(markup ? decoded.replace(/<[^>]{0,200}>/g, ' ') : decoded), markup }
}

function xmlText(xml: string, paragraphTag: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<(w:br|a:br)\b[^>]*\/>/g, '\n')
      .replace(new RegExp(`</${paragraphTag}>`, 'g'), '\n')
      .replace(/<[^>]+>/g, ''),
  )
}

const DOCX_TEXT_PART = /^word\/(document|header\d*|footer\d*|footnotes)\.xml$/
const PPTX_TEXT_PART = /^ppt\/slides\/slide\d+\.xml$/
const XLSX_TEXT_PART = /^xl\/sharedStrings\.xml$/
/** Extra parts the spreadsheet preview needs; never joined into the search text. */
const XLSX_GRID_PART = /^xl\/(worksheets\/sheet1\.xml|workbook\.xml)$/

function officeTextPart(name: string, kind: OfficeKind): boolean {
  return kind === 'docx' ? DOCX_TEXT_PART.test(name)
    : kind === 'pptx' ? PPTX_TEXT_PART.test(name)
      : XLSX_TEXT_PART.test(name)
}

type OfficeZip = { parts: { name: string; text: string }[]; files: Record<string, Uint8Array> }

/**
 * Unzip an Office file once, keeping the text parts in the order the search
 * text needs plus (for spreadsheets) the worksheet the table preview reads.
 * The text assembly is deliberately unchanged from before the preview existed.
 */
function unzipOffice(bytes: Uint8Array, kind: OfficeKind): OfficeZip | null {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter: (f) =>
        (officeTextPart(f.name, kind) || (kind === 'xlsx' && XLSX_GRID_PART.test(f.name))) &&
        f.originalSize <= MAX_OFFICE_PART_BYTES,
    })
  } catch {
    return null
  }
  const order = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0)
  const names = Object.keys(files)
    .filter((name) => officeTextPart(name, kind))
    .sort((a, b) => {
      if (kind === 'docx') return (a.includes('document') ? 0 : 1) - (b.includes('document') ? 0 : 1) || a.localeCompare(b)
      return order(a) - order(b)
    })
  const paragraph = kind === 'docx' ? 'w:p' : kind === 'pptx' ? 'a:p' : 'si'
  const decoder = new TextDecoder()
  return { parts: names.map((n) => ({ name: n, text: xmlText(decoder.decode(files[n]), paragraph) })), files }
}

type ExtractedContent = { text: string | null; preview: AttachmentPreview | null }

const EMPTY: ExtractedContent = { text: null, preview: null }

async function pdfContent(bytes: Uint8Array): Promise<ExtractedContent> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('PDF extraction timed out')), PDF_TIMEOUT_MS)
  })
  try {
    const pdf = await Promise.race([getDocumentProxy(new Uint8Array(bytes)), timeout])
    const { text } = await Promise.race([extractText(pdf, { mergePages: true }), timeout])
    const pages = Number((pdf as { numPages?: number })?.numPages)
    const search = tidy(Array.isArray(text) ? text.join('\n') : text)
    return {
      text: search,
      preview: buildTextPreview(search ?? '', { pages: Number.isFinite(pages) ? pages : undefined }),
    }
  } finally {
    clearTimeout(timer)
  }
}

function officeContent(bytes: Uint8Array, kind: OfficeKind): ExtractedContent {
  const zip = unzipOffice(bytes, kind)
  if (!zip) return EMPTY
  const joined = zip.parts.map((part) => part.text).join('\n')
  const text = tidy(joined)
  return { text, preview: officePreview(zip, kind, text ?? joined) }
}

/** Slide 1 of a deck, the opening prose of a document, or a sheet's first rows. */
function officePreview(zip: OfficeZip, kind: OfficeKind, text: string): AttachmentPreview | null {
  if (kind === 'pptx') return buildSlidesPreview(zip.parts.map((part) => part.text))
  if (kind === 'docx') return buildTextPreview(text)
  const worksheet = zip.files['xl/worksheets/sheet1.xml']
  if (!worksheet) return null
  const decoder = new TextDecoder()
  const sharedStrings = zip.files['xl/sharedStrings.xml']
  const grid = parseSheetGrid(
    decoder.decode(worksheet),
    sharedStrings ? parseSharedStrings(decoder.decode(sharedStrings)) : [],
  )
  const workbook = zip.files['xl/workbook.xml']
  return buildTablePreview(grid.rows, {
    sheet: workbook ? parseSheetName(decoder.decode(workbook)) : undefined,
    truncated: grid.truncated,
  })
}

function textContent(bytes: Uint8Array, mimeType: string, name: string): ExtractedContent {
  const decoded = decodeTextBytes(bytes, mimeType, name)
  if (!decoded) return EMPTY
  const ext = extension(name)
  const delimited = ext === 'csv' || ext === 'tsv' || mimeType === 'text/csv' || mimeType === 'text/tab-separated-values'
  if (delimited) {
    const delimiter = ext === 'tsv' || /tab-separated/.test(mimeType) ? '\t' : ','
    const table = parseDelimited(decoded.raw.slice(0, PREVIEW_SCAN_BYTES), delimiter)
    return { text: decoded.search, preview: buildTablePreview(table.rows, { truncated: table.truncated }) }
  }
  const preview = decoded.markup || !CODE_EXT.has(ext)
    ? buildTextPreview(decoded.search ?? decoded.raw)
    : buildCodePreview(decoded.raw, { lang: ext })
  return { text: decoded.search, preview }
}

/**
 * The search text and the display preview for a file, from one read of its
 * bytes. Both are null for unsupported, binary, or unreadable files.
 */
export async function extractAttachmentContent(bytes: Uint8Array, mimeType: string, name: string): Promise<ExtractedContent> {
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) return EMPTY
  try {
    if (isPdf(mimeType, name)) return await pdfContent(bytes)
    const office = officeKind(mimeType, name)
    if (office) return officeContent(bytes, office)
    if (isTextLike(mimeType, name)) return textContent(bytes, mimeType, name)
  } catch {
    return EMPTY
  }
  return EMPTY
}

/** Searchable text for a file, or null for unsupported, binary, or unreadable files. */
export async function extractAttachmentText(bytes: Uint8Array, mimeType: string, name: string): Promise<string | null> {
  return (await extractAttachmentContent(bytes, mimeType, name)).text
}

/**
 * Extract and save an attachment's text and preview, then cut the text into the
 * chunks that file search and reading use. If the file is already attached to a
 * message, that message's search vector is dropped so the indexer re-embeds it
 * with the file text, and the message is re-published so a client that already
 * rendered the attachment picks up the preview it did not have.
 */
export async function extractAndStoreAttachmentText(
  attachmentId: string,
  bytes: Uint8Array,
  mimeType: string,
  name: string,
): Promise<string | null> {
  const { text, preview } = await extractAttachmentContent(bytes, mimeType, name)
  const fitted = fitPreview(preview).preview
  if (!text && !fitted) return null
  const row = await db.conversationAttachment.update({
    where: { id: attachmentId },
    data: { extractedText: text, previewData: fitted },
    select: { messageId: true },
  }).catch(() => null)
  if (!row) return text
  if (text) {
    const { chunkAttachment } = await import('./conversation-file-index')
    await chunkAttachment(attachmentId).catch(() => {})
  }
  if (row.messageId) {
    // The message was posted before this finished, so it went out without a
    // preview. Re-publish it now; the client patches the attachment in place.
    const { refreshAttachmentPreview } = await import('./conversation.service')
    await refreshAttachmentPreview(row.messageId).catch(() => {})
    if (text) {
      await db.conversationMessageEmbedding.deleteMany({ where: { messageId: row.messageId } }).catch(() => {})
    }
  }
  return text
}
