// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Semantic search and "ask the workspace" over team chat.
 *
 * A background indexer embeds recent messages (text plus attachment names
 * and extracted file text) and stores the vectors in
 * `conversation_message_embeddings`. On Postgres they are pgvector columns
 * ranked in SQL (with an HNSW index for 1536-dimension models); on desktop
 * SQLite they are JSON arrays ranked in process over the most recent
 * `MAX_SCAN` vectors.
 *
 * Embeddings come from the local LLM server when `LOCAL_LLM_BASE_URL` and
 * `LOCAL_EMBEDDING_MODEL` are set, otherwise OpenAI when `OPENAI_API_KEY`
 * is set. Without either, semantic search is unavailable and "ask" falls
 * back to keyword search for its sources.
 */

import { prisma } from '../lib/prisma'
import { homeRegionWorkspaceWhere } from '../lib/region'
import { MESSAGE_INCLUDE, serializeMessage, ConversationError } from './conversation.service'
import { searchMessages, type SearchResult } from './conversation-search'
import { loadMentionNames, runWorkspaceAgentPrompt } from './conversation-agent-dispatcher'
import { renderMentionsAsText, type MentionNames } from './conversation-mentions'

const db = prisma as any
const isLocalMode = () => process.env.SHOGO_LOCAL_MODE === 'true'

const INDEX_BATCH = 64
const INDEX_WINDOW_MS = 90 * 24 * 60 * 60_000
const MAX_EMBED_CHARS = 6000
const MAX_SCAN = 5000
const ASK_SOURCES = 12

export interface EmbeddingProvider {
  model: string
  embed(texts: string[]): Promise<number[][]>
}

let providerOverride: EmbeddingProvider | null | undefined

export function _setEmbeddingProviderForTests(provider: EmbeddingProvider | null | undefined): void {
  providerOverride = provider
}

