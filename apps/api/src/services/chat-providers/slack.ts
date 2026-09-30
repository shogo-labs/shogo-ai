// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Slack as a team chat provider: Events API in, Web API out.
 *
 * Reuses the Slack app from the Slack agent integration (same OAuth install,
 * signing secret, and account-link flow). While a workspace's team chat runs
 * on Slack, `/integrations/slack/events` hands message events here instead
 * of to the single-agent Slack flow.
 */

import { getFrontendUrl } from '../../lib/cloud-urls'
import { createSlackOAuthState, verifySlackSignature } from '../../lib/slack-agent/security'
import { installationForTenant } from './installations'
import type {
  ChannelKind,
  ChatInstallationRecord,
  ChatProvider,
  ConversationRef,
  ExternalMessageRef,
  InboundEvent,
  InboundUser,
  OutboundMessage,
  PendingInbound,
} from './types'

const SLACK_API = 'https://slack.com/api'

type SlackCall = (token: string, method: string, body: Record<string, unknown>) => Promise<any>

let callSlack: SlackCall = async (token, method, body) => {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Slack ${method} failed with HTTP ${res.status}`)
  return res.json()
}

/** Test seam for the Slack Web API. */
export function _setSlackCallForTests(fn: SlackCall | null): void {
  callSlack = fn ?? callSlack
}

async function api(installation: ChatInstallationRecord | null, method: string, body: Record<string, unknown>): Promise<any> {
  const token = installation?.credentials.botToken
  if (!token) throw new Error('Slack install has no bot token')
  const result = await callSlack(token, method, body)
  if (result?.ok === false) {
    const err = new Error(`Slack ${method}: ${result.error}`)
    ;(err as any).slackError = result.error
    throw err
  }
  return result
}

export function slackStateSecret(): string {
  return process.env.BETTER_AUTH_SECRET || process.env.SLACK_SIGNING_SECRET || ''
}

// ─── Text conversion ─────────────────────────────────────────────────────────

function decodeEntities(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** Slack mrkdwn to plain text; the app's own mention is dropped. */
export function slackToPlain(text: string, botUserId: string | null): string {
  return decodeEntities(
    text
      .replace(/<@(\w+)(?:\|([^>]+))?>/g, (_m, id: string, label?: string) =>
        botUserId && id === botUserId ? ' ' : `@${label ?? id}`)
      .replace(/<#[A-Z0-9]+\|([^>]+)>/gi, '#$1')
      .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/gi, '@$1')
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
      .replace(/<(https?:[^>]+)>/g, '$1'),
  ).replace(/[ \t]+/g, ' ').trim()
}

/** Chat Markdown to Slack mrkdwn (bold, links, headings, strikethrough). */
export function markdownToSlack(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return escaped
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<$2|$1>')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/~~([^~\n]+)~~/g, '~$1~')
}

function channelKindFor(event: Record<string, any>): ChannelKind {
  const type = event.channel_type
  if (type === 'im') return 'dm'
  if (type === 'group' || type === 'mpim') return 'private'
  if (type === 'channel') return 'public'
  const id = String(event.channel ?? '')
  return id.startsWith('D') ? 'dm' : id.startsWith('G') ? 'private' : 'public'
}

const PASSTHROUGH_SUBTYPES = new Set(['file_share', 'thread_broadcast'])

/** Normalize one Events API payload. Bot messages (our own posts included) are dropped. */
export function slackEventsFromPayload(payload: any, botUserId: string | null): InboundEvent[] {
  const event = payload?.event
  const tenantId = payload?.team_id
  if (!event || !tenantId) return []
  if (event.type !== 'message' && event.type !== 'app_mention') return []
  const channelId = event.channel ? String(event.channel) : null
  if (!channelId) return []

  if (event.subtype === 'message_changed') {
    const msg = event.message
    if (!msg?.ts || msg.bot_id || !msg.user) return []
    return [{ type: 'edit', tenantId, channelId, messageId: String(msg.ts), text: slackToPlain(String(msg.text ?? ''), botUserId) }]
  }
  if (event.subtype === 'message_deleted') {
    return event.deleted_ts ? [{ type: 'delete', tenantId, channelId, messageId: String(event.deleted_ts) }] : []
  }
  if (event.subtype && !PASSTHROUGH_SUBTYPES.has(event.subtype)) return []
  if (event.bot_id || !event.user || (botUserId && event.user === botUserId) || !event.ts) return []

  const raw = String(event.text ?? '')
  const channelKind = channelKindFor(event)
  const text = slackToPlain(raw, botUserId)
  if (!text) return []
  return [{
    type: 'message',
    tenantId,
    channelId,
    channelName: null,
    channelKind,
    messageId: String(event.ts),
    threadId: event.thread_ts ? String(event.thread_ts) : null,
    user: { externalUserId: String(event.user), displayName: null, email: null },
    text,
    addressed: event.type === 'app_mention' || channelKind === 'dm' || (!!botUserId && raw.includes(`<@${botUserId}>`)),
  }]
}

// ─── Provider ────────────────────────────────────────────────────────────────

function toRef(conv: ConversationRef, ts: string, channel?: string): ExternalMessageRef {
  return { provider: 'slack', channelId: channel ?? conv.externalId!, id: ts, threadId: conv.threadExternalId }
}

async function post(conv: ConversationRef, msg: OutboundMessage): Promise<ExternalMessageRef> {
  const body: Record<string, unknown> = {
    channel: conv.externalId,
    text: markdownToSlack(msg.text) || ' ',
    unfurl_links: false,
    ...(conv.threadExternalId ? { thread_ts: conv.threadExternalId } : {}),
  }
  // Per-agent names need chat:write.customize; older installs fall back to the app's name.
  if (msg.author.type === 'agent') body.username = msg.author.name
  try {
    const res = await api(conv.installation, 'chat.postMessage', body)
    return toRef(conv, String(res.ts), res.channel)
  } catch (err: any) {
    if (!body.username || err?.slackError !== 'missing_scope') throw err
    delete body.username
    const res = await api(conv.installation, 'chat.postMessage', body)
    return toRef(conv, String(res.ts), res.channel)
  }
}

export const slackProvider: ChatProvider = {
  kind: 'slack',
  capabilities: { threads: true, edits: true, reactions: true, files: false, perAgentIdentity: true, readHistory: true },

  async verifyAndParse(req, rawBody) {
    const ok = verifySlackSignature({
      rawBody,
      timestamp: req.headers.get('x-slack-request-timestamp') ?? undefined,
      signature: req.headers.get('x-slack-signature') ?? undefined,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
    })
    if (!ok) return { response: Response.json({ error: 'Invalid Slack signature' }, { status: 401 }), events: [] }
    let payload: any
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return { response: Response.json({ error: 'Invalid JSON' }, { status: 400 }), events: [] }
    }
    if (payload.type === 'url_verification' && payload.challenge) {
      return { response: Response.json({ challenge: payload.challenge }), events: [] }
    }
    const installation = payload.team_id ? await installationForTenant('slack', payload.team_id) : null
    return { events: slackEventsFromPayload(payload, installation?.botUserId ?? null) }
  },

  postMessage: post,

  async updateMessage(conv, ref, msg) {
    await api(conv.installation, 'chat.update', { channel: ref.channelId, ts: ref.id, text: markdownToSlack(msg.text) || ' ' })
  },

  async addReaction(conv, ref, emoji) {
    await api(conv.installation, 'reactions.add', { channel: ref.channelId, timestamp: ref.id, name: emoji.replace(/:/g, '') })
  },

  async readHistory(conv, opts) {
    const method = conv.threadExternalId ? 'conversations.replies' : 'conversations.history'
    const res = await api(conv.installation, method, {
      channel: conv.externalId,
      ...(conv.threadExternalId ? { ts: conv.threadExternalId } : {}),
      ...(opts.before ? { latest: opts.before } : {}),
      limit: opts.limit,
    })
    return (res.messages ?? [])
      .filter((m: any) => m.user && !m.bot_id)
      .map((m: any) => ({
        id: String(m.ts),
        user: { externalUserId: String(m.user), displayName: null, email: null },
        text: slackToPlain(String(m.text ?? ''), conv.installation?.botUserId ?? null),
        threadId: m.thread_ts ? String(m.thread_ts) : null,
      }))
  },

  async resolveUser(installation, externalUserId): Promise<InboundUser> {
    const res = await api(installation, 'users.info', { user: externalUserId })
    const profile = res.user?.profile ?? {}
    return {
      externalUserId,
      displayName: profile.display_name || profile.real_name || res.user?.name || null,
      email: profile.email ?? null,
    }
  },

  async describeChannel(installation, channelId) {
    const res = await api(installation, 'conversations.info', { channel: channelId })
    const ch = res.channel ?? {}
    const kind: ChannelKind = ch.is_im ? 'dm' : ch.is_private || ch.is_mpim ? 'private' : 'public'
    return { name: ch.name ?? null, kind }
  },

  async sendLinkPrompt(conv, user, pending: PendingInbound) {
    const state = createSlackOAuthState({
      mode: 'link',
      slackTeamId: pending.tenantId,
      slackUserId: user.externalUserId,
      pendingChannel: pending.channelId,
      pendingThreadTs: pending.threadId ?? pending.messageId,
      pendingTs: pending.messageId,
      pendingText: pending.text.slice(0, 1500) || undefined,
    }, slackStateSecret())
    const url = `${getFrontendUrl()}/auth/slack-link?state=${encodeURIComponent(state)}`
    // Link URLs are bearer links, so they go to the person's DM, not the channel.
    let channel = conv.externalId!
    let threadTs = conv.threadExternalId
    if (!channel.startsWith('D')) {
      const dm = await api(conv.installation, 'conversations.open', { users: user.externalUserId }).catch(() => null)
      if (dm?.channel?.id) {
        channel = dm.channel.id
        threadTs = null
      }
    }
    await api(conv.installation, 'chat.postMessage', {
      channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: 'Link your Shogo account so agents can work with your permissions.',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'Link your Shogo account so agents can work with your permissions. I’ll pick up your message once you’re linked.' } },
        {
          type: 'actions',
          elements: [{ type: 'button', text: { type: 'plain_text', text: 'Link Shogo account' }, url, action_id: 'slack_link_account' }],
        },
      ],
    })
  },
}
