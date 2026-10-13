// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Search and reading over chat files.
 *
 * A file's extracted text is split into overlapping chunks
 * (`conversation_attachment_chunks`) as soon as it's extracted. The channel
 * indexer embeds chunks when an embedding provider is configured; on Postgres
 * vectors are pgvector columns ranked in SQL, on desktop SQLite JSON arrays
 * ranked in process. Without vectors, search falls back to keywords over the
 * same chunks. Reading returns slices of the extracted text by character
 * offset, so agents can page through a document without downloading it.
 *
 * Every query is limited to the conversations the caller may read
 * (`conversation-file-access`), inside the query itself.
 */

import { prisma } from '../lib/prisma'
import { homeRegionWorkspaceWhere } from '../lib/region'
import { loadConversationFileBytes } from '../lib/conversation-files'
import { canExtract, extractAndStoreAttachmentText } from './conversation-file-text'
import { cosine, embeddingProvider } from './conversation-semantic'
import { VISIBLE_FILE_WHERE, loadVisibleFile, readableConversationIds, type FilePrincipal } from './conversation-file-access'

const db = prisma as any
const isLocalMode = () => process.env.SHOGO_LOCAL_MODE === 'true'

export const CHUNK_CHARS = 1500
export const CHUNK_OVERLAP = 200
const EMBED_BATCH = 64
const CHUNK_BATCH = 20
const MAX_SCAN = 5000
const MAX_PG_DIMS = 16_000
export const DEFAULT_READ_CHARS = 20_000
export const MAX_READ_CHARS = 60_000
const SNIPPET_CHARS = 400

// ─── Chunking ────────────────────────────────────────────────────────────────

export interface TextChunk {
  text: string
  charStart: number
  charEnd: number
}

