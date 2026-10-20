// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Links to a single team chat message: `/c/<conversationId>?msg=<id>`, plus
 * `thread=<rootId>` for thread replies. Pasted back into chat, links on this
 * app's own hosts open in place instead of in a browser.
 */
import { Platform } from 'react-native'

const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://studio.shogo.ai'

export interface MessageLinkTarget {
  conversationId: string
  messageId: string
  threadRootId?: string | null
}

function isDesktopApp(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as unknown as { shogoDesktop?: { isDesktop?: boolean } }).shogoDesktop?.isDesktop
}

/** Where shared links point: this page's origin in a browser, the web app everywhere else. */
export function linkBase(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && !isDesktopApp() && /^https?:/.test(window.location.origin)) {
    return window.location.origin
  }
  return WEB_URL.replace(/\/+$/, '')
}

export function messageLink(target: MessageLinkTarget, base = linkBase()): string {
  const q = new URLSearchParams()
  if (target.threadRootId) q.set('thread', target.threadRootId)
  q.set('msg', target.messageId)
  return `${base}/c/${encodeURIComponent(target.conversationId)}?${q}`
}

/** Link that opens a channel with its doc showing. */
export function docLink(conversationId: string, base = linkBase()): string {
  return `${base}/c/${encodeURIComponent(conversationId)}?doc=1`
}

function ownHosts(): Set<string> {
  const hosts = new Set<string>()
  try {
    hosts.add(new URL(WEB_URL).host)
  } catch {}
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.host) hosts.add(window.location.host)
  return hosts
}

/** The message a link points to, when it's a message link on one of this app's hosts. */
export function parseMessageLink(href: string, hosts: Set<string> = ownHosts()): MessageLinkTarget | null {
  const target = parseChatLink(href, hosts)
  if (!target || target.kind !== 'message') return null
  const { conversationId, messageId, threadRootId } = target
  if (!messageId) return null
  return { conversationId, messageId, threadRootId }
}

/** A link into this app: either one message, or just the conversation. */
export interface ChatLinkTarget {
  kind: 'message' | 'conversation'
  conversationId: string
  /** Always set for `kind: 'message'`. */
  messageId: string | null
  /** Thread a message reply belongs to, when the link carries one. */
  threadRootId: string | null
}

/**
 * Any link into this app's chat — `/c/<id>` with or without `?msg=`. Both are
 * worth previewing and both must open in place; a bare conversation link is
 * just the message link without a target message.
 */
export function parseChatLink(href: string, hosts: Set<string> = ownHosts()): ChatLinkTarget | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (!hosts.has(url.host)) return null
  const match = url.pathname.match(/^\/c\/([^/]+)\/?$/)
  if (!match) return null
  const messageId = url.searchParams.get('msg')
  const hasDoc = url.searchParams.get('doc') === '1'
  // `?doc=1` is a link to the channel's canvas, not to a conversation view.
  if (!messageId && hasDoc) return null
  return {
    kind: messageId ? 'message' : 'conversation',
    conversationId: decodeURIComponent(match[1]!),
    messageId,
    threadRootId: url.searchParams.get('thread'),
  }
}

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`)\]]+/gi
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/

/**
 * Every chat link in a message body, in order and without duplicates. Used to
 * decide what to preview and, on send, what needs the sender's consent.
 */
export function chatLinksInText(text: string, hosts: Set<string> = ownHosts()): ChatLinkTarget[] {
  if (!text || !text.includes('/c/')) return []
  const seen = new Set<string>()
  const out: ChatLinkTarget[] = []
  for (const match of text.matchAll(URL_IN_TEXT_RE)) {
    const href = match[0].replace(TRAILING_PUNCTUATION_RE, '')
    const target = parseChatLink(href, hosts)
    if (!target) continue
    const key = `${target.kind}:${target.conversationId}:${target.messageId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(target)
  }
  return out
}

/** The canonical link for a target, so an opt-out can be matched against it. */
export function chatLinkHref(target: ChatLinkTarget, base = linkBase()): string {
  const q = new URLSearchParams()
  if (target.threadRootId) q.set('thread', target.threadRootId)
  if (target.messageId) q.set('msg', target.messageId)
  const qs = q.toString()
  return `${base}/c/${encodeURIComponent(target.conversationId)}${qs ? `?${qs}` : ''}`
}

/**
 * Host-independent identity of a link. Opt-outs are stored as URLs (so the
 * server can validate them), but they have to match the same link written on
 * any of this app's origins — so matching happens on this key instead.
 */
export function chatLinkKey(target: ChatLinkTarget): string {
  return `${target.kind}:${target.conversationId}:${target.messageId ?? ''}`
}

/** A message carrying more links than this gets previews for the first few only. */
export const MAX_LINK_PREVIEWS = 3

/** URLs whose author declined a preview, from the message's stored blocks. */
export function linkPreviewOptOuts(blocks: unknown): string[] {
  const value = (blocks as { linkPreviewsOff?: unknown } | null | undefined)?.linkPreviewsOff
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * The identity a link carries, whichever of this app's origins wrote it.
 *
 * Opt-outs are stored as full URLs, and the URL a sender writes uses *their*
 * origin — which a different reader may not have in `ownHosts()`. Matching only
 * the shape (`/c/<id>?msg=<id>`) keeps a declined preview declined everywhere.
 * Safe by construction: the result is only used as a comparison key, never to
 * navigate.
 */
function parseChatLinkAnyHost(href: string): ChatLinkTarget | null {
  let host: string
  try {
    host = new URL(href).host
  } catch {
    return null
  }
  if (!host) return null
  return parseChatLink(href, new Set([host]))
}

/**
 * The links on a message that should render a preview card: ours, not the
 * message linking to itself, and not one whose author declined. This is a pure
 * decision — whether the reader may actually *see* the preview is answered per
 * request by the server, never here.
 */
export function previewTargetsFor(
  text: string,
  blocks: unknown,
  opts: { hosts?: Set<string>; selfId?: string | null } = {},
): ChatLinkTarget[] {
  const off = new Set<string>()
  for (const url of linkPreviewOptOuts(blocks)) {
    const target = parseChatLinkAnyHost(url)
    if (target) off.add(chatLinkKey(target))
  }
  const out: ChatLinkTarget[] = []
  for (const target of chatLinksInText(text, opts.hosts)) {
    if (off.has(chatLinkKey(target))) continue
    if (opts.selfId && target.kind === 'message' && target.messageId === opts.selfId) continue
    out.push(target)
    if (out.length >= MAX_LINK_PREVIEWS) break
  }
  return out
}