async function postEmbeddings(
  url: string,
  headers: Record<string, string>,
  body: { model: string; dimensions?: number },
  input: string[],
): Promise<number[][]> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ ...body, input }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Embedding request failed (${res.status})`)
  const json: any = await res.json()
  const data: any[] = Array.isArray(json?.data) ? json.data : []
  return data
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => (Array.isArray(d.embedding) ? d.embedding.map(Number) : []))
}

export function embeddingProvider(): EmbeddingProvider | null {
  if (providerOverride !== undefined) return providerOverride
  const localBase = process.env.LOCAL_LLM_BASE_URL
  const localModel = process.env.LOCAL_EMBEDDING_MODEL
  if (localBase && localModel) {
    const url = `${localBase.replace(/\/$/, '')}/v1/embeddings`
    const dims = process.env.LOCAL_EMBEDDING_DIMENSIONS ? parseInt(process.env.LOCAL_EMBEDDING_DIMENSIONS, 10) : undefined
    return { model: localModel, embed: (texts) => postEmbeddings(url, {}, { model: localModel, dimensions: dims }, texts) }
  }
  const key = process.env.OPENAI_API_KEY
  if (key) {
    const model = process.env.CHANNELS_EMBEDDING_MODEL || 'text-embedding-3-small'
    return {
      model,
      embed: (texts) => postEmbeddings('https://api.openai.com/v1/embeddings', { authorization: `Bearer ${key}` }, { model }, texts),
    }
  }
  return null
}

/** The text a message is embedded and cited by: body, then attachment names and file text. */
function documentFor(row: any, names: MentionNames): string {
  const parts = [renderMentionsAsText(String(row.text ?? ''), names)]
  for (const a of row.attachments ?? []) {
    parts.push(`[file: ${a.name}]`)
    if (a.extractedText) parts.push(String(a.extractedText).slice(0, 2000))
  }
  return parts.join('\n').replace(/\s+\n/g, '\n').trim().slice(0, MAX_EMBED_CHARS)
}

/**
 * Embed a batch of messages that don't have a vector yet. Returns how many
 * were indexed. Messages with no text are stored with an empty vector so
 * they aren't picked up again.
 */
export async function indexPendingMessages(now = new Date(), batch = INDEX_BATCH): Promise<number> {
  const provider = embeddingProvider()
  if (!provider) return 0
  // Embeddings are written in the message's home region only (the embeddings
  // table replicates; a peer region indexing the same message would conflict).
  const home = homeRegionWorkspaceWhere()
  const rows = await db.conversationMessage.findMany({
    where: {
      ...(home ? { conversation: { workspace: home } } : {}),
      deletedAt: null,
      authorType: { not: 'system' },
      embedding: { is: null },
      createdAt: { gte: new Date(now.getTime() - INDEX_WINDOW_MS) },
      OR: [{ agentStatus: null }, { agentStatus: { not: 'running' } }],
    },
    orderBy: { createdAt: 'desc' },
    take: batch,
    select: {
      id: true, workspaceId: true, text: true,
      attachments: { select: { name: true, extractedText: true } },
    },
  })
  if (!rows.length) return 0

  const byWorkspace = new Map<string, any[]>()
  for (const r of rows) byWorkspace.set(r.workspaceId, [...(byWorkspace.get(r.workspaceId) ?? []), r])
  const docs: { row: any; text: string }[] = []
  for (const [workspaceId, list] of byWorkspace) {
    const names = await loadMentionNames(workspaceId, list.map((r) => String(r.text ?? '')))
    for (const row of list) docs.push({ row, text: documentFor(row, names) })
  }

  const withText = docs.filter((d) => d.text)
  const vectors = withText.length ? await provider.embed(withText.map((d) => d.text)) : []
  const vectorFor = new Map(withText.map((d, i) => [d.row.id, vectors[i] ?? []]))
  for (const { row } of docs) {
    await storeEmbedding(row, provider.model, vectorFor.get(row.id) ?? []).catch(() => {})
  }
  return docs.length
}

const MAX_PG_DIMS = 16_000

/** pgvector text form, or null when the vector can't be ranked (empty, all zeros, or not finite). */
function vectorLiteral(v: number[]): string | null {
  if (!v.length || v.length > MAX_PG_DIMS || !v.every(Number.isFinite) || v.every((x) => x === 0)) return null
  return `[${v.join(',')}]`
}

async function storeEmbedding(row: { id: string; workspaceId: string }, model: string, vector: number[]): Promise<void> {
  if (isLocalMode()) {
    await db.conversationMessageEmbedding.create({
      data: { messageId: row.id, workspaceId: row.workspaceId, model, embedding: vector },
    })
    return
  }
  await db.$executeRawUnsafe(
    `INSERT INTO conversation_message_embeddings (id, "messageId", "workspaceId", model, embedding)
     VALUES ($1, $2, $3, $4, $5::vector)
     ON CONFLICT ("messageId") DO NOTHING`,
    crypto.randomUUID(), row.id, row.workspaceId, model, vectorLiteral(vector),
  )
}

type Scored = { id: string; score: number }

async function nearestSqlite(workspaceId: string, model: string, conversationIds: string[], query: number[]): Promise<Scored[]> {
  const vectors = await db.conversationMessageEmbedding.findMany({
    where: { workspaceId, model, message: { conversationId: { in: conversationIds }, deletedAt: null } },
    orderBy: { createdAt: 'desc' },
    take: MAX_SCAN,
    select: { messageId: true, embedding: true },
  })
  return vectors.map((v: any) => ({ id: v.messageId, score: cosine(query, v.embedding ?? []) }))
}

/**
 * Nearest neighbours in SQL. The `vector(n)` cast and `vector_dims` filter
 * match the partial HNSW index for 1536 dimensions; other sizes scan the
 * workspace's rows exactly. Iterative scan keeps filling results when the
 * index's first candidates are in conversations the viewer can't read.
 */
async function nearestPostgres(workspaceId: string, model: string, conversationIds: string[], query: number[], limit: number): Promise<Scored[]> {
  const literal = vectorLiteral(query)
  if (!literal) return []
  const dims = query.length
  const distance = `e.embedding::vector(${dims}) <=> $1::vector(${dims})`
  const rows = await db.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`)
    return tx.$queryRawUnsafe(
      `SELECT e."messageId" AS id, 1 - (${distance}) AS score
       FROM conversation_message_embeddings e
       JOIN conversation_messages m ON m.id = e."messageId"
       WHERE e."workspaceId" = $2 AND e.model = $3 AND vector_dims(e.embedding) = ${dims}
         AND m."conversationId" = ANY($4::text[]) AND m."deletedAt" IS NULL
       ORDER BY ${distance}
       LIMIT $5`,
      literal, workspaceId, model, conversationIds, limit,
    )
  })
  return rows.map((r: any) => ({ id: r.id, score: Number(r.score) }))
}

export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

async function readableConversationIds(workspaceId: string, viewerId: string): Promise<string[]> {
  const rows = await db.conversation.findMany({
    where: { workspaceId, OR: [{ kind: { in: ['public', 'activity'] } }, { members: { some: { userId: viewerId } } }] },
    select: { id: true },
  })
  return rows.map((r: any) => r.id)
}

export interface SemanticResult extends SearchResult {
  score: number
}

