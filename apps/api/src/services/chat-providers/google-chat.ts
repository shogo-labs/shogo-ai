// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Google Chat as a team chat provider: a Chat app with an HTTP endpoint,
 * replying with its service account (scope chat.bot).
 *
 * Google Chat has no tenant id in events, so an install is keyed by the
 * sender's email domain (one Google Workspace customer). Spaces deliver
 * messages to the app when it's @mentioned; DMs deliver every message.
 *
 * Endpoint: POST /api/chat-providers/google_chat/events
 * Env: GOOGLE_CHAT_AUDIENCE (project number, or the endpoint URL when the
 * app is configured for ID-token auth), GOOGLE_CHAT_SERVICE_ACCOUNT (JSON).
 */

import { bearerToken, signJwt, verifyJwt } from './jwt'
import { chatLinkUrl } from './link'
import type { ChannelKind, ChatProvider, ConversationRef, ExternalMessageRef, InboundEvent, OutboundMessage } from './types'

const CHAT_ISSUER = 'chat@system.gserviceaccount.com'
const CHAT_JWKS = `https://www.googleapis.com/service_accounts/v1/jwk/${CHAT_ISSUER}`
const GOOGLE_ID_JWKS = 'https://www.googleapis.com/oauth2/v3/certs'
const CHAT_API = 'https://chat.googleapis.com/v1'
const SCOPE = 'https://www.googleapis.com/auth/chat.bot'

type HttpFetch = (input: string, init?: RequestInit) => Promise<Response>

let http: HttpFetch = (input, init) => fetch(input, init)

/** Test seam for Google HTTP calls. */
export function _setGoogleChatFetchForTests(fn: HttpFetch | null): void {
  http = fn ?? ((input, init) => fetch(input, init))
  token = null
}

let token: { value: string; exp: number } | null = null

function serviceAccount(): { client_email: string; private_key: string; private_key_id?: string; token_uri?: string } {
  const raw = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT
  if (!raw) throw new Error('GOOGLE_CHAT_SERVICE_ACCOUNT is required')
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')
  return JSON.parse(json)
}

