// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Microsoft Teams as a team chat provider, through the Bot Framework.
 *
 * One multi-tenant Azure bot (TEAMS_APP_ID / TEAMS_APP_PASSWORD) serves
 * every customer; a tenant is bound to a Shogo workspace with a connect code
 * (`@Shogo connect <code>`). Channel messages reach the bot when it is
 * @mentioned, or all of them when the app manifest grants the
 * ChannelMessage.Read.Group resource-specific permission.
 *
 * Endpoint: POST /api/chat-providers/teams/events
 */

import { bearerToken, verifyJwt } from './jwt'
import { chatLinkUrl } from './link'
import type {
  ChannelKind,
  ChatProvider,
  ConversationRef,
  ExternalMessageRef,
  InboundEvent,
  OutboundMessage,
} from './types'

const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com'
const BOT_FRAMEWORK_JWKS = 'https://login.botframework.com/v1/.well-known/keys'
const BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com/.default'

type HttpFetch = (input: string, init?: RequestInit) => Promise<Response>

let http: HttpFetch = (input, init) => fetch(input, init)

/** Test seam for Bot Framework HTTP calls. */
export function _setTeamsFetchForTests(fn: HttpFetch | null): void {
  http = fn ?? ((input, init) => fetch(input, init))
  token = null
}

let token: { value: string; exp: number } | null = null

async function botToken(): Promise<string> {
  if (token && token.exp - 60_000 > Date.now()) return token.value
  const appId = process.env.TEAMS_APP_ID
  const password = process.env.TEAMS_APP_PASSWORD
  if (!appId || !password) throw new Error('TEAMS_APP_ID and TEAMS_APP_PASSWORD are required')
  const tenant = process.env.TEAMS_APP_TENANT_ID || 'botframework.com'
  const res = await http(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: password, scope: BOT_FRAMEWORK_SCOPE }),
  })
  const body = await res.json().catch(() => ({})) as any
  if (!res.ok || !body.access_token) throw new Error(`Bot Framework token request failed: ${body.error ?? res.status}`)
  token = { value: body.access_token, exp: Date.now() + Number(body.expires_in ?? 3600) * 1000 }
  return token.value
}