/** Overlapping slices of about `size` characters, broken at a newline or space when one is near. */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): TextChunk[] {
  const chunks: TextChunk[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + size, text.length)
    if (end < text.length) {
      const window = text.slice(start + Math.floor(size / 2), end)
      const breakAt = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '))
      if (breakAt > 0) end = start + Math.floor(size / 2) + breakAt + 1
    }
    const slice = text.slice(start, end)
    if (slice.trim()) chunks.push({ text: slice, charStart: start, charEnd: end })
    if (end >= text.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks
}

/** Replace a file's chunks with ones cut from its current extracted text. Returns the chunk count. */
export async function chunkAttachment(attachmentId: string): Promise<number> {
  const row = await db.conversationAttachment.findUnique({
    where: { id: attachmentId },
    select: { id: true, conversationId: true, extractedText: true, conversation: { select: { workspaceId: true } } },
  })
  if (!row?.conversation) return 0
  const chunks = row.extractedText ? chunkText(row.extractedText) : []
  await db.conversationAttachmentChunk.deleteMany({ where: { attachmentId } })
  if (!chunks.length) return 0
  await db.conversationAttachmentChunk.createMany({
    data: chunks.map((c, idx) => ({
      attachmentId,
      conversationId: row.conversationId,
      workspaceId: row.conversation.workspaceId,
      idx,
      text: c.text,
      charStart: c.charStart,
      charEnd: c.charEnd,
    })),
  })
  return chunks.length
}

function homeAttachmentWhere(): Record<string, unknown> {
  const home = homeRegionWorkspaceWhere()
  return home ? { conversation: { workspace: home } } : {}
}

/** Chunk files that have text but no chunks yet (files shared before chunking existed). */
export async function chunkPendingAttachments(batch = CHUNK_BATCH): Promise<number> {
  const rows = await db.conversationAttachment.findMany({
    where: { ...homeAttachmentWhere(), extractedText: { not: null }, chunks: { none: {} } },
    orderBy: { createdAt: 'desc' },
    take: batch,
    select: { id: true },
  })
  for (const row of rows) await chunkAttachment(row.id).catch(() => {})
  return rows.length
}

// ─── Embedding ───────────────────────────────────────────────────────────────

function vectorLiteral(v: number[]): string | null {
  if (!v.length || v.length > MAX_PG_DIMS || !v.every(Number.isFinite) || v.every((x) => x === 0)) return null
  return `[${v.join(',')}]`
}

/** Embed chunks the indexer hasn't processed yet. Returns how many were processed. */
export async function embedPendingChunks(batch = EMBED_BATCH): Promise<number> {
  const provider = embeddingProvider()
  if (!provider) return 0
  const home = homeRegionWorkspaceWhere()
  const rows = await db.conversationAttachmentChunk.findMany({
    where: { model: null, ...(home ? { attachment: { conversation: { workspace: home } } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: batch,
    select: { id: true, text: true },
  })
  if (!rows.length) return 0
  const vectors = await provider.embed(rows.map((r: any) => r.text))
  for (let i = 0; i < rows.length; i++) {
    const vector = vectors[i] ?? []
    if (isLocalMode()) {
      await db.conversationAttachmentChunk.update({
        where: { id: rows[i].id },
        data: { model: provider.model, embedding: vector.length ? JSON.stringify(vector) : null },
      }).catch(() => {})
    } else {
      await db.$executeRawUnsafe(
        `UPDATE conversation_attachment_chunks SET model = $1, embedding = $2::vector WHERE id = $3`,
        provider.model, vectorLiteral(vector), rows[i].id,
      ).catch(() => {})
    }
  }
  return rows.length
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface FileHit {
  fileId: string
  name: string
  mimeType: string
  size: number
  conversationId: string
  messageId: string
  /** Where the match is in the file's text, for reading from there; null for a name match. */
  charStart: number | null
  snippet: string | null
  score: number
  match: 'semantic' | 'keyword' | 'name'
}

type ChunkScore = { id: string; score: number }

function parseVector(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number)
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(Number) : []
  } catch {
    return []
  }
}

async function nearestChunksSqlite(model: string, conversationIds: string[], query: number[]): Promise<ChunkScore[]> {
  const rows = await db.conversationAttachmentChunk.findMany({
    where: { model, embedding: { not: null }, conversationId: { in: conversationIds }, attachment: VISIBLE_FILE_WHERE },
    orderBy: { createdAt: 'desc' },
    take: MAX_SCAN,
    select: { id: true, embedding: true },
  })
  return rows.map((r: any) => ({ id: r.id, score: cosine(query, parseVector(r.embedding)) }))
}

async function nearestChunksPostgres(model: string, conversationIds: string[], query: number[], limit: number): Promise<ChunkScore[]> {
  const literal = vectorLiteral(query)
  if (!literal) return []
  const dims = query.length
  const distance = `c.embedding::vector(${dims}) <=> $1::vector(${dims})`
  const rows = await db.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`)
    return tx.$queryRawUnsafe(
      `SELECT c.id AS id, 1 - (${distance}) AS score
       FROM conversation_attachment_chunks c
       JOIN conversation_attachments a ON a.id = c."attachmentId"
       JOIN conversation_messages m ON m.id = a."messageId"
       WHERE c.model = $2 AND c.embedding IS NOT NULL AND vector_dims(c.embedding) = ${dims}
         AND c."conversationId" = ANY($3::text[]) AND m."deletedAt" IS NULL
       ORDER BY ${distance}
       LIMIT $4`,
      literal, model, conversationIds, limit,
    )
  })
  return rows.map((r: any) => ({ id: r.id, score: Number(r.score) }))
}

function keywordTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().replace(/[^\p{L}\p{N}\s._-]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3))].slice(0, 8)
}

const contains = (term: string) => (isLocalMode() ? { contains: term } : { contains: term, mode: 'insensitive' as const })

async function keywordChunks(conversationIds: string[], terms: string[], limit: number): Promise<ChunkScore[]> {
  if (!terms.length) return []
  const rows = await db.conversationAttachmentChunk.findMany({
    where: { conversationId: { in: conversationIds }, attachment: VISIBLE_FILE_WHERE, OR: terms.map((t) => ({ text: contains(t) })) },
    orderBy: { createdAt: 'desc' },
    take: limit * 10,
    select: { id: true, text: true },
  })
  return rows.map((r: any) => {
    const lower = String(r.text).toLowerCase()
    return { id: r.id, score: terms.filter((t) => lower.includes(t)).length / terms.length }
  })
}

function snippetAround(text: string, terms: string[]): string {
  const lower = text.toLowerCase()
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, at - SNIPPET_CHARS / 4)
  const snippet = text.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${snippet}${start + SNIPPET_CHARS < text.length ? '…' : ''}`
}

/**
 * Files matching `query` in the conversations the principal may read: by
 * meaning when vectors exist, then by keywords in the text, then by file name.
 * One hit per file, best match first.
 */
export async function searchFiles(
  principal: FilePrincipal,
  workspaceId: string,
  query: string,
  opts: { conversationId?: string; limit?: number; minScore?: number; semanticOnly?: boolean; queryVector?: number[] } = {},
): Promise<{ results: FileHit[]; semantic: boolean }> {
  const q = query.trim()
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50)
  if (!q) return { results: [], semantic: false }
  const conversationIds = await readableConversationIds(principal, workspaceId, { conversationId: opts.conversationId })
  if (!conversationIds.length) return { results: [], semantic: false }

  const scores = new Map<string, { score: number; match: FileHit['match'] }>()
  const provider = embeddingProvider()
  let semantic = false
  if (provider) {
    const vector = opts.queryVector ?? (await provider.embed([q.slice(0, 6000)]).catch(() => [[] as number[]]))[0]
    if (vector?.length) {
      semantic = true
      const nearest = isLocalMode()
        ? await nearestChunksSqlite(provider.model, conversationIds, vector)
        : await nearestChunksPostgres(provider.model, conversationIds, vector, limit * 4)
      for (const s of nearest) if (s.score >= (opts.minScore ?? 0.2)) scores.set(s.id, { score: s.score, match: 'semantic' })
    }
  }
  const terms = keywordTerms(q)
  if (!opts.semanticOnly) {
    for (const s of await keywordChunks(conversationIds, terms, limit)) {
      // Keyword hits rank below semantic ones.
      if (!scores.has(s.id)) scores.set(s.id, { score: s.score * 0.5, match: 'keyword' })
    }
  }

  const chunkRows = scores.size
    ? await db.conversationAttachmentChunk.findMany({
        where: { id: { in: [...scores.keys()] } },
        select: { id: true, attachmentId: true, text: true, charStart: true },
      })
    : []
  const best = new Map<string, { chunk: any; score: number; match: FileHit['match'] }>()
  for (const chunk of chunkRows) {
    const s = scores.get(chunk.id)!
    const current = best.get(chunk.attachmentId)
    if (!current || s.score > current.score) best.set(chunk.attachmentId, { chunk, score: s.score, match: s.match })
  }

  const byName = opts.semanticOnly ? [] : await db.conversationAttachment.findMany({
    where: { conversationId: { in: conversationIds }, ...VISIBLE_FILE_WHERE, OR: [{ name: contains(q) }, ...terms.map((t) => ({ name: contains(t) }))] },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true },
  })
  for (const row of byName) if (!best.has(row.id)) best.set(row.id, { chunk: null, score: 0.1, match: 'name' })

  const ranked = [...best.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit)
  if (!ranked.length) return { results: [], semantic }
  const files = await db.conversationAttachment.findMany({
    where: { id: { in: ranked.map(([id]) => id) } },
    select: { id: true, name: true, mimeType: true, size: true, conversationId: true, messageId: true },
  })
  const fileById = new Map(files.map((f: any) => [f.id, f]))
  const results: FileHit[] = []
  for (const [id, hit] of ranked) {
    const file: any = fileById.get(id)
    if (!file) continue
    results.push({
      fileId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      conversationId: file.conversationId,
      messageId: file.messageId,
      charStart: hit.chunk?.charStart ?? null,
      snippet: hit.chunk ? snippetAround(hit.chunk.text, terms) : null,
      score: hit.score,
      match: hit.match,
    })
  }
  return { results, semantic }
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export interface FileText {
  fileId: string
  name: string
  mimeType: string
  /** Null for files without extractable text (images, archives, other binaries). */
  text: string | null
  offset: number
  totalChars: number
  nextOffset: number | null
}

/** A slice of the file's extracted text, extracting it first when that hasn't happened yet. */
export async function readFileText(
  principal: FilePrincipal,
  workspaceId: string,
  fileId: string,
  opts: { offset?: number; limit?: number } = {},
): Promise<FileText> {
  const { attachment } = await loadVisibleFile(principal, workspaceId, fileId)
  let text: string | null = attachment.extractedText ?? null
  if (text === null && canExtract(attachment.mimeType, attachment.name, attachment.size)) {
    const bytes = await loadConversationFileBytes(attachment.storageKey).catch(() => null)
    if (bytes) text = await extractAndStoreAttachmentText(attachment.id, bytes, attachment.mimeType, attachment.name)
  }
  const base = { fileId: attachment.id, name: attachment.name, mimeType: attachment.mimeType }
  if (text === null) return { ...base, text: null, offset: 0, totalChars: 0, nextOffset: null }
  const offset = Math.min(Math.max(Math.floor(opts.offset ?? 0), 0), text.length)
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? DEFAULT_READ_CHARS), 1), MAX_READ_CHARS)
  const end = Math.min(offset + limit, text.length)
  return { ...base, text: text.slice(offset, end), offset, totalChars: text.length, nextOffset: end < text.length ? end : null }
}
