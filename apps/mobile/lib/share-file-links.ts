// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Links in chat that point at a file the app can serve itself: a `share_file`
 * download link (`/api/f/<token>`) and the stored chat/conversation files
 * (`/api/conversation-files/...`, `/api/chat-attachments/...`).
 *
 * These are never browser links. `MarkdownText` renders one as a file chip and
 * hands it to the in-app viewer, so a click stays inside the app instead of
 * opening a tab (or, on desktop, `shell.openExternal`) on raw API JSON.
 *
 * Pure: no React, no network. The host allow-list is a parameter so the
 * resolution can be tested without a browser.
 */
import { Platform } from 'react-native'

const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://studio.shogo.ai'

export type InAppFileKind = 'share' | 'stored'

export interface InAppFileRef {
  kind: InAppFileKind
  /** The href exactly as written in the message; the viewer fetches this. */
  href: string
  /** Filename to show on the chip. */
  name: string
  /** Decoded claims of a share token. Display only — never trusted. */
  path?: string | null
}

/**
 * `/api/f/<payload>.<sig>` (the API's route) and the legacy `/f/<payload>.<sig>`
 * the runtime minted earlier. Both segments are base64url.
 */
const SHARE_FILE_PATH_RE = /^\/(?:api\/)?f\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)$/

/** Same shapes `apps/desktop/src/window-manager.ts` treats as in-app. */
const STORED_FILE_PATH_RE = /^\/api\/(?:cloud\/[^/]+\/)?(?:conversation-files|chat-attachments)\//

/** Hosts that only ever exist on the machine or LAN running the app. */
const LOCAL_HOST_RE = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.0\.2\.2)$/i

let cachedHosts: Set<string> | null = null

function ownHosts(): Set<string> {
  if (cachedHosts) return cachedHosts
  const hosts = new Set<string>()
  // `share_file` mints its link on the API's public origin, which is the app's
  // own origin in cloud and `localhost:<port>` on the desktop.
  const candidates = [
    WEB_URL,
    process.env.EXPO_PUBLIC_API_URL,
    process.env.EXPO_PUBLIC_WEB_URL,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      hosts.add(new URL(candidate).host)
    } catch {}
  }
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    if (window.location?.host) hosts.add(window.location.host)
    const bridge = (window as unknown as {
      n?: { apiUrl?: string }
      shogoDesktop?: { apiUrl?: string }
    }).n ?? (window as unknown as { shogoDesktop?: { apiUrl?: string } }).shogoDesktop
    if (bridge?.apiUrl) {
      try {
        hosts.add(new URL(bridge.apiUrl).host)
      } catch {}
    }
  }
  cachedHosts = hosts
  return hosts
}

/** Cheap pre-check so the markdown renderer does not parse every link as a URL. */
const LOOKS_IN_APP_FILE = /\/(?:api\/f|f|api\/conversation-files|api\/chat-attachments|api\/cloud\/[^/]+\/(?:conversation-files|chat-attachments))\//

/**
 * Drop sentence punctuation the model left attached to a URL. Parentheses and
 * brackets are only dropped when they are unbalanced, and `_` only when the
 * link is not a share token — a base64url token can legitimately end in one,
 * and stripping it is one of the ways a minted link comes back invalid.
 */
function trimTrailing(href: string): string {
  let value = href.trim()
  for (;;) {
    const wrapped = /^[([]([\s\S]*)[)\]]$/.exec(value) ?? /^<([\s\S]*)>$/.exec(value)
    if (!wrapped) break
    value = wrapped[1]!.trim()
  }
  const isShare = /\/f\/[^/?#]+/.test(value)
  for (;;) {
    const last = value[value.length - 1]
    if (!last) break
    if (/[.,;:!?"']/.test(last)) {
      value = value.slice(0, -1)
      continue
    }
    if (last === ")" && (value.match(/\(/g)?.length ?? 0) < (value.match(/\)/g)?.length ?? 0)) {
      value = value.slice(0, -1)
      continue
    }
    if (last === "]" && (value.match(/\[/g)?.length ?? 0) < (value.match(/\]/g)?.length ?? 0)) {
      value = value.slice(0, -1)
      continue
    }
    if ((last === "_" || last === "~") && !isShare) {
      value = value.slice(0, -1)
      continue
    }
    break
  }
  return value
}

/** A href with no scheme is same-origin: the app rendered it, so it is ours. */
function isRelativeHref(href: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//')
}

function decodeBase64Url(input: string): string | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const clean = input.replace(/=+$/, '')
  let buffer = 0
  let bits = 0
  const bytes: number[] = []
  for (const char of clean) {
    const index = alphabet.indexOf(char)
    if (index < 0) return null
    buffer = (buffer << 6) | index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  const Decoder: any = (globalThis as any).TextDecoder
  if (typeof Decoder === 'function') {
    try {
      return new Decoder().decode(new Uint8Array(bytes))
    } catch {}
  }
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  try {
    return decodeURIComponent(escape(binary))
  } catch {
    return binary
  }
}

export interface ShareFileClaims {
  typ?: string
  projectId?: string
  workspaceId?: string
  path?: string
  exp?: number
  iat?: number
}

/**
 * The claims inside a share token, decoded for display. The signature is not
 * checked here and must not be: the server is the only thing that decides a
 * token is good. Used to put the real filename on the chip before any fetch.
 */
export function shareFileClaims(token: string): ShareFileClaims | null {
  const payload = token.split('.')[0]
  if (!payload) return null
  const text = decodeBase64Url(payload)
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as ShareFileClaims) : null
  } catch {
    return null
  }
}

