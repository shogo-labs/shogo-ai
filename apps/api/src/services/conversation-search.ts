// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Message search across the conversations a person can read.
 *
 *   ship friday in:#launch from:@ada     words plus filters
 *   "exact phrase" -excluded             websearch syntax (Postgres)
 *   from:me  from:agent  in:@ada         yourself, any agent, your DM with Ada
 *
 * Postgres uses full-text search (`websearch_to_tsquery`) with access
 * filtering in the same SQL statement. Desktop SQLite falls back to
 * case-insensitive term matching.
 */

import { prisma } from '../lib/prisma'
import { MESSAGE_INCLUDE, serializeMessage, type SerializedMessage } from './conversation.service'

const db = prisma as any
const isLocalMode = () => process.env.SHOGO_LOCAL_MODE === 'true'

export const MAX_SEARCH_RESULTS = 50
const FTS_CONFIG = 'english'

export interface ParsedSearchQuery {
  text: string
  terms: string[]
  inChannels: string[]
  inPeople: string[]
  from: string[]
}

const FILTER_RE = /(^|\s)(in|from):("[^"]+"|\S+)/gi

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = { text: '', terms: [], inChannels: [], inPeople: [], from: [] }
  const text = raw.replace(FILTER_RE, (_, lead: string, key: string, value: string) => {
    const v = value.replace(/^"|"$/g, '').trim()
    if (!v) return lead
    if (key.toLowerCase() === 'from') parsed.from.push(v.replace(/^@/, '').toLowerCase())
    else if (v.startsWith('@')) parsed.inPeople.push(v.slice(1).toLowerCase())
    else parsed.inChannels.push(v.replace(/^#/, '').toLowerCase())
    return lead
  })
  parsed.text = text.replace(/\s+/g, ' ').trim()
  parsed.terms = [...new Set(
    parsed.text
      .replace(/"/g, ' ')
      .split(' ')
      .filter((w) => w && !w.startsWith('-') && w.toLowerCase() !== 'or')
      .map((w) => w.toLowerCase()),
  )]
  return parsed
}

export interface SearchResult {
  message: SerializedMessage
  conversation: { id: string; kind: string; name: string | null; slug: string | null }
}

export interface SearchResponse {
  results: SearchResult[]
  terms: string[]
  hasMore: boolean
}

async function matchUsers(workspaceId: string, names: string[], viewerId: string): Promise<string[]> {
  const ids = new Set<string>()
  const wanted = names.filter((n) => n !== 'me' && n !== 'agent')
  if (names.includes('me')) ids.add(viewerId)
  if (wanted.length) {
    const members = await db.member.findMany({
      where: { workspaceId },
      select: { user: { select: { id: true, name: true, email: true } } },
    })
    for (const { user } of members) {
      if (!user) continue
      const name = (user.name ?? '').toLowerCase()
      const handle = (user.email ?? '').toLowerCase().split('@')[0]
      if (wanted.some((w) => name === w || name.split(/\s+/).includes(w) || handle === w || name.startsWith(w))) ids.add(user.id)
    }
  }
  return [...ids]
}

interface Filters {
  conversationIds: string[] | null
  authorUserIds: string[] | null
  agentOnly: boolean
  agentNames: string[]
}

async function resolveFilters(workspaceId: string, viewerId: string, q: ParsedSearchQuery): Promise<Filters | null> {
  let conversationIds: string[] | null = null
  if (q.inChannels.length || q.inPeople.length) {
    const ids = new Set<string>()
    if (q.inChannels.length) {
      const rows = await db.conversation.findMany({
        where: { workspaceId, slug: { in: q.inChannels } },
        select: { id: true },
      })
      rows.forEach((r: any) => ids.add(r.id))
    }
    if (q.inPeople.length) {
      const people = await matchUsers(workspaceId, q.inPeople, viewerId)
      if (people.length) {
        const rows = await db.conversationMember.findMany({
          where: { userId: { in: people }, conversation: { workspaceId, kind: { in: ['dm', 'group_dm'] } } },
          select: { conversationId: true },
        })
        rows.forEach((r: any) => ids.add(r.conversationId))
      }
    }
    if (!ids.size) return null
    conversationIds = [...ids]
  }

  let authorUserIds: string[] | null = null
  let agentOnly = false
  const agentNames: string[] = []
  if (q.from.length) {
    const people = await matchUsers(workspaceId, q.from, viewerId)
    const unmatched = q.from.filter((f) => f !== 'me')
    if (people.length) authorUserIds = people
    else if (unmatched.length) {
      agentOnly = true
      agentNames.push(...unmatched.filter((f) => f !== 'agent'))
    } else return null
  }
  return { conversationIds, authorUserIds, agentOnly, agentNames }
}

async function pgMatchIds(
  workspaceId: string,
  viewerId: string,
  q: ParsedSearchQuery,
  f: Filters,
  opts: { limit: number; offset: number; sort: 'relevance' | 'recent' },
): Promise<string[]> {
  const params: unknown[] = [workspaceId, viewerId]
  const p = (value: unknown) => `$${params.push(value)}`
  const where = [
    `m."workspaceId" = $1`,
    `m."deletedAt" IS NULL`,
    `m."authorType"::text <> 'system'`,
    `m."conversationId" IN (
      SELECT c.id FROM conversations c
      WHERE c."workspaceId" = $1
        AND (c.kind::text IN ('public', 'activity')
          OR EXISTS (SELECT 1 FROM conversation_members cm WHERE cm."conversationId" = c.id AND cm."userId" = $2)))`,
  ]
  let rank = 'NULL::real'
  if (q.text) {
    const query = `websearch_to_tsquery('${FTS_CONFIG}', ${p(q.text)})`
    where.push(`to_tsvector('${FTS_CONFIG}', m.text) @@ ${query}`)
    rank = `ts_rank(to_tsvector('${FTS_CONFIG}', m.text), ${query})`
  }
  if (f.conversationIds) where.push(`m."conversationId" = ANY(${p(f.conversationIds)}::text[])`)
  if (f.authorUserIds) where.push(`m."authorUserId" = ANY(${p(f.authorUserIds)}::text[])`)
  if (f.agentOnly) where.push(`m."authorType"::text = 'agent'`)
  const order = opts.sort === 'relevance' && q.text ? 'rank DESC, m."createdAt" DESC' : 'm."createdAt" DESC'
  const rows = await db.$queryRawUnsafe(
    `SELECT m.id, ${rank} AS rank FROM conversation_messages m
     WHERE ${where.join(' AND ')}
     ORDER BY ${order}
     LIMIT ${p(opts.limit)} OFFSET ${p(opts.offset)}`,
    ...params,
  )
  return rows.map((r: any) => r.id)
}

async function sqliteMatchIds(
  workspaceId: string,
  viewerId: string,
  q: ParsedSearchQuery,
  f: Filters,
  opts: { limit: number; offset: number },
): Promise<string[]> {
  const readable = await db.conversation.findMany({
    where: {
      workspaceId,
      OR: [{ kind: { in: ['public', 'activity'] } }, { members: { some: { userId: viewerId } } }],
    },
    select: { id: true },
  })
  let ids = readable.map((c: any) => c.id)
  if (f.conversationIds) ids = ids.filter((id: string) => f.conversationIds!.includes(id))
  const rows = await db.conversationMessage.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      authorType: f.agentOnly ? 'agent' : { not: 'system' },
      conversationId: { in: ids },
      ...(f.authorUserIds ? { authorUserId: { in: f.authorUserIds } } : {}),
      AND: q.terms.map((t) => ({ text: { contains: t } })),
    },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
    skip: opts.offset,
    take: opts.limit,
  })
  return rows.map((r: any) => r.id)
}

