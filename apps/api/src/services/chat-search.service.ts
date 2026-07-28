// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
export interface ChatSearchHitDto {
  conversationId: string
  messageId?: string
  field: 'title' | 'project' | 'message'
  score: number
  text: string
  snippet: string
  ranges: Array<{ start: number; end: number }>
  createdAt: number
}

export interface ChatSearchConversationDto {
  conversationId: string
  title: string
  contextType?: string | null
  projectId?: string | null
  projectName?: string | null
  workspaceId?: string | null
  updatedAt: number
  score: number
  hits: ChatSearchHitDto[]
}

export interface ChatSearchResponseDto {
  query: string
  conversations: ChatSearchConversationDto[]
  hasMore: boolean
  nextOffset: number | null
}

const MAX_CANDIDATE_MESSAGES = 500
const MAX_CANDIDATE_SESSIONS = 200
const MAX_HITS_PER_CONVERSATION = 6
const MAX_SNIPPET_LENGTH = 160

export function tokenizeChatSearchQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9_]+/g) ?? []
  return Array.from(new Set(tokens))
}

export function rankChatSearchField(input: {
  text: string
  field: 'title' | 'project' | 'message'
  queryTokens: string[]
  updatedAt: number
  now?: number
}): { score: number; ranges: Array<{ start: number; end: number }> } {
  const lower = input.text.toLowerCase()
  const ranges: Array<{ start: number; end: number }> = []
  let score = input.field === 'title' ? 30 : input.field === 'project' ? 18 : 0

  for (const token of input.queryTokens) {
    if (!token) continue
    const escaped = escapeRegExp(token)
    const exactPattern = new RegExp(`\\b${escaped}\\b`, 'gi')
    const prefixPattern = new RegExp(`\\b${escaped}[a-z0-9_]*`, 'gi')
    const exactMatches = Array.from(input.text.matchAll(exactPattern))
    const prefixMatches = Array.from(input.text.matchAll(prefixPattern))
    const exactCount = exactMatches.length
    const prefixCount = Math.max(0, prefixMatches.length - exactCount)
    score += exactCount * 80
    score += prefixCount * 45
    score += Math.min(exactCount + prefixCount, 8) * 6

    let start = lower.indexOf(token)
    while (start !== -1) {
      ranges.push({ start, end: start + token.length })
      start = lower.indexOf(token, start + 1)
    }
  }

  score += computeRecencyBoost(input.updatedAt, input.now ?? Date.now())
  return { score, ranges: mergeRanges(ranges) }
}

export function buildChatSearchApiSnippet(text: string, queryTokens: string[]): string {
  if (text.length <= MAX_SNIPPET_LENGTH) return text
  const firstMatch = queryTokens
    .map((token) => text.toLowerCase().indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0]

  if (firstMatch === undefined) return `${text.slice(0, MAX_SNIPPET_LENGTH - 1).trimEnd()}...`
  const half = Math.floor(MAX_SNIPPET_LENGTH / 2)
  const start = Math.max(0, firstMatch - half)
  const end = Math.min(text.length, start + MAX_SNIPPET_LENGTH)
  return `${start > 0 ? '...' : ''}${text.slice(start, end).trim()}${end < text.length ? '...' : ''}`
}