export async function semanticSearch(
  workspaceId: string,
  viewerId: string,
  query: string,
  opts: { limit?: number; minScore?: number } = {},
): Promise<{ results: SemanticResult[]; available: boolean }> {
  const provider = embeddingProvider()
  const text = query.trim()
  if (!provider) return { results: [], available: false }
  if (!text) return { results: [], available: true }
  const [queryVector] = await provider.embed([text.slice(0, MAX_EMBED_CHARS)])
  if (!queryVector?.length) return { results: [], available: true }

  const conversationIds = await readableConversationIds(workspaceId, viewerId)
  if (!conversationIds.length) return { results: [], available: true }
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50)
  const minScore = opts.minScore ?? 0.2
  const candidates = isLocalMode()
    ? await nearestSqlite(workspaceId, provider.model, conversationIds, queryVector)
    : await nearestPostgres(workspaceId, provider.model, conversationIds, queryVector, limit)
  const scored = candidates
    .filter((s) => s.score >= minScore)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, limit)
  if (!scored.length) return { results: [], available: true }

  const rows = await db.conversationMessage.findMany({
    where: { id: { in: scored.map((s: any) => s.id) } },
    include: { ...MESSAGE_INCLUDE, conversation: { select: { id: true, kind: true, name: true, slug: true } } },
  })
  const byId = new Map(rows.map((r: any) => [r.id, r]))
  const results: SemanticResult[] = []
  for (const s of scored) {
    const row: any = byId.get(s.id)
    if (row) results.push({ message: serializeMessage(row), conversation: row.conversation, score: s.score })
  }
  return { results, available: true }
}

// ─── Ask the workspace ──────────────────────────────────────────────────────

export interface AskCitation extends SearchResult {
  n: number
  cited: boolean
}

export interface AskResult {
  answer: string
  citations: AskCitation[]
  semantic: boolean
}

type AskRunner = (args: { workspaceId: string; userId: string; prompt: string; label: string }) => Promise<{ text: string; failed: boolean; error?: string }>
let askRunner: AskRunner = runWorkspaceAgentPrompt

export function _setAskRunnerForTests(runner: AskRunner | null): void {
  askRunner = runner ?? runWorkspaceAgentPrompt
}

function where(c: SearchResult['conversation']): string {
  if (c.kind === 'dm' || c.kind === 'group_dm') return 'a direct message'
  return `#${c.name ?? c.slug ?? 'channel'}`
}

/**
 * Answer a question from the viewer's readable messages. Sources come from
 * semantic search when available plus keyword search; the agent is told to
 * answer only from those sources and cite them as [n].
 */
export async function askWorkspace(workspaceId: string, viewerId: string, question: string): Promise<AskResult> {
  const q = question.trim()
  if (!q) throw new ConversationError(400, 'invalid_question', 'Ask a question')
  if (q.length > 1000) throw new ConversationError(400, 'invalid_question', 'Questions are limited to 1,000 characters')

  const semantic = await semanticSearch(workspaceId, viewerId, q, { limit: ASK_SOURCES }).catch(() => ({ results: [], available: false }))
  const words = [...new Set(q.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter((w) => w.length > 3))]
  const keyword = words.length
    ? await searchMessages(workspaceId, viewerId, words.join(' or '), { limit: 8, matchAny: true })
      .catch(() => ({ results: [] as SearchResult[] }))
    : { results: [] as SearchResult[] }
  const seen = new Set<string>()
  const sources: SearchResult[] = []
  for (const r of [...semantic.results, ...keyword.results]) {
    if (seen.has(r.message.id) || sources.length >= ASK_SOURCES) continue
    seen.add(r.message.id)
    sources.push({ message: r.message, conversation: r.conversation })
  }
  if (!sources.length) {
    return { answer: "I couldn't find anything in your conversations about that.", citations: [], semantic: semantic.available }
  }

  const names = await loadMentionNames(workspaceId, sources.map((s) => s.message.text))
  const lines = sources.map((s, i) => {
    const m = s.message
    const author = m.author?.name ?? (m.authorType === 'agent' ? `${(m.authorAgent as any)?.name ?? 'Agent'} (agent)` : 'Someone')
    const when = new Date(s.message.createdAt).toISOString().slice(0, 16).replace('T', ' ')
    const files = m.attachments.map((a: { name: string }) => ` [file: ${a.name}]`).join('')
    return `[${i + 1}] ${author} in ${where(s.conversation)} at ${when} UTC: ${renderMentionsAsText(s.message.text, names).slice(0, 1500)}${files}`
  })
  const prompt = [
    'Answer my question using only the team chat messages below. Do not use tools.',
    'Cite the messages you rely on inline as [1], [2], etc. If the messages do not answer the question, say so briefly.',
    'Keep it short and use Markdown.',
    '',
    `Question: ${q}`,
    '',
    'Messages:',
    ...lines,
  ].join('\n')

  const result = await askRunner({ workspaceId, userId: viewerId, prompt, label: `Ask: ${q.slice(0, 60)}` })
  if (result.failed) throw new ConversationError(502, 'agent_failed', result.error ?? 'The agent could not answer that')
  const cited = new Set([...result.text.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])))
  return {
    answer: result.text,
    citations: sources.map((s, i) => ({ ...s, n: i + 1, cited: cited.has(i + 1) })),
    semantic: semantic.available,
  }
}