export async function searchMessages(
  workspaceId: string,
  viewerId: string,
  raw: string,
  opts: { limit?: number; offset?: number; sort?: 'relevance' | 'recent' } = {},
): Promise<SearchResponse> {
  const q = parseSearchQuery(raw ?? '')
  const empty = { results: [], terms: q.terms, hasMore: false }
  if (!q.text && !q.inChannels.length && !q.inPeople.length && !q.from.length) return empty
  const filters = await resolveFilters(workspaceId, viewerId, q)
  if (!filters) return empty

  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), MAX_SEARCH_RESULTS)
  const offset = Math.max(Math.floor(opts.offset ?? 0), 0)
  const page = { limit: limit + 1, offset, sort: opts.sort ?? 'relevance' }
  const ids = isLocalMode()
    ? await sqliteMatchIds(workspaceId, viewerId, q, filters, page)
    : await pgMatchIds(workspaceId, viewerId, q, filters, page)

  const rows = await db.conversationMessage.findMany({
    where: { id: { in: ids.slice(0, limit) } },
    include: { ...MESSAGE_INCLUDE, conversation: { select: { id: true, kind: true, name: true, slug: true } } },
  })
  const byId = new Map(rows.map((r: any) => [r.id, r]))
  const results: SearchResult[] = []
  for (const id of ids.slice(0, limit)) {
    const row: any = byId.get(id)
    if (!row) continue
    if (filters.agentNames.length) {
      const name = String(row.authorAgentRef?.name ?? '').toLowerCase()
      if (!filters.agentNames.some((n) => name.includes(n))) continue
    }
    results.push({ message: serializeMessage(row), conversation: row.conversation })
  }
  return { results, terms: q.terms, hasMore: ids.length > limit }
}
