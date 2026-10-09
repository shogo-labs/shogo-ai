// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Message search across the conversations a person can read.
 *
 *   ship friday in:#launch from:@ada     words plus filters
 *   "exact phrase" -excluded             websearch syntax (Postgres)
 *   from:me  from:agent  in:@ada         yourself, any agent, your DM with Ada
 *   has:file has:image has:link has:pin  messages with attachments, links, pins
 *   before:2026-09-01 after:… on:today   dates in the searcher's time zone
 *
 * Attachment names and extracted file text are searched along with the
 * message text.
 *
 * Postgres uses full-text search (`websearch_to_tsquery`) with access
 * filtering in the same SQL statement. Desktop SQLite falls back to
 * case-insensitive term matching.
 */

import { prisma } from '../lib/prisma'
import { MESSAGE_INCLUDE, serializeMessage, type SerializedMessage } from './conversation.service'
import { fromZoned, safeZone, zoned } from './chat-remind-parse'

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
  has: HasFilter[]
  before: string | null
  after: string | null
  on: string | null
}

export type HasFilter = 'file' | 'image' | 'link' | 'pin'

const HAS_VALUES: Record<string, HasFilter> = {
  file: 'file', files: 'file', attachment: 'file', attachments: 'file',
  image: 'image', images: 'image', photo: 'image',
  link: 'link', links: 'link', url: 'link',
  pin: 'pin', pinned: 'pin', pins: 'pin',
}
const DATE_VALUE_RE = /^(\d{4}-\d{2}-\d{2}|today|yesterday)$/i
const FILTER_RE = /(^|\s)(in|from|has|before|after|on|during):("[^"]+"|\S+)/gi

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = {
    text: '', terms: [], inChannels: [], inPeople: [], from: [], has: [], before: null, after: null, on: null,
  }
  const text = raw.replace(FILTER_RE, (match: string, lead: string, rawKey: string, value: string) => {
    const v = value.replace(/^"|"$/g, '').trim()
    const key = rawKey.toLowerCase()
    if (!v) return lead
    if (key === 'has') {
      const has = HAS_VALUES[v.toLowerCase()]
      if (!has) return match
      if (!parsed.has.includes(has)) parsed.has.push(has)
    } else if (key === 'before' || key === 'after' || key === 'on' || key === 'during') {
      if (!DATE_VALUE_RE.test(v)) return match
      parsed[key === 'during' ? 'on' : key] = v.toLowerCase()
    } else if (key === 'from') parsed.from.push(v.replace(/^@/, '').toLowerCase())
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

export function hasSearchInput(q: ParsedSearchQuery): boolean {
  return Boolean(q.text || q.inChannels.length || q.inPeople.length || q.from.length || q.has.length || q.before || q.after || q.on)
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
      where: { workspaceId, projectId: null },
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

/** Start of the given local day (`YYYY-MM-DD`, today, yesterday) in `timezone`. */
export function localDayStart(value: string, timezone: string, now = new Date()): Date {
  const tz = safeZone(timezone)
  let y: number, m: number, d: number
  if (value === 'today' || value === 'yesterday') {
    const p = zoned(now, tz)
    ;[y, m, d] = [p.year, p.month, p.day - (value === 'yesterday' ? 1 : 0)]
  } else {
    ;[y, m, d] = value.split('-').map(Number) as [number, number, number]
  }
  const utc = new Date(Date.UTC(y, m - 1, d))
  return fromZoned(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate(), 0, 0, tz)
}

function nextLocalDay(start: Date, timezone: string): Date {
  const p = zoned(new Date(start.getTime() + 36 * 3_600_000), safeZone(timezone))
  return fromZoned(p.year, p.month, p.day, 0, 0, safeZone(timezone))
}

interface Filters {
  conversationIds: string[] | null
  authorUserIds: string[] | null
  agentOnly: boolean
  agentNames: string[]
  has: HasFilter[]
  since: Date | null
  until: Date | null
}

function resolveDates(q: ParsedSearchQuery, timezone: string, now: Date): { since: Date | null; until: Date | null } {
  let since: Date | null = null
  let until: Date | null = null
  if (q.on) {
    since = localDayStart(q.on, timezone, now)
    until = nextLocalDay(since, timezone)
  }
  if (q.after) {
    const start = nextLocalDay(localDayStart(q.after, timezone, now), timezone)
    since = since && since > start ? since : start
  }
  if (q.before) {
    const end = localDayStart(q.before, timezone, now)
    until = until && until < end ? until : end
  }
  return { since, until }
}

async function resolveFilters(
  workspaceId: string,
  viewerId: string,
  q: ParsedSearchQuery,
  timezone = 'UTC',
  now = new Date(),
): Promise<Filters | null> {
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
  const { since, until } = resolveDates(q, timezone, now)
  if (since && until && since >= until) return null
  return { conversationIds, authorUserIds, agentOnly, agentNames, has: q.has, since, until }
}

// Postgres parses `q3-notes.txt` as a single file token, so the name is also
// indexed with separators spaced out to make its parts searchable.
const ATTACHMENT_TEXT_SQL = `COALESCE((SELECT string_agg(a.name || ' ' || translate(a.name, '._/', '   ') || ' ' || COALESCE(a."extractedText", ''), ' ')
  FROM conversation_attachments a WHERE a."messageId" = m.id), '')`

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
    const doc = `to_tsvector('${FTS_CONFIG}', m.text || ' ' || ${ATTACHMENT_TEXT_SQL})`
    where.push(`${doc} @@ ${query}`)
    rank = `ts_rank(${doc}, ${query})`
  }
  if (f.conversationIds) where.push(`m."conversationId" = ANY(${p(f.conversationIds)}::text[])`)
  if (f.authorUserIds) where.push(`m."authorUserId" = ANY(${p(f.authorUserIds)}::text[])`)
  if (f.agentOnly) where.push(`m."authorType"::text = 'agent'`)
  if (f.has.includes('file')) where.push(`EXISTS (SELECT 1 FROM conversation_attachments a WHERE a."messageId" = m.id)`)
  if (f.has.includes('image')) {
    where.push(`EXISTS (SELECT 1 FROM conversation_attachments a WHERE a."messageId" = m.id AND a."mimeType" LIKE 'image/%')`)
  }
  if (f.has.includes('link')) where.push(`m.text ~* 'https?://'`)
  if (f.has.includes('pin')) where.push(`EXISTS (SELECT 1 FROM conversation_pins pn WHERE pn."messageId" = m.id)`)
  if (f.since) where.push(`m."createdAt" >= ${p(f.since)}`)
  if (f.until) where.push(`m."createdAt" < ${p(f.until)}`)
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
  opts: { limit: number; offset: number; matchAny?: boolean },
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
  const termClauses = q.terms.map((t) => ({
    OR: [
      { text: { contains: t } },
      { attachments: { some: { OR: [{ name: { contains: t } }, { extractedText: { contains: t } }] } } },
    ],
  }))
  const and: Record<string, unknown>[] = opts.matchAny && termClauses.length ? [{ OR: termClauses }] : termClauses
  if (f.has.includes('file')) and.push({ attachments: { some: {} } })
  if (f.has.includes('image')) and.push({ attachments: { some: { mimeType: { startsWith: 'image/' } } } })
  if (f.has.includes('link')) and.push({ OR: [{ text: { contains: 'http://' } }, { text: { contains: 'https://' } }] })
  if (f.has.includes('pin')) and.push({ pin: { isNot: null } })
  if (f.since) and.push({ createdAt: { gte: f.since } })
  if (f.until) and.push({ createdAt: { lt: f.until } })
  const rows = await db.conversationMessage.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      authorType: f.agentOnly ? 'agent' : { not: 'system' },
      conversationId: { in: ids },
      ...(f.authorUserIds ? { authorUserId: { in: f.authorUserIds } } : {}),
      AND: and,
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
  opts: {
    limit?: number
    offset?: number
    sort?: 'relevance' | 'recent'
    timezone?: string | null
    now?: Date
    /** Match messages containing any term instead of all of them. */
    matchAny?: boolean
  } = {},
): Promise<SearchResponse> {
  const q = parseSearchQuery(raw ?? '')
  const empty = { results: [], terms: q.terms, hasMore: false }
  if (!hasSearchInput(q)) return empty
  const filters = await resolveFilters(workspaceId, viewerId, q, opts.timezone ?? 'UTC', opts.now)
  if (!filters) return empty

  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), MAX_SEARCH_RESULTS)
  const offset = Math.max(Math.floor(opts.offset ?? 0), 0)
  const page = { limit: limit + 1, offset, sort: opts.sort ?? 'relevance', matchAny: opts.matchAny }
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
