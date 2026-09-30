// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Client for workspace team chat: channels, DMs and agent DMs
 * (`/api/workspaces/:workspaceId/conversations`, `/api/conversations/:id`,
 * `/api/conversation-messages/:id`).
 */
import { Platform } from 'react-native'
import { API_URL, createHttpClient } from './api'
import { authClient } from './auth-client'

export type ConversationKind = 'public' | 'private' | 'dm' | 'group_dm' | 'activity'
export type AgentStatus = 'running' | 'done' | 'error' | 'stopped'

export type Participant =
  | { type: 'user'; id: string; name: string; image: string | null }
  | { type: 'agent'; projectId: string | null; name: string | null }

export interface ConversationSummary {
  id: string
  workspaceId: string
  kind: ConversationKind
  name: string | null
  slug: string | null
  topic: string | null
  lastSeq: number
  lastMessageAt: string | null
  archivedAt: string | null
  createdAt: string
  joined: boolean
  starred: boolean
  muted: boolean
  notifyLevel: string
  lastReadSeq: number
  unreadCount: number
  mentionCount: number
  participants?: Participant[]
}

export type ConversationMember =
  | { id: string; type: 'user'; userId: string; role: string; name: string; image: string | null }
  | { id: string; type: 'agent'; projectId: string | null; name: string | null; agentTrigger: string; agentKeywords: string | null }

export interface ConversationDetail extends Omit<ConversationSummary, 'unreadCount' | 'mentionCount' | 'participants'> {
  canPost: boolean
  /** Can reply in threads (true in #activity even though top-level posts are system-only). */
  canReply: boolean
  canManage: boolean
  members: ConversationMember[]
}

export interface ReactionSummary {
  emoji: string
  count: number
  userIds: string[]
}

export interface MessageAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  width: number | null
  height: number | null
  url: string
}

export interface ChatMessage {
  id: string
  conversationId: string
  workspaceId: string
  seq: number
  threadRootId: string | null
  replyCount: number
  lastReplyAt: string | null
  alsoSentToChannel: boolean
  authorType: 'user' | 'agent' | 'bot' | 'system'
  author: { id: string; name: string; image: string | null } | null
  authorUserId: string | null
  authorAgent: { projectId: string | null; name: string } | null
  text: string
  blocks: Record<string, unknown> | null
  clientMsgId: string | null
  agentSessionId: string | null
  agentStatus: AgentStatus | null
  reactions: ReactionSummary[]
  attachments: MessageAttachment[]
  editedAt: string | null
  deletedAt: string | null
  createdAt: string
  /** Client-only: optimistic send not yet acknowledged, or failed. */
  pending?: 'sending' | 'failed'
}

export interface Mentionables {
  people: Array<{ id: string; name: string; email: string; image: string | null; role: string }>
  agents: Array<{ key: string; projectId: string | null; name: string; description: string | null; image: string | null }>
}

export interface MessagePage {
  messages: ChatMessage[]
  hasMore: boolean
  root?: ChatMessage
}

export interface CatchUpResult {
  summary: string | null
  messageCount: number
  fromSeq: number
  toSeq: number
}

export type TeamChatEvent =
  | { type: 'ready'; workspaceId: string; userId: string }
  | { type: 'message.created'; conversationId: string; message: ChatMessage }
  | { type: 'message.updated'; conversationId: string; message: ChatMessage }
  | { type: 'reaction.changed'; conversationId: string; messageId: string; reactions: ReactionSummary[] }
  | { type: 'agent.delta'; conversationId: string; messageId: string; text: string; tool: string | null }
  | { type: 'conversation.created'; conversationId: string; conversation: ConversationSummary }
  | { type: 'conversation.updated'; conversationId: string; conversation: ConversationSummary }
  | { type: 'member.joined' | 'member.left'; conversationId: string; userId?: string; userIds?: string[] }
  | { type: 'read'; conversationId: string; userId: string; seq: number }
  | { type: 'typing'; conversationId: string; threadRootId: string | null; userId: string; name: string }
  | { type: 'presence'; userId: string; status: 'active' | 'away' | 'offline' }

export const mentionToken = {
  user: (id: string) => `<@u:${id}>`,
  agent: (projectId: string | null) => (projectId ? `<@a:p:${projectId}>` : '<@a:ws>'),
}

export function conversationTitle(c: Pick<ConversationSummary, 'kind' | 'name' | 'participants'>): string {
  if (c.kind === 'dm' || c.kind === 'group_dm') {
    const names = (c.participants ?? []).map((p) => p.name ?? 'Agent').filter(Boolean)
    return names.length ? names.join(', ') : 'Direct message'
  }
  return c.name ?? 'channel'
}

export function isAgentDm(c: Pick<ConversationSummary, 'kind' | 'participants'>): boolean {
  return c.kind === 'dm' && (c.participants ?? []).some((p) => p.type === 'agent')
}

