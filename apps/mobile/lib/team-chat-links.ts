// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Links to a single team chat message: `/c/<conversationId>?msg=<id>`, plus
 * `thread=<rootId>` for thread replies. Pasted back into chat, links on this
 * app's own hosts open in place instead of in a browser.
 */
import { Platform } from 'react-native'
import { openConversationTarget } from './team-chat-nav'

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

/** The page where someone asks to join a huddle (works for guests without an account). */
export function huddleJoinLink(token: string, base = linkBase()): string {
  return `${base}/huddle/join/${encodeURIComponent(token)}`
}

/** Link that opens a channel with its doc showing. */
export function docLink(conversationId: string, base = linkBase()): string {
  return `${base}/c/${encodeURIComponent(conversationId)}?doc=1`
}

/**
 * A file in a workspace, opened in that workspace's agent chat
 * (`/agent?workspace=<id>&file=<path>`). Anyone who is a member of the
 * workspace opens the same file; the link carries no token, so access is
 * whatever the viewer already has (SHO-284).
 *
 * The path is the same workspace-relative path the viewer shows — a mounted
 * project's file stays `<projectId>/…`.
 */
export function workspaceFileLink(
  target: { workspaceId: string; path: string },
  base = linkBase(),
): string {
  const q = new URLSearchParams()
  q.set('workspace', target.workspaceId)
  q.set('file', target.path)
  return `${base}/agent?${q}`
}

/**
 * The channel a `/c/<id>` link points at, with the pane the link asked for:
 * `msg` for a message, `thread` for one of its replies, `doc`, `files`,
 * `card`/`board` for a side pane. Every shape our own links produce has to come
 * back here, or the link leaves the app on web and reloads the page.
 */
export interface ConversationLinkTarget {
  conversationId: string
  params: Record<string, string>
}

/** Query params the channel route understands; anything else is dropped. */
const CHANNEL_PARAMS = ['msg', 'thread', 'doc', 'files', 'card', 'board', 'project', 'profile'] as const

export function parseConversationLink(href: string, hosts: Set<string> = ownHosts()): ConversationLinkTarget | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (!hosts.has(url.host)) return null
  const match = url.pathname.match(/^\/c\/([^/]+)\/?$/)
  if (!match) return null
  const params: Record<string, string> = {}
  for (const key of CHANNEL_PARAMS) {
    const value = url.searchParams.get(key)
    if (value) params[key] = value
  }
  return { conversationId: decodeURIComponent(match[1]!), params }
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

/**
 * The attachment a shared file link points at. Both shapes count: the
 * capability URL an attachment carries (`/api/conversation-files/<id>?t=…`)
 * and the in-app viewer's own path (`/f/<id>`), because either can end up in
 * a message, a doc or a person's clipboard.
 */
export function parseFileLink(href: string, hosts: Set<string> = ownHosts()): { attachmentId: string } | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (!hosts.has(url.host)) return null
  const match = url.pathname.match(/^\/(?:api\/conversation-files|f)\/([^/]+)\/?$/)
  if (!match) return null
  return { attachmentId: decodeURIComponent(match[1]!) }
}

/**
 * The workspace and file a `/agent?workspace=…&file=…` link points at, when
 * that link is one of ours. Both params are required: a bare `/agent` link is
 * the landing chat, not a file (SHO-284).
 */
export function parseWorkspaceFileLink(
  href: string,
  hosts: Set<string> = ownHosts(),
): { workspaceId: string; path: string } | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (!hosts.has(url.host)) return null
  if (!/^\/agent\/?$/.test(url.pathname)) return null
  const workspaceId = url.searchParams.get('workspace')
  const path = url.searchParams.get('file')
  if (!workspaceId || !path) return null
  return { workspaceId, path }
}

/**
 * Links this app can open in place: a channel (with whatever pane it asked for
 * — a message, a thread, its doc, a card), or a shared file.
 *
 * Returns true when it handled the link, which is what a markdown renderer's
 * `onLinkPress` reads. Lives here rather than in `MessageRow` so a card inside
 * a message (a rendered markdown attachment) can route links into the app
 * without importing the row that renders it.
 */
export function openMessageLinkInApp(href: string): boolean {
  // Every `/c/<id>` link is ours to open, not just the ones carrying `msg`:
  // `?doc=1` and `?card=<id>` are shapes our own links produce, and falling
  // through to the browser there is a full page reload on web.
  const target = parseConversationLink(href)
  if (target) {
    void import('expo-router').then(({ router }) =>
      openConversationTarget(router, {
        conversationId: target.conversationId,
        thread: target.params.thread,
        msg: target.params.msg,
        board: target.params.board,
        card: target.params.card,
        doc: target.params.doc === '1',
        files: target.params.files === '1',
        project: target.params.project,
        profile: target.params.profile,
      }),
    )
    return true
  }
  // A shared file link is the attachment's own URL; opening it in the viewer
  // is what keeps it out of a browser tab.
  const file = parseFileLink(href)
  if (file) {
    void import('expo-router').then(({ router }) =>
      router.push({ pathname: '/(app)/f/[attachmentId]', params: { attachmentId: file.attachmentId } } as any),
    )
    return true
  }
  // A workspace file link opens that workspace's agent chat on that file,
  // rather than reloading the page on web (SHO-284).
  const workspaceFile = parseWorkspaceFileLink(href)
  if (workspaceFile) {
    void import('expo-router').then(({ router }) =>
      router.push({
        pathname: '/(app)/agent',
        params: { workspace: workspaceFile.workspaceId, file: workspaceFile.path },
      } as any),
    )
    return true
  }
  return false
}