function basename(path: string | null | undefined): string | null {
  if (!path) return null
  const name = path.split(/[\\/]/).pop()?.trim()
  return name && name.length > 0 ? name : null
}

function currentHost(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  return window.location?.host ?? null
}

/** `/api/f/<token>` or `/f/<token>` on a host this app owns, or null. */
export function parseShareFileHref(
  href: string | undefined | null,
  hosts: Set<string> = ownHosts(),
): InAppFileRef | null {
  if (typeof href !== 'string' || href.length === 0) return null
  const trimmed = trimTrailing(href)
  const origin = currentHost()
  const base = origin ? `http://${origin}` : 'http://shogo.local'

  let url: URL
  try {
    url = new URL(trimmed, base)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!isRelativeHref(trimmed) && !LOCAL_HOST_RE.test(url.hostname) && !hosts.has(url.host)) return null

  const match = SHARE_FILE_PATH_RE.exec(url.pathname)
  if (!match) return null
  const token = match[1]!
  const claims = shareFileClaims(token)
  const name = basename(claims?.path)
  return { kind: 'share', href: trimmed, name: name ?? 'Download', path: claims?.path ?? null }
}

/** A stored chat or conversation file URL, or null. */
export function parseStoredFileHref(
  href: string | undefined | null,
  hosts: Set<string> = ownHosts(),
): InAppFileRef | null {
  if (typeof href !== 'string' || href.length === 0) return null
  const trimmed = trimTrailing(href)
  const origin = currentHost()
  const base = origin ? `http://${origin}` : 'http://shogo.local'

  let url: URL
  try {
    url = new URL(trimmed, base)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!isRelativeHref(trimmed) && !LOCAL_HOST_RE.test(url.hostname) && !hosts.has(url.host)) return null
  if (!STORED_FILE_PATH_RE.test(url.pathname)) return null

  const named = url.searchParams.get('filename') || url.searchParams.get('name')
  const last = url.pathname.replace(/\/+$/, '').split('/').pop() ?? ''
  let name = named || last
  try {
    name = decodeURIComponent(name)
  } catch {}
  return { kind: 'stored', href: trimmed, name: name || 'File' }
}

/** Either kind of file the app can serve itself, or null for a real web link. */
export function parseInAppFileHref(
  href: string | undefined | null,
  hosts: Set<string> = ownHosts(),
): InAppFileRef | null {
  if (typeof href !== 'string' || !LOOKS_IN_APP_FILE.test(href)) return null
  return parseShareFileHref(href, hosts) ?? parseStoredFileHref(href, hosts)
}

/**
 * What to tell the user about a failed download, from the API's own `code`
 * rather than a generic "could not load". The route answers `expired`,
 * `invalid_link`, `file_not_found`, `runtime_unavailable`, `rate_limited` and
 * `download_failed`; anything else falls back to its message.
 */
export function shareFileErrorText(code?: string | null, message?: string | null): string {
  switch (code) {
    case 'expired':
      return 'Link expired — ask for a new one'
    case 'invalid_link':
      return 'Link is invalid — ask for a new one'
    case 'file_not_found':
    case 'not_found':
      return 'File not found'
    case 'runtime_unavailable':
      return 'Runtime unavailable, retry'
    case 'rate_limited':
      return 'Too many downloads, retry shortly'
    case 'download_failed':
      return 'Download failed, retry'
    default:
      return message && message.trim().length > 0 ? message : 'Could not open this file'
  }
}

/** Reads `{ error: { code, message } }` out of a failed download response. */
export function shareFileErrorFromBody(body: unknown): { code: string | null; message: string | null } {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error
  return {
    code: typeof error?.code === 'string' ? error.code : null,
    message: typeof error?.message === 'string' ? error.message : null,
  }
}
