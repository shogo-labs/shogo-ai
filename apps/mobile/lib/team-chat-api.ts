// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Client for workspace team chat: channels, DMs and agent DMs
 * (`/api/workspaces/:workspaceId/conversations`, `/api/conversations/:id`,
 * `/api/conversation-messages/:id`).
 */
import type { BuddyLook } from '@shogo/shared-app/buddy-look'
import { Platform } from 'react-native'
import { API_URL, createHttpClient } from './api'
import { authClient } from './auth-client'
import type { UploadPart } from './upload-part'
import { routeUrl } from './workspace-route'

export type ConversationKind = 'public' | 'private' | 'dm' | 'group_dm' | 'activity'

export type ChatModeValue = 'off' | 'native' | 'external' | 'bridged'
export type ExternalChatProvider = 'slack' | 'teams' | 'google_chat'

export interface WorkspaceChatMode {
  mode: ChatModeValue
  provider: ExternalChatProvider | null
  isDefault: boolean
  canManage: boolean
  installations: Array<{ provider: ExternalChatProvider; tenantName: string | null; createdAt: string }>
}

/** Whether the Shogo chat UI (sidebar, channels, DMs) is available in this mode. */
export function nativeChatVisible(mode: ChatModeValue | null | undefined): boolean {
  return mode === 'native' || mode === 'bridged'
}
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
  /** Newest top-level message; sent for direct messages only. */
  lastMessage?: {
    preview: string
    authorId: string | null
    authorType: 'user' | 'agent' | 'bot' | 'system' | string
    createdAt: string
  }
}

export type ConversationMember =
  | { id: string; type: 'user'; userId: string; role: string; name: string; image: string | null }
  | { id: string; type: 'agent'; projectId: string | null; name: string | null; agentTrigger: string; agentKeywords: string | null; agentMuted?: boolean }

export interface ConversationDetail extends Omit<ConversationSummary, 'unreadCount' | 'mentionCount' | 'participants' | 'lastMessage'> {
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
  authorAgent: { projectId: string | null; name: string; iconUrl?: string | null } | null
  text: string
  blocks: Record<string, unknown> | null
  clientMsgId: string | null
  agentSessionId: string | null
  agentStatus: AgentStatus | null
  reactions: ReactionSummary[]
  attachments: MessageAttachment[]
  pinned?: { byId: string; at: string } | null
  editedAt: string | null
  deletedAt: string | null
  createdAt: string
  /** Client-only: optimistic send not yet acknowledged, or failed. */
  pending?: 'sending' | 'failed'
}