async function connector(serviceUrl: string, path: string, method: string, body?: unknown): Promise<any> {
  const base = serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`
  const res = await http(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await botToken()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Teams ${method} ${path} failed with HTTP ${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : {}
}

// ─── Inbound ─────────────────────────────────────────────────────────────────

function decodeHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Teams text is light HTML with `<at>Name</at>` mentions; the bot's own mention is dropped. */
export function teamsToPlain(text: string, botMentionTexts: string[]): string {
  let out = text
  for (const mention of botMentionTexts) out = out.split(mention).join(' ')
  out = out.replace(/<at>([^<]+)<\/at>/gi, '@$1')
  return decodeHtml(out).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function splitConversationId(id: string): { channelId: string; threadId: string | null } {
  const [channelId, rest] = id.split(';messageid=')
  return { channelId, threadId: rest ?? null }
}

function channelKindFor(activity: any): ChannelKind {
  const type = activity.conversation?.conversationType
  if (type === 'personal') return 'dm'
  if (type === 'groupChat') return 'private'
  return activity.channelData?.channel?.membershipType === 'private' ? 'private' : 'public'
}

export function teamsEventsFromActivity(activity: any): InboundEvent[] {
  const tenantId = activity?.channelData?.tenant?.id ?? activity?.conversation?.tenantId
  const conversationId = activity?.conversation?.id
  if (!tenantId || !conversationId || !activity.id) return []
  if (activity.from?.id && activity.from.id === activity.recipient?.id) return []
  const { channelId, threadId } = splitConversationId(String(conversationId))

  if (activity.type === 'messageUpdate') {
    return [{ type: 'edit', tenantId, channelId, messageId: String(activity.id), text: teamsToPlain(String(activity.text ?? ''), []) }]
  }
  if (activity.type === 'messageDelete') {
    return [{ type: 'delete', tenantId, channelId, messageId: String(activity.id) }]
  }
  if (activity.type !== 'message' || activity.from?.role === 'bot') return []

  const botId = activity.recipient?.id
  const botMentions = (activity.entities ?? [])
    .filter((e: any) => e.type === 'mention' && e.mentioned?.id === botId && typeof e.text === 'string')
    .map((e: any) => e.text as string)
  const channelKind = channelKindFor(activity)
  const text = teamsToPlain(String(activity.text ?? ''), botMentions)
  if (!text) return []
  return [{
    type: 'message',
    tenantId,
    channelId,
    channelName: activity.channelData?.channel?.name ?? activity.channelData?.team?.name ?? null,
    channelKind,
    messageId: String(activity.id),
    threadId: channelKind === 'dm' ? null : threadId,
    user: {
      externalUserId: String(activity.from?.aadObjectId ?? activity.from?.id),
      displayName: activity.from?.name ?? null,
      email: null,
    },
    text,
    addressed: channelKind === 'dm' || botMentions.length > 0,
    replyContext: {
      serviceUrl: activity.serviceUrl,
      botId: botId ?? null,
      tenantName: activity.channelData?.team?.name ?? null,
    },
  }]
}

// ─── Outbound ────────────────────────────────────────────────────────────────

function serviceUrl(conv: ConversationRef): string {
  const url = conv.installation?.config.serviceUrl
  if (typeof url !== 'string' || !url) throw new Error('Teams install has no serviceUrl yet; send the bot a message first')
  return url
}

/** Only team channels thread; group chats (`@thread.v2`) and 1:1s are flat. */
function conversationPath(channelId: string, threadId: string | null): string {
  const id = threadId && /@thread\.(tacv2|skype)$/.test(channelId) ? `${channelId};messageid=${threadId}` : channelId
  return `v3/conversations/${encodeURIComponent(id)}/activities`
}

/** One bot identity serves every agent, so agent replies carry their name. */
function withAuthor(msg: OutboundMessage): string {
  return msg.author.type === 'agent' ? `**${msg.author.name}:** ${msg.text}` : msg.text
}

export const teamsProvider: ChatProvider = {
  kind: 'teams',
  capabilities: { threads: true, edits: true, reactions: false, files: false, perAgentIdentity: false, readHistory: false },

  async verifyAndParse(req, rawBody) {
    const appId = process.env.TEAMS_APP_ID
    if (!appId) return { response: Response.json({ error: 'Teams is not configured' }, { status: 503 }), events: [] }
    const claims = await verifyJwt(bearerToken(req), {
      jwksUri: process.env.TEAMS_JWKS_URI || BOT_FRAMEWORK_JWKS,
      issuers: [BOT_FRAMEWORK_ISSUER],
      audience: appId,
    })
    if (!claims) return { response: Response.json({ error: 'Invalid Bot Framework token' }, { status: 401 }), events: [] }
    let activity: any
    try {
      activity = JSON.parse(rawBody)
    } catch {
      return { response: Response.json({ error: 'Invalid JSON' }, { status: 400 }), events: [] }
    }
    if (claims.serviceurl && activity.serviceUrl && claims.serviceurl !== activity.serviceUrl) {
      return { response: Response.json({ error: 'serviceUrl mismatch' }, { status: 401 }), events: [] }
    }
    return { events: teamsEventsFromActivity(activity) }
  },

  async postMessage(conv, msg): Promise<ExternalMessageRef> {
    const res = await connector(serviceUrl(conv), conversationPath(conv.externalId!, conv.threadExternalId), 'POST', {
      type: 'message',
      text: withAuthor(msg),
      textFormat: 'markdown',
    })
    return { provider: 'teams', channelId: conv.externalId!, id: String(res.id), threadId: conv.threadExternalId }
  },

  async updateMessage(conv, ref, msg) {
    await connector(serviceUrl(conv), `${conversationPath(ref.channelId, ref.threadId)}/${encodeURIComponent(ref.id)}`, 'PUT', {
      type: 'message',
      id: ref.id,
      text: withAuthor(msg),
      textFormat: 'markdown',
    })
  },

  async sendLinkPrompt(conv, user, pending) {
    const url = chatLinkUrl({
      provider: 'teams',
      tenantId: pending.tenantId,
      externalUserId: user.externalUserId,
      displayName: user.displayName,
      channelId: pending.channelId,
      messageId: pending.messageId,
    })
    const text = `[Link your Shogo account](${url}) so agents can work with your permissions. I'll pick up your message once you're linked.`
    // Link URLs are bearer links: open a 1:1 chat rather than posting in the channel.
    let channelId = conv.externalId!
    if (pending.channelKind !== 'dm') {
      const created = await connector(serviceUrl(conv), 'v3/conversations', 'POST', {
        bot: { id: conv.installation?.botUserId },
        members: [{ id: user.externalUserId }],
        channelData: { tenant: { id: pending.tenantId } },
        tenantId: pending.tenantId,
        isGroup: false,
      })
      channelId = String(created.id)
    }
    await connector(serviceUrl(conv), conversationPath(channelId, null), 'POST', { type: 'message', text, textFormat: 'markdown' })
  },
}