export function teamChatApi() {
  const http = createHttpClient()
  const ws = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}`
  const conv = (id: string) => `/api/conversations/${encodeURIComponent(id)}`
  const msg = (id: string) => `/api/conversation-messages/${encodeURIComponent(id)}`
  return {
    async list(workspaceId: string): Promise<ConversationSummary[]> {
      return (await http.get<{ conversations: ConversationSummary[] }>(`${ws(workspaceId)}/conversations`)).data
        .conversations ?? []
    },
    async createChannel(workspaceId: string, input: { name: string; kind: 'public' | 'private'; topic?: string }) {
      return (await http.post<{ conversation: ConversationSummary }>(`${ws(workspaceId)}/conversations`, input)).data
        .conversation
    },
    async openDm(workspaceId: string, userIds: string[]) {
      return (await http.post<{ conversation: ConversationSummary }>(`${ws(workspaceId)}/dms`, { userIds })).data
        .conversation
    },
    async openAgentDm(workspaceId: string, projectId: string | null) {
      return (await http.post<{ conversation: ConversationSummary }>(`${ws(workspaceId)}/dms`, { agent: { projectId } }))
        .data.conversation
    },
    async mentionables(workspaceId: string): Promise<Mentionables> {
      return (await http.get<Mentionables>(`${ws(workspaceId)}/mentionables`)).data
    },
    async get(id: string): Promise<ConversationDetail> {
      return (await http.get<{ conversation: ConversationDetail }>(conv(id))).data.conversation
    },
    async update(id: string, patch: { name?: string; topic?: string | null; archived?: boolean }) {
      return (await http.patch<{ conversation: ConversationDetail }>(conv(id), patch)).data.conversation
    },
    async join(id: string) {
      await http.post(`${conv(id)}/join`, {})
    },
    async leave(id: string) {
      await http.post(`${conv(id)}/leave`, {})
    },
    async addMembers(id: string, userIds: string[]) {
      await http.post(`${conv(id)}/members`, { userIds })
    },
    async addAgent(id: string, input: { projectId: string | null; trigger?: 'mention' | 'all' | 'keyword'; keywords?: string }) {
      await http.post(`${conv(id)}/agents`, input)
    },
    async removeMember(id: string, memberId: string) {
      await http.delete(`${conv(id)}/members/${encodeURIComponent(memberId)}`)
    },
    async updateMembership(id: string, patch: { starred?: boolean; muted?: boolean; notifyLevel?: string }) {
      await http.patch(`${conv(id)}/membership`, patch)
    },
    async messages(
      id: string,
      opts: { beforeSeq?: number; afterSeq?: number; threadRootId?: string; limit?: number } = {},
    ): Promise<MessagePage> {
      const q = new URLSearchParams()
      if (opts.beforeSeq) q.set('beforeSeq', String(opts.beforeSeq))
      if (opts.afterSeq !== undefined) q.set('afterSeq', String(opts.afterSeq))
      if (opts.threadRootId) q.set('threadRootId', opts.threadRootId)
      if (opts.limit) q.set('limit', String(opts.limit))
      return (await http.get<MessagePage>(`${conv(id)}/messages?${q}`)).data
    },
    async post(
      id: string,
      input: { text: string; threadRootId?: string | null; alsoSentToChannel?: boolean; clientMsgId: string; attachmentIds?: string[] },
    ): Promise<ChatMessage> {
      return (await http.post<{ message: ChatMessage }>(`${conv(id)}/messages`, input)).data.message
    },
    async markRead(id: string, seq?: number) {
      await http.post(`${conv(id)}/read`, seq === undefined ? {} : { seq })
    },
    async catchUp(id: string): Promise<CatchUpResult> {
      return (await http.post<CatchUpResult>(`${conv(id)}/catch-up`, {})).data
    },
    async edit(messageId: string, text: string): Promise<ChatMessage> {
      return (await http.patch<{ message: ChatMessage }>(msg(messageId), { text })).data.message
    },
    async remove(messageId: string) {
      await http.delete(msg(messageId))
    },
    async react(messageId: string, emoji: string, on?: boolean) {
      return (await http.post<{ reactions: ReactionSummary[] }>(`${msg(messageId)}/reactions`, { emoji, on })).data.reactions
    },
    async stopAgent(messageId: string) {
      await http.post(`${msg(messageId)}/stop`, {})
    },
    async upload(id: string, file: { uri: string; name: string; type: string } | File): Promise<MessageAttachment> {
      const form = new FormData()
      form.append('file', file as any)
      const res = await fetch(`${API_URL}${conv(id)}/attachments`, {
        method: 'POST',
        body: form,
        credentials: Platform.OS === 'web' ? 'include' : 'omit',
        headers: nativeCookieHeader(),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error?.message ?? `Upload failed (${res.status})`)
      }
      return (await res.json()).attachment
    },
  }
}

export function nativeCookieHeader(): Record<string, string> {
  if (Platform.OS === 'web') return {}
  const cookie = (authClient as { getCookie?: () => string | null }).getCookie?.()
  return cookie ? { Cookie: cookie } : {}
}

export function realtimeUrls(workspaceId: string): { ws: string; sse: string } {
  const base = `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}`
  return {
    ws: `${base.replace(/^http/, 'ws')}/rt`,
    sse: `${base}/conversations/events`,
  }
}

export function newClientMsgId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