export interface SearchResponse {
  results: Array<{
    message: ChatMessage
    conversation: { id: string; kind: ConversationKind; name: string | null; slug: string | null }
  }>
  terms: string[]
  hasMore: boolean
  /** Set for semantic searches: false when the server has no embedding provider. */
  semantic?: boolean
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export interface AskCitation {
  n: number
  cited: boolean
  message: ChatMessage
  conversation: SearchResponse['results'][number]['conversation']
}

export interface AskResult {
  answer: string
  citations: AskCitation[]
  semantic: boolean
}

export interface UserStatus {
  emoji: string | null
  text: string | null
  expiresAt: string | null
  dnd: boolean
}

export type PresenceStatus = 'active' | 'away' | 'offline'

export interface Mentionables {
  people: Array<{ id: string; name: string; email: string; image: string | null; role: string }>
  agents: Array<{ key: string; projectId: string | null; name: string; description: string | null; image: string | null; buddyLook?: BuddyLook | null }>
  statuses?: Record<string, UserStatus>
  groups?: UserGroup[]
}

/** An action an agent is waiting on a person to approve, across all channels. */
export interface PendingApproval {
  /** The channel message holding the card; decide through `decideApproval`. */
  messageId: string
  conversationId: string
  requestId: string
  projectId: string
  agentName: string
  toolName: string
  summary: string
  reason?: string
  expiresAt?: string
  createdAt: string
}

export interface AgentCard {
  projectId: string | null
  name: string
  iconUrl: string | null
  /** The look saved on the agent; null means the one generated from its id. */
  buddyLook?: BuddyLook | null
  /** The viewer may change the agent's look. */
  canEdit?: boolean
  role: string | null
  owner: { id: string; name: string } | null
  channels: Array<{ conversationId: string; kind: string; name: string | null; slug: string | null; agentTrigger: string; muted: boolean }>
}

export interface UserGroup {
  id: string
  handle: string
  name: string
  description: string | null
  createdById: string
  memberIds: string[]
}

export interface CustomEmoji {
  id: string
  name: string
  url: string
  createdById: string
}

export interface LinkUnfurl {
  url: string
  title: string
  description: string | null
  image: string | null
  siteName: string | null
}

export type NotifyLevel = 'all' | 'mentions' | 'none'
export type MembershipNotifyLevel = NotifyLevel | 'default'

export interface ChatSettings {
  statusEmoji: string | null
  statusText: string | null
  statusExpiresAt: string | null
  dndUntil: string | null
  quietHours: string | null
  timezone: string | null
  notifyDefault: NotifyLevel
  keywords: string[]
  emailDigest: 'off' | 'daily'
}

export type InboxKind = 'mention' | 'dm' | 'thread' | 'reaction' | 'reminder' | 'keyword' | 'broadcast' | 'message'

export interface InboxItem {
  id: string
  kind: InboxKind
  conversationId: string | null
  messageId: string | null
  threadRootId: string | null
  actorUserId: string | null
  title: string
  preview: string
  readAt: string | null
  createdAt: string
  conversation: { id: string; kind: ConversationKind; name: string | null; slug: string | null } | null
}

export type ConversationRef = { id: string; kind: ConversationKind; name: string | null; slug: string | null }

export interface SavedItem {
  savedAt: string
  message: ChatMessage
  conversation: ConversationRef
}

export interface Draft {
  conversationId: string
  threadRootId: string | null
  text: string
  updatedAt: string
  conversation?: ConversationRef
}

export interface ScheduledMessage {
  id: string
  conversationId: string
  threadRootId: string | null
  alsoSentToChannel: boolean
  text: string
  sendAt: string
  status: 'pending' | 'sent' | 'cancelled' | 'failed'
  sentMessageId: string | null
  error: string | null
  conversation: ConversationRef | null
}

export interface Reminder {
  id: string
  text: string
  remindAt: string
  status: 'pending' | 'fired' | 'done' | 'cancelled'
  messageId: string | null
  conversationId: string | null
  firedAt: string | null
  createdAt: string
}

export interface InboxPage {
  items: InboxItem[]
  unread: number
  hasMore: boolean
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

/** The turn behind an agent's final message (see the API's agent-work-log). */
export interface AgentWorkLog {
  parts: Array<Record<string, unknown>>
  startedAt: number
  completedAt: number
  toolCalls: number
}

export type TeamChatEvent =
  | { type: 'ready'; workspaceId: string; userId: string }
  | { type: 'message.created'; conversationId: string; message: ChatMessage; moved?: boolean }
  | { type: 'message.updated'; conversationId: string; message: ChatMessage }
  | { type: 'reaction.changed'; conversationId: string; messageId: string; reactions: ReactionSummary[] }
  | { type: 'agent.delta'; conversationId: string; messageId: string; text: string; tool: string | null; tools?: Array<{ name: string; done: boolean }> }
  | { type: 'conversation.created'; conversationId: string; conversation: ConversationSummary }
  | { type: 'conversation.updated'; conversationId: string; conversation: ConversationSummary }
  | { type: 'member.joined' | 'member.left'; conversationId: string; userId?: string; userIds?: string[] }
  | { type: 'read'; conversationId: string; userId: string; seq: number; unreadCount?: number }
  | { type: 'typing'; conversationId: string; threadRootId: string | null; userId: string; name: string }
  | { type: 'presence'; userId: string; status: PresenceStatus }
  | {
      type: 'notification'
      conversationId: string | null
      messageId: string | null
      threadRootId: string | null
      reason: 'dm' | 'mention' | 'keyword' | 'broadcast' | 'thread' | 'message' | 'reminder'
      title: string
      body: string
    }
  | { type: 'status.changed'; userId: string; status: UserStatus | null }
  | { type: 'inbox.created'; item: InboxItem }
  | { type: 'inbox.read'; unread: number }
  | { type: 'saved.changed'; messageId: string; saved: boolean }
  | { type: 'draft.changed'; draft: Draft }
  | { type: 'scheduled.failed'; id: string; error: string | null }
  | { type: 'groups.changed' }
  | { type: 'agent.updated'; projectId: string | null }
  | { type: 'emoji.changed' }
  | { type: 'huddle.updated'; conversationId: string; huddle: Huddle | null }
  | {
      type: 'huddle.ring'
      conversationId: string
      conversationKind: ConversationKind
      huddleId: string
      from: { userId: string; name: string; image: string | null }
    }
  | { type: 'huddle.declined'; conversationId: string; huddleId: string; userId: string; name: string }

export interface HuddleParticipant {
  userId: string
  name: string
  image: string | null
  joinedAt: string
}

/** A live audio call in a conversation. */
export interface Huddle {
  id: string
  conversationId: string
  workspaceId: string
  startedById: string
  startedAt: string
  participants: HuddleParticipant[]
}

/** A live huddle as the workspace list returns it. */
export interface ActiveHuddle extends Huddle {
  conversationKind: ConversationKind
  /** Started in a DM moments ago without you, so it should still be ringing here. */
  ringing: boolean
}

export interface HuddleJoin {
  huddle: Huddle
  /** LiveKit access token for the huddle's room. */
  token: string
  /** LiveKit server URL (`wss://`). */
  url: string
}

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
    async search(
      workspaceId: string,
      q: string,
      opts: { offset?: number; sort?: 'relevance' | 'recent'; mode?: 'keyword' | 'semantic' } = {},
    ): Promise<SearchResponse> {
      const params = new URLSearchParams({ q, offset: String(opts.offset ?? 0), sort: opts.sort ?? 'relevance', tz: localTimeZone() })
      if (opts.mode === 'semantic') params.set('mode', 'semantic')
      return (await http.get<SearchResponse>(`${ws(workspaceId)}/conversations/search?${params}`)).data
    },
    async ask(workspaceId: string, question: string): Promise<AskResult> {
      return (await http.post<AskResult>(`${ws(workspaceId)}/conversations/ask`, { question })).data
    },
    async chatMode(workspaceId: string): Promise<WorkspaceChatMode> {
      return (await http.get<WorkspaceChatMode>(`${ws(workspaceId)}/chat-mode`)).data
    },
    async setChatMode(workspaceId: string, input: { mode: ChatModeValue; provider?: ExternalChatProvider | null }): Promise<WorkspaceChatMode> {
      return (await http.patch<WorkspaceChatMode>(`${ws(workspaceId)}/chat-mode`, input)).data
    },
    async chatConnectCode(workspaceId: string, provider: ExternalChatProvider): Promise<{ code: string; command: string; expiresAt: string }> {
      return (await http.post<{ code: string; command: string; expiresAt: string }>(
        `${ws(workspaceId)}/chat-installations/${provider}/connect-code`,
        {},
      )).data
    },
    async disconnectChatProvider(workspaceId: string, provider: ExternalChatProvider): Promise<void> {
      await http.delete(`${ws(workspaceId)}/chat-installations/${provider}`)
    },
    async chatSettings(workspaceId: string): Promise<ChatSettings> {
      return (await http.get<{ settings: ChatSettings }>(`${ws(workspaceId)}/chat-settings`)).data.settings
    },
    async updateChatSettings(workspaceId: string, patch: Partial<ChatSettings>): Promise<ChatSettings> {
      return (await http.patch<{ settings: ChatSettings }>(`${ws(workspaceId)}/chat-settings`, patch)).data.settings
    },
    async inbox(workspaceId: string, opts: { unreadOnly?: boolean; before?: string; limit?: number } = {}): Promise<InboxPage> {
      const q = new URLSearchParams()
      if (opts.unreadOnly) q.set('filter', 'unread')
      if (opts.before) q.set('before', opts.before)
      if (opts.limit) q.set('limit', String(opts.limit))
      return (await http.get<InboxPage>(`${ws(workspaceId)}/inbox?${q}`)).data
    },
    async markInboxRead(
      workspaceId: string,
      input: { ids?: string[]; all?: boolean; conversationId?: string; threadRootId?: string; unread?: boolean },
    ): Promise<number> {
      return (await http.post<{ updated: number }>(`${ws(workspaceId)}/inbox/read`, input)).data.updated
    },
    async pin(messageId: string, on: boolean): Promise<ChatMessage> {
      return (await http.post<{ message: ChatMessage }>(`${msg(messageId)}/pin`, { on })).data.message
    },
    async pins(conversationId: string): Promise<ChatMessage[]> {
      return (await http.get<{ messages: ChatMessage[] }>(`${conv(conversationId)}/pins`)).data.messages ?? []
    },
    async save(messageId: string, on: boolean) {
      await http.post(`${msg(messageId)}/save`, { on })
    },
    async saved(workspaceId: string): Promise<SavedItem[]> {
      return (await http.get<{ items: SavedItem[] }>(`${ws(workspaceId)}/saved`)).data.items ?? []
    },
    async drafts(workspaceId: string): Promise<Draft[]> {
      return (await http.get<{ drafts: Draft[] }>(`${ws(workspaceId)}/drafts`)).data.drafts ?? []
    },
    async putDraft(conversationId: string, text: string, threadRootId?: string | null): Promise<Draft> {
      return (await http.post<{ draft: Draft }>(`${conv(conversationId)}/draft`, { text, threadRootId: threadRootId ?? null })).data.draft
    },
    async scheduled(workspaceId: string): Promise<ScheduledMessage[]> {
      return (await http.get<{ scheduled: ScheduledMessage[] }>(`${ws(workspaceId)}/scheduled`)).data.scheduled ?? []
    },
    async schedule(
      conversationId: string,
      input: { text: string; sendAt: string; threadRootId?: string | null; alsoSentToChannel?: boolean },
    ): Promise<ScheduledMessage> {
      return (await http.post<{ scheduled: ScheduledMessage }>(`${conv(conversationId)}/scheduled`, input)).data.scheduled
    },
    async updateScheduled(id: string, patch: { text?: string; sendAt?: string }): Promise<ScheduledMessage> {
      return (await http.patch<{ scheduled: ScheduledMessage }>(`/api/scheduled-messages/${encodeURIComponent(id)}`, patch)).data.scheduled
    },
    async cancelScheduled(id: string) {
      await http.delete(`/api/scheduled-messages/${encodeURIComponent(id)}`)
    },
    async reminders(workspaceId: string): Promise<Reminder[]> {
      return (await http.get<{ reminders: Reminder[] }>(`${ws(workspaceId)}/reminders`)).data.reminders ?? []
    },
    async createReminder(
      workspaceId: string,
      input: { command?: string; text?: string; remindAt?: string; messageId?: string },
    ): Promise<Reminder> {
      return (await http.post<{ reminder: Reminder }>(`${ws(workspaceId)}/reminders`, input)).data.reminder
    },
    async updateReminder(id: string, patch: { status?: 'done' | 'cancelled'; remindAt?: string }): Promise<Reminder> {
      return (await http.patch<{ reminder: Reminder }>(`/api/reminders/${encodeURIComponent(id)}`, patch)).data.reminder
    },
    async groups(workspaceId: string): Promise<UserGroup[]> {
      return (await http.get<{ groups: UserGroup[] }>(`${ws(workspaceId)}/user-groups`)).data.groups ?? []
    },
    async createGroup(workspaceId: string, input: { handle: string; name?: string; description?: string; memberIds?: string[] }) {
      return (await http.post<{ group: UserGroup }>(`${ws(workspaceId)}/user-groups`, input)).data.group
    },
    async updateGroup(id: string, patch: { handle?: string; name?: string; description?: string | null; memberIds?: string[] }) {
      return (await http.patch<{ group: UserGroup }>(`/api/user-groups/${encodeURIComponent(id)}`, patch)).data.group
    },
    async deleteGroup(id: string) {
      await http.delete(`/api/user-groups/${encodeURIComponent(id)}`)
    },
    async emoji(workspaceId: string): Promise<CustomEmoji[]> {
      return (await http.get<{ emoji: CustomEmoji[] }>(`${ws(workspaceId)}/emoji`)).data.emoji ?? []
    },
    async uploadEmoji(workspaceId: string, name: string, file: File | UploadPart): Promise<CustomEmoji> {
      const form = new FormData()
      form.append('name', name)
      form.append('file', file as any)
      const res = await fetch(`${API_URL}${ws(workspaceId)}/emoji`, {
        method: 'POST',
        body: form,
        credentials: Platform.OS === 'web' ? 'include' : 'omit',
        headers: nativeCookieHeader(),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error?.message ?? `Upload failed (${res.status})`)
      }
      return (await res.json()).emoji
    },
    async deleteEmoji(id: string) {
      await http.delete(`/api/custom-emoji/${encodeURIComponent(id)}`)
    },
    async agentCard(workspaceId: string, projectId: string | null): Promise<AgentCard> {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
      return (await http.get<{ card: AgentCard }>(`${ws(workspaceId)}/agent-card${qs}`)).data.card
    },
    /** Save an agent's buddy look; `null` goes back to the look generated from its id. */
    async setAgentBuddyLook(workspaceId: string, projectId: string | null, look: BuddyLook | null): Promise<BuddyLook | null> {
      const key = projectId ?? 'ws'
      const res = await http.request<{ buddyLook: BuddyLook | null }>(`${ws(workspaceId)}/agents/${encodeURIComponent(key)}/buddy`, { method: 'PUT', body: { look } })
      return res.data.buddyLook
    },
    async mentionables(workspaceId: string): Promise<Mentionables> {
      return (await http.get<Mentionables>(`${ws(workspaceId)}/mentionables`)).data
    },
    /** Approvals agents are waiting on that this person can answer, newest first. */
    async pendingApprovals(workspaceId: string): Promise<PendingApproval[]> {
      return (await http.get<{ approvals: PendingApproval[] }>(`${ws(workspaceId)}/approvals/pending`)).data.approvals
    },
    /** Batched: ~400 ids would push the URL past the server's header limit. */
    async presence(workspaceId: string, userIds: string[]): Promise<Record<string, PresenceStatus>> {
      const out: Record<string, PresenceStatus> = {}
      for (let i = 0; i < userIds.length; i += 200) {
        const ids = userIds.slice(i, i + 200).map(encodeURIComponent).join(',')
        Object.assign(out, (await http.get<{ presence: Record<string, PresenceStatus> }>(`${ws(workspaceId)}/presence?userIds=${ids}`)).data.presence)
      }
      return out
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
    async addAgent(id: string, input: { projectId: string | null; trigger?: 'mention' | 'all' | 'keyword' | 'auto'; keywords?: string }) {
      await http.post(`${conv(id)}/agents`, input)
    },
    async setAgentMuted(id: string, projectId: string | null, muted: boolean) {
      await http.patch(`${conv(id)}/agents`, { projectId, muted })
    },
    async removeMember(id: string, memberId: string) {
      await http.delete(`${conv(id)}/members/${encodeURIComponent(memberId)}`)
    },
    async updateMembership(id: string, patch: { starred?: boolean; muted?: boolean; notifyLevel?: MembershipNotifyLevel }) {
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
    async markRead(id: string, seq?: number): Promise<{ lastReadSeq: number; unreadCount?: number }> {
      return (await http.post<{ lastReadSeq: number; unreadCount?: number }>(`${conv(id)}/read`, seq === undefined ? {} : { seq })).data
    },
    async message(messageId: string): Promise<ChatMessage> {
      return (await http.get<{ message: ChatMessage }>(msg(messageId))).data.message
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
    /** What an agent did before its final message: its turn's parts, trimmed for the channel. */
    async workLog(messageId: string): Promise<AgentWorkLog> {
      return (await http.get<AgentWorkLog>(`${msg(messageId)}/work`)).data
    },
    /** Approve or deny an action an agent is waiting on. The first answer wins; later ones throw. */
    async decideApproval(messageId: string, decision: 'approve' | 'deny'): Promise<ChatMessage> {
      return (await http.post<{ message: ChatMessage }>(`${msg(messageId)}/approval`, { decision })).data.message
    },
    async huddles(workspaceId: string): Promise<{ enabled: boolean; huddles: ActiveHuddle[] }> {
      return (await http.get<{ enabled: boolean; huddles: ActiveHuddle[] }>(`${ws(workspaceId)}/huddles`)).data
    },
    async joinHuddle(id: string): Promise<HuddleJoin> {
      return (await http.post<HuddleJoin>(`${conv(id)}/huddle/join`, {})).data
    },
    async leaveHuddle(id: string): Promise<Huddle | null> {
      return (await http.post<{ huddle: Huddle | null }>(`${conv(id)}/huddle/leave`, {})).data.huddle
    },
    async declineHuddle(id: string): Promise<Huddle | null> {
      return (await http.post<{ huddle: Huddle | null }>(`${conv(id)}/huddle/decline`, {})).data.huddle
    },
    /** Leave from a closing tab: survives page unload, never throws. */
    leaveHuddleOnUnload(id: string): void {
      try {
        void fetch(`${API_URL}${conv(id)}/huddle/leave`, {
          method: 'POST',
          keepalive: true,
          credentials: Platform.OS === 'web' ? 'include' : 'omit',
          headers: { 'Content-Type': 'application/json', ...nativeCookieHeader() },
          body: '{}',
        }).catch(() => {})
      } catch {}
    },
    async upload(id: string, file: UploadPart | File): Promise<MessageAttachment> {
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

/** Server file links are root-relative; resolve them against the API origin. */
export function absoluteApiUrl(url: string): string {
  return url.startsWith('/') && API_URL ? `${API_URL}${url}` : url
}

export function nativeCookieHeader(): Record<string, string> {
  if (Platform.OS === 'web') return {}
  const cookie = (authClient as { getCookie?: () => string | null }).getCookie?.()
  return cookie ? { Cookie: cookie } : {}
}

export function realtimeUrls(workspaceId: string): { ws: string; sse: string } {
  const base = `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}`
  return {
    // WebSockets bypass the fetch router; the desktop API relays this one.
    ws: routeUrl(`${base}/rt`, API_URL!).replace(/^http/, 'ws'),
    sse: `${base}/conversations/events`,
  }
}

export function newClientMsgId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