async function accessToken(): Promise<string> {
  if (token && token.exp - 60_000 > Date.now()) return token.value
  const sa = serviceAccount()
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token'
  const now = Math.floor(Date.now() / 1000)
  const assertion = signJwt({ iss: sa.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 }, sa.private_key, sa.private_key_id)
  const res = await http(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  const body = await res.json().catch(() => ({})) as any
  if (!res.ok || !body.access_token) throw new Error(`Google token request failed: ${body.error ?? res.status}`)
  token = { value: body.access_token, exp: Date.now() + Number(body.expires_in ?? 3600) * 1000 }
  return token.value
}

async function chatApi(path: string, method: string, body: unknown): Promise<any> {
  const res = await http(`${CHAT_API}/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken()}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Google Chat ${method} ${path} failed with HTTP ${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : {}
}

// ─── Inbound ─────────────────────────────────────────────────────────────────

function tenantFor(user: any, space: any): string | null {
  const email = typeof user?.email === 'string' ? user.email : ''
  const domain = email.includes('@') ? email.split('@').pop()!.toLowerCase() : ''
  return domain || space?.name || null
}

function channelKindFor(space: any): ChannelKind {
  if (space?.type === 'DM' || space?.spaceType === 'DIRECT_MESSAGE' || space?.singleUserBotDm) return 'dm'
  return space?.accessSettings?.accessState === 'DISCOVERABLE' ? 'public' : 'private'
}

/** Accepts both the Chat API event format and the Workspace add-on (`chat.messagePayload`) format. */
export function googleChatEventsFromBody(body: any): InboundEvent[] {
  const addOn = body?.chat
  const type = addOn ? (addOn.messagePayload ? 'MESSAGE' : null) : body?.type
  const message = addOn ? addOn.messagePayload?.message : body?.message
  const space = addOn ? addOn.messagePayload?.space ?? message?.space : body?.space ?? message?.space
  const user = addOn ? addOn.user : body?.user ?? message?.sender
  if (type !== 'MESSAGE' || !message?.name || !space?.name) return []
  if (message.sender?.type === 'BOT' || user?.type === 'BOT') return []
  const tenantId = tenantFor(message.sender ?? user, space)
  if (!tenantId) return []

  const channelKind = channelKindFor(space)
  const botMentioned = (message.annotations ?? []).some(
    (a: any) => a.type === 'USER_MENTION' && a.userMention?.user?.type === 'BOT',
  )
  const text = String(message.argumentText ?? message.text ?? '').replace(/[ \t]+/g, ' ').trim()
  if (!text) return []
  const threadName = message.thread?.name ? String(message.thread.name) : null
  const isReply = !!message.threadReply && !!threadName
  return [{
    type: 'message',
    tenantId,
    channelId: String(space.name),
    channelName: space.displayName ?? null,
    channelKind,
    messageId: String(message.name),
    threadId: isReply ? threadName : null,
    threadKey: isReply ? null : threadName,
    user: {
      externalUserId: String((message.sender ?? user)?.name ?? ''),
      displayName: (message.sender ?? user)?.displayName ?? null,
      email: (message.sender ?? user)?.email ?? null,
    },
    text,
    addressed: channelKind === 'dm' || botMentioned || !!message.argumentText,
    replyContext: { tenantName: tenantId.includes('/') ? null : tenantId },
  }]
}

// ─── Outbound ────────────────────────────────────────────────────────────────

/** Chat Markdown to Google Chat's formatting (`*bold*`, `<url|label>`). */
export function markdownToGoogleChat(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<$2|$1>')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/~~([^~\n]+)~~/g, '~$1~')
}

function withAuthor(msg: OutboundMessage): string {
  const text = markdownToGoogleChat(msg.text)
  return msg.author.type === 'agent' ? `*${msg.author.name}:* ${text}` : text
}

async function create(conv: ConversationRef, body: Record<string, unknown>): Promise<ExternalMessageRef> {
  const query = conv.threadExternalId ? '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' : ''
  const res = await chatApi(`${conv.externalId}/messages${query}`, 'POST', {
    ...body,
    ...(conv.threadExternalId ? { thread: { name: conv.threadExternalId } } : {}),
  })
  return {
    provider: 'google_chat',
    channelId: conv.externalId!,
    id: String(res.name),
    threadId: conv.threadExternalId,
    threadKey: res.thread?.name ?? null,
  }
}

export const googleChatProvider: ChatProvider = {
  kind: 'google_chat',
  capabilities: { threads: true, edits: true, reactions: false, files: false, perAgentIdentity: false, readHistory: false },

  async verifyAndParse(req, rawBody) {
    const audience = process.env.GOOGLE_CHAT_AUDIENCE
    if (!audience) return { response: Response.json({ error: 'Google Chat is not configured' }, { status: 503 }), events: [] }
    const idToken = /^https?:\/\//.test(audience)
    const claims = await verifyJwt(bearerToken(req), idToken
      ? { jwksUri: GOOGLE_ID_JWKS, issuers: ['https://accounts.google.com', 'accounts.google.com'], audience }
      : { jwksUri: process.env.GOOGLE_CHAT_JWKS_URI || CHAT_JWKS, issuers: [CHAT_ISSUER], audience })
    if (!claims || (idToken && (claims.email !== CHAT_ISSUER || claims.email_verified === false))) {
      return { response: Response.json({ error: 'Invalid Google Chat token' }, { status: 401 }), events: [] }
    }
    let body: any
    try {
      body = JSON.parse(rawBody)
    } catch {
      return { response: Response.json({ error: 'Invalid JSON' }, { status: 400 }), events: [] }
    }
    return { events: googleChatEventsFromBody(body) }
  },

  postMessage(conv, msg) {
    return create(conv, { text: withAuthor(msg) })
  },

  async updateMessage(_conv, ref, msg) {
    await chatApi(`${ref.id}?updateMask=text`, 'PATCH', { text: withAuthor(msg) })
  },

  async sendLinkPrompt(conv, user, pending) {
    const url = chatLinkUrl({
      provider: 'google_chat',
      tenantId: pending.tenantId,
      externalUserId: user.externalUserId,
      displayName: user.displayName,
      channelId: pending.channelId,
      messageId: pending.messageId,
    })
    // In spaces the prompt is a private message only the requester sees.
    await create(conv, {
      text: `<${url}|Link your Shogo account> so agents can work with your permissions. I'll pick up your message once you're linked.`,
      ...(pending.channelKind === 'dm' ? {} : { privateMessageViewer: { name: user.externalUserId } }),
    })
  },
}
