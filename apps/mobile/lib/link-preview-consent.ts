// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The sender's half of a shared-link preview.
 *
 * A quote of one of our own messages is already safe by construction: it is
 * fetched per reader, and a reader the server will not let into the
 * conversation gets nothing. What that does *not* cover is the sender's
 * intention. Sharing a link out of a closed conversation — private, a DM —
 * into a channel means people reading it may not be able to open it, and may
 * not realise what they are being shown came from somewhere they cannot see.
 * Slack asks before doing that; so do we.
 *
 * The answer is recorded as a refusal on the message: the URLs, never the
 * content. A message carrying a link never carries a copy of what it points at.
 */
import { teamChatApi } from './team-chat-api'
import { parseConversationLink, parseMessageLink } from './team-chat-links'

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]]+/gi

/** Trimmed of sentence punctuation, which a prose link picks up and a URL does not. */
function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?]+$/, '')
}

export interface ChatLink {
  kind: 'message' | 'conversation'
  conversationId: string
  messageId: string | null
}

/**
 * Every link into this app's chat that a body carries, in order, without
 * duplicates. Only used to decide what to ask about — rendering stays with
 * `extractMessageQuotes`.
 */
export function chatLinksIn(text: string, hosts?: Set<string>): ChatLink[] {
  if (!text || !text.includes('/c/')) return []
  const seen = new Set<string>()
  const out: ChatLink[] = []
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const href = trimUrl(match[0])
    const message = parseMessageLink(href, hosts)
    const link: ChatLink | null = message
      ? { kind: 'message', conversationId: message.conversationId, messageId: message.messageId }
      : (() => {
          const conversation = parseConversationLink(href, hosts)
          return conversation
            ? { kind: 'conversation' as const, conversationId: conversation.conversationId, messageId: null }
            : null
        })()
    if (!link) continue
    const key = `${link.kind}:${link.conversationId}:${link.messageId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(link)
  }
  return out
}

/** Conversations the whole workspace cannot walk into. */
export function isClosedConversation(kind: string): boolean {
  return kind === 'private' || kind === 'dm' || kind === 'group_dm'
}

/**
 * Whether sharing this link needs the sender's decision. Quoting a closed
 * conversation into itself discloses nothing new, so that case stays silent.
 */
export function needsLinkPreviewConsent(
  linked: { id: string; kind: string },
  postingTo: string,
): boolean {
  return isClosedConversation(linked.kind) && linked.id !== postingTo
}

export interface LinkPreviewConsentDeps {
  /** The linked conversation as *this* sender may see it, or null if they cannot. */
  resolve: (link: ChatLink) => Promise<{ id: string; kind: string; name: string | null } | null>
  /** Asks the sender. Resolves true to attach previews. */
  ask: (names: string[]) => Promise<boolean>
}

const api = teamChatApi()

const defaultDeps: LinkPreviewConsentDeps = {
  resolve: async (link) => {
    if (link.kind === 'message' && link.messageId) {
      const message = await api.message(link.messageId)
      const conversation = message.conversation
      return conversation ? { id: conversation.id, kind: conversation.kind, name: conversation.name } : null
    }
    const detail = await api.get(link.conversationId)
    return { id: detail.id, kind: detail.kind, name: detail.name ?? null }
  },
  ask: async (names: string[]) => {
    const { requestLinkPreviewConsent } = await import('../components/team-chat/LinkPreviewConsent')
    return requestLinkPreviewConsent(names)
  },
}

/**
 * The hrefs to withhold a preview for, ready to send as `linkPreviewsOff`.
 *
 * Best-effort by design: a link the sender cannot resolve (they cannot see it
 * either, or the network is down) is not asked about and not withheld. Nothing
 * here may ever stop the message from being sent.
 */
export async function resolveLinkPreviewOptOuts(
  text: string,
  postingTo: string,
  deps: LinkPreviewConsentDeps = defaultDeps,
): Promise<string[]> {
  const links = chatLinksIn(text)
  if (!links.length) return []

  const needsConsent: Array<{ href: string; name: string }> = []
  for (const link of links) {
    let linked: { id: string; kind: string; name: string | null } | null = null
    try {
      linked = await deps.resolve(link)
    } catch {
      continue
    }
    if (!linked) continue
    if (!needsLinkPreviewConsent(linked, postingTo)) continue
    needsConsent.push({ href: hrefFor(link), name: linked.name ?? 'a private conversation' })
  }
  if (!needsConsent.length) return []

  const share = await deps.ask(needsConsent.map((entry) => entry.name))
  if (share) return []
  return Array.from(new Set(needsConsent.map((entry) => entry.href)))
}

/**
 * The identity written into `linkPreviewsOff`. It only has to survive a round
 * trip through the link parsers — matching happens on the conversation and
 * message ids, not on the host — so the web app's origin is the stable choice
 * regardless of where the message was composed.
 */
function hrefFor(link: ChatLink): string {
  const base = 'https://studio.shogo.ai'
  if (link.kind === 'message' && link.messageId) {
    return `${base}/c/${encodeURIComponent(link.conversationId)}?msg=${encodeURIComponent(link.messageId)}`
  }
  return `${base}/c/${encodeURIComponent(link.conversationId)}`
}

/**
 * Parses a link without requiring it to sit on one of *our* origins.
 *
 * A refusal is written by the sender on whatever origin they were using, and
 * the reader may have never heard of that host. The result is only ever used as
 * a comparison key, never to navigate, so accepting the host is safe.
 */
function parseLinkAnyHost(href: string): ChatLink | null {
  let host: string
  try {
    host = new URL(href).host
  } catch {
    return null
  }
  if (!host) return null
  const hosts = new Set([host])
  const message = parseMessageLink(href, hosts)
  if (message) return { kind: 'message', conversationId: message.conversationId, messageId: message.messageId }
  const conversation = parseConversationLink(href, hosts)
  return conversation ? { kind: 'conversation', conversationId: conversation.conversationId, messageId: null } : null
}

const linkKey = (link: ChatLink) => `${link.conversationId}:${link.messageId ?? ''}`

/** URLs whose author declined a preview, from a message's stored blocks. */
export function linkPreviewOptOuts(blocks: unknown): string[] {
  const value = (blocks as { linkPreviewsOff?: unknown } | null | undefined)?.linkPreviewsOff
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * A predicate for "the author declined a preview of this href", or undefined
 * when they declined nothing — so the common case costs no parsing at all.
 */
export function previewOptOutMatcher(blocks: unknown): ((href: string) => boolean) | undefined {
  const urls = linkPreviewOptOuts(blocks)
  if (!urls.length) return undefined
  const keys = new Set<string>()
  for (const url of urls) {
    const link = parseLinkAnyHost(url)
    if (link) keys.add(linkKey(link))
  }
  if (!keys.size) return undefined
  return (href: string) => {
    const link = parseLinkAnyHost(href)
    return !!link && keys.has(linkKey(link))
  }
}