export async function searchWorkspaceChats(input: {
  prisma: any
  workspaceId: string
  query: string
  limit?: number
  offset?: number
}): Promise<ChatSearchResponseDto> {
  const queryTokens = tokenizeChatSearchQuery(input.query)
  if (queryTokens.length === 0) return { query: input.query, conversations: [], hasMore: false, nextOffset: null }

  const containsFilters = queryTokens.map((token) => buildContainsFilter(token))
  const sessionWorkspaceWhere = buildSessionWorkspaceWhere(input.workspaceId)

  const [messages, sessions] = await Promise.all([
    input.prisma.chatMessage.findMany({
      where: {
        session: sessionWorkspaceWhere,
        OR: containsFilters.map((filter) => ({ content: filter })),
      },
      include: {
        session: {
          include: {
            project: { select: { id: true, name: true, workspaceId: true } },
            workspace: { select: { id: true, name: true } },
            attachedProjects: { include: { project: { select: { id: true, name: true, workspaceId: true } } }, take: 5 },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_CANDIDATE_MESSAGES,
    }),
    input.prisma.chatSession.findMany({
      where: {
        ...sessionWorkspaceWhere,
        OR: [
          ...containsFilters.map((filter) => ({ name: filter })),
          ...containsFilters.map((filter) => ({ inferredName: filter })),
          ...containsFilters.map((filter) => ({ project: { name: filter } })),
          ...containsFilters.map((filter) => ({ attachedProjects: { some: { project: { name: filter } } } })),
        ],
      },
      include: {
        project: { select: { id: true, name: true, workspaceId: true } },
        workspace: { select: { id: true, name: true } },
        attachedProjects: { include: { project: { select: { id: true, name: true, workspaceId: true } } }, take: 5 },
      },
      orderBy: { updatedAt: 'desc' },
      take: MAX_CANDIDATE_SESSIONS,
    }),
  ])

  const grouped = new Map<string, ChatSearchConversationDto>()
  for (const message of messages) {
    addHit(grouped, buildConversationMeta(message.session), {
      id: message.id,
      field: 'message',
      text: message.content ?? '',
      createdAt: toMillis(message.createdAt),
      queryTokens,
    })
  }

  for (const session of sessions) {
    const meta = buildConversationMeta(session)
    addHit(grouped, meta, {
      field: 'title',
      text: meta.title,
      createdAt: meta.updatedAt,
      queryTokens,
    })
    if (meta.projectName) {
      addHit(grouped, meta, {
        field: 'project',
        text: meta.projectName,
        createdAt: meta.updatedAt,
        queryTokens,
      })
    }
  }

  const limit = input.limit ?? 50
  const offset = input.offset ?? 0
  const rankedConversations = Array.from(grouped.values())
    .map((conversation) => ({
      ...conversation,
      hits: conversation.hits
        .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
        .slice(0, MAX_HITS_PER_CONVERSATION),
    }))
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)

  const page = rankedConversations.slice(offset, offset + limit)
  const nextOffset = offset + page.length

  return {
    query: input.query,
    conversations: page,
    hasMore: nextOffset < rankedConversations.length,
    nextOffset: nextOffset < rankedConversations.length ? nextOffset : null,
  }
}

function buildSessionWorkspaceWhere(workspaceId: string): Record<string, unknown> {
  return {
    OR: [
      { workspaceId },
      { project: { workspaceId } },
      { attachedProjects: { some: { project: { workspaceId } } } },
    ],
  }
}

function buildConversationMeta(session: any): ChatSearchConversationDto {
  const project = session.project ?? session.attachedProjects?.[0]?.project ?? null
  const updatedAt = toMillis(session.lastActiveAt ?? session.updatedAt ?? session.createdAt)
  return {
    conversationId: session.id,
    title: (session.name || session.inferredName || 'Untitled chat').trim(),
    contextType: session.contextType ?? null,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    workspaceId: session.workspaceId ?? project?.workspaceId ?? session.workspace?.id ?? null,
    updatedAt,
    score: 0,
    hits: [],
  }
}

function addHit(
  grouped: Map<string, ChatSearchConversationDto>,
  meta: ChatSearchConversationDto,
  hitInput: {
    id?: string
    field: 'title' | 'project' | 'message'
    text: string
    createdAt: number
    queryTokens: string[]
  },
): void {
  const ranked = rankChatSearchField({
    text: hitInput.text,
    field: hitInput.field,
    queryTokens: hitInput.queryTokens,
    updatedAt: meta.updatedAt,
  })
  if (ranked.score <= 0 || ranked.ranges.length === 0) return

  const hit: ChatSearchHitDto = {
    conversationId: meta.conversationId,
    messageId: hitInput.id,
    field: hitInput.field,
    score: ranked.score,
    text: hitInput.text,
    snippet: buildChatSearchApiSnippet(hitInput.text, hitInput.queryTokens),
    ranges: ranked.ranges,
    createdAt: hitInput.createdAt,
  }

  const existing = grouped.get(meta.conversationId)
  if (existing) {
    existing.score += hit.score
    existing.hits.push(hit)
  } else {
    grouped.set(meta.conversationId, { ...meta, score: hit.score, hits: [hit] })
  }
}

function toMillis(value: Date | string | number | null | undefined): number {
  if (!value) return 0
  if (typeof value === 'number') return value
  return new Date(value).getTime()
}

function computeRecencyBoost(updatedAt: number, now: number): number {
  const ageDays = Math.max(0, (now - updatedAt) / 86_400_000)
  return Math.max(0, 12 - ageDays)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildContainsFilter(token: string): Record<string, string> {
  const isSQLite = (process.env.DATABASE_URL || '').startsWith('file:')
  return isSQLite ? { contains: token } : { contains: token, mode: 'insensitive' }
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  return ranges
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .reduce<Array<{ start: number; end: number }>>((merged, range) => {
      const previous = merged[merged.length - 1]
      if (!previous || range.start > previous.end) {
        merged.push({ ...range })
      } else {
        previous.end = Math.max(previous.end, range.end)
      }
      return merged
    }, [])
}