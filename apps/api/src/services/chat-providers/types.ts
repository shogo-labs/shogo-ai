// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The seam between team chat and the chat surface it runs on.
 *
 * The agent layer (mention routing, a ChatSession per thread, streamed
 * replies, the team_chat_* tools) is provider-agnostic. Shogo's own channels
 * are one provider; Slack, Teams, and Google Chat are others. External
 * channels are mirrored into the conversation tables (`Conversation.provider`
 * + `externalId`, messages with `externalRef`) so agents keep transcripts,
 * search, and memory regardless of where people talk.
 */

import type { ExternalChatProvider } from '../chat-mode'

export type ChatProviderKind = 'shogo' | ExternalChatProvider

export interface ProviderCapabilities {
  threads: boolean
  edits: boolean
  reactions: boolean
  files: boolean
  /** Each agent can post under its own name and avatar (Slack `chat:write.customize`). */
  perAgentIdentity: boolean
  readHistory: boolean
}

/** A workspace's install of an external chat app, with credentials decrypted. */
export interface ChatInstallationRecord {
  id: string
  workspaceId: string
  provider: ExternalChatProvider
  externalTenantId: string
  tenantName: string | null
  botUserId: string | null
  credentials: Record<string, string>
  config: Record<string, unknown>
}

/** Where an outbound message goes. */
export interface ConversationRef {
  workspaceId: string
  conversationId: string
  /** Channel / conversation / space id on the provider; null for Shogo channels. */
  externalId: string | null
  /** Provider message id of the thread root, when replying in a thread. */
  threadExternalId: string | null
  installation: ChatInstallationRecord | null
}

export type OutboundAuthor =
  | { type: 'agent'; projectId: string | null; name: string; /** Avatar shown beside the agent's posts where the platform supports it. */ iconUrl?: string | null }
  | { type: 'system' }

/** A button under a message (approval cards). `value` comes back verbatim when someone presses it. */
export interface OutboundAction {
  id: string
  label: string
  style?: 'primary' | 'danger'
  value: string
}

export interface OutboundMessage {
  text: string
  author: OutboundAuthor
  /** Buttons for platforms that have them; an edit with none removes them. */
  actions?: OutboundAction[]
}

/** A message the provider accepted; `id` is the provider's own message id. */
export interface ExternalMessageRef {
  provider: ExternalChatProvider
  channelId: string
  id: string
  threadId: string | null
  /** Id of the thread this message starts, where threads have their own ids (Google Chat). */
  threadKey?: string | null
}

export interface InboundUser {
  externalUserId: string
  displayName: string | null
  email: string | null
}

export type InboundEvent =
  | {
      type: 'message'
      tenantId: string
      channelId: string
      channelName: string | null
      channelKind: ChannelKind
      messageId: string
      /** Thread this message replies in; null (or messageId) for top-level messages. */
      threadId: string | null
      /** Id of the thread a top-level message starts, where threads have their own ids (Google Chat). */
      threadKey?: string | null
      user: InboundUser
      /** Provider markup already converted to plain text; bot mentions removed. */
      text: string
      /** The message @mentioned the app (always true in DMs). */
      addressed: boolean
      /** Provider data needed to reply later (e.g. Teams serviceUrl). */
      replyContext?: Record<string, unknown>
    }
  | { type: 'edit'; tenantId: string; channelId: string; messageId: string; text: string }
  | { type: 'delete'; tenantId: string; channelId: string; messageId: string }

export interface InboundResult {
  /** Returned to the provider as-is (URL verification, synchronous replies). */
  response?: Response
  events: InboundEvent[]
}

export interface ChatProvider {
  kind: ExternalChatProvider
  capabilities: ProviderCapabilities
  /** Verify a webhook request and normalize it. Throws or returns a 401 response on bad signatures. */
  verifyAndParse(req: Request, rawBody: string): Promise<InboundResult>
  postMessage(conv: ConversationRef, msg: OutboundMessage): Promise<ExternalMessageRef>
  updateMessage?(conv: ConversationRef, ref: ExternalMessageRef, msg: OutboundMessage): Promise<void>
  addReaction?(conv: ConversationRef, ref: ExternalMessageRef, emoji: string): Promise<void>
  readHistory?(conv: ConversationRef, opts: { before?: string; limit: number }): Promise<Array<{ id: string; user: InboundUser; text: string; threadId: string | null }>>
  resolveUser?(installation: ChatInstallationRecord, externalUserId: string): Promise<InboundUser>
  /** Name and visibility of a channel the bridge hasn't seen yet. */
  describeChannel?(installation: ChatInstallationRecord, channelId: string): Promise<{ name: string | null; kind: ChannelKind } | null>
  /**
   * Tell an unlinked person how to link their Shogo account, privately where
   * the platform allows. `pending` is the message that prompted it, so the
   * link flow can resume it.
   */
  sendLinkPrompt?(conv: ConversationRef, user: InboundUser, pending: PendingInbound): Promise<void>
}

export type ChannelKind = 'public' | 'private' | 'dm'

export interface PendingInbound {
  tenantId: string
  channelId: string
  channelKind: ChannelKind
  messageId: string
  threadId: string | null
  text: string
}

/**
 * `provider:channel:message`, with channel and message URI-encoded because
 * Teams and Google Chat ids contain colons and slashes. Slack refs stay
 * readable (`slack:C123:1712.0001`).
 */
export function externalRefFor(ref: Pick<ExternalMessageRef, 'provider' | 'channelId' | 'id'>): string {
  return `${ref.provider}:${encodeURIComponent(ref.channelId)}:${encodeURIComponent(ref.id)}`
}

export function parseExternalRef(value: string | null | undefined): { provider: string; channelId: string; id: string } | null {
  const parts = value?.split(':')
  if (!parts || parts.length !== 3 || !parts.every(Boolean)) return null
  try {
    return { provider: parts[0], channelId: decodeURIComponent(parts[1]), id: decodeURIComponent(parts[2]) }
  } catch {
    return null
  }
}
