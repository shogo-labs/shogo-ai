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
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (!hosts.has(url.host)) return null
  const match = url.pathname.match(/^\/c\/([^/]+)\/?$/)
  const messageId = url.searchParams.get('msg')
  if (!match || !messageId) return null
  return {
    conversationId: decodeURIComponent(match[1]!),
    messageId,
    threadRootId: url.searchParams.get('thread'),
  }
}
