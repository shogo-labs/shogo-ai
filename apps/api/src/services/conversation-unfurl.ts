// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Link previews for channel messages. After a message is posted, edited,
 * or (for agent replies) finished, up to three links are fetched through
 * the SSRF-safe fetcher and their title, description, and image are stored
 * on the message as `blocks.unfurls`.
 */

import { safeFetchText } from '../lib/safe-fetch'
import { registerAfterPostHook } from './conversation-pipeline'
import { onMessageTextSettled, updateMessageInternal, type PostMessageResult } from './conversation.service'

export interface Unfurl {
  url: string
  title: string
  description: string | null
  image: string | null
  siteName: string | null
}

const MAX_LINKS = 3
const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_MAX = 500
/** Metadata can sit far into the document: YouTube's head alone is past 512KB. */
const FETCH_BYTES = 1024 * 1024
const FETCH_TIMEOUT_MS = 8_000
/** Nothing an unfurl needs lives after `</head>`. */
const HEAD_END = '</head>'
const cache = new Map<string, { at: number; value: Unfurl | null }>()

type Fetcher = typeof safeFetchText
let fetcher: Fetcher = safeFetchText

const URL_RE = /\bhttps?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/gi

/** Links in a message, skipping ones wrapped in `<…>` (the "no preview" convention) and code. */
export function extractLinks(text: string): string[] {
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
  const suppressed = new Set([...withoutCode.matchAll(/<(https?:\/\/[^>\s]+)>/gi)].map((m) => m[1]))
  const out: string[] = []
  for (const m of withoutCode.matchAll(URL_RE)) {
    const url = m[0]
    if (suppressed.has(url) || out.includes(url)) continue
    out.push(url)
    if (out.length >= MAX_LINKS) break
  }
  return out
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
}

function meta(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`,
      'i',
    )
    const m = re.exec(html)
    const value = m?.[1] ?? m?.[2]
    if (value && value.trim()) return decodeEntities(value.trim())
  }
  return null
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function documentTitle(html: string): string | null {
  return /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || null
}

/** Sign-in walls, consent interstitials and bare error pages. */
const FILLER_TITLE =
  /^(sign ?in|log ?in|sign ?up|just a moment|attention required|access denied|request access|you need access|unsupported browser)\b|^(page not found|not found|404|403|error|forbidden)$/i

/**
 * A card whose title only repeats the site's own name tells the reader nothing
 * the link did not already say.
 */
function saysNothing(title: string, siteName: string, url: string): boolean {
  if (FILLER_TITLE.test(title.trim())) return true
  const host = hostOf(url)
  const bare = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const mine = bare(title)
  return mine === bare(siteName) || mine === bare(host) || mine === bare(host.split('.')[0] ?? '')
}

export function parseUnfurl(url: string, html: string): Unfurl | null {
  const declared = meta(html, ['og:title', 'twitter:title'])
  const title = declared ?? documentTitle(html)
  if (!title) return null
  let image = meta(html, ['og:image', 'og:image:url', 'twitter:image'])
  if (image) {
    try {
      image = new URL(image, url).toString()
      if (!/^https:\/\//i.test(image)) image = null
    } catch {
      image = null
    }
  }
  const siteName = meta(html, ['og:site_name']) ?? hostOf(url)
  // A page that declares no rich-preview metadata *and* names itself only with
  // its own name is a wall, not a document. Restricted Google Docs are the case
  // that matters: an anonymous crawler is handed "Sign in - Google Accounts".
  if (!declared && !image && saysNothing(title, siteName, url)) return null
  const description = meta(html, ['og:description', 'twitter:description', 'description'])
  return {
    url,
    title: decodeEntities(title).slice(0, 200),
    description: description ? description.slice(0, 400) : null,
    image,
    siteName,
  }
}

export async function unfurlUrl(url: string): Promise<Unfurl | null> {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  let value: Unfurl | null = null
  try {
    const res = await fetcher(url, { maxBytes: FETCH_BYTES, timeoutMs: FETCH_TIMEOUT_MS, stopAt: HEAD_END })
    if (res.status < 400 && /text\/html|application\/xhtml/i.test(res.contentType)) value = parseUnfurl(res.url, res.body)
  } catch {
    value = null
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(url, { at: Date.now(), value })
  return value
}

function blocksOf(row: any): Record<string, unknown> {
  const raw = typeof row.blocks === 'string' ? (() => { try { return JSON.parse(row.blocks) } catch { return null } })() : row.blocks
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

/**
 * Bring a message's previews in line with the links in its text. Previews
 * that are already stored for the same links are kept; links that were
 * removed lose their cards.
 */
export async function refreshUnfurls(row: any): Promise<Unfurl[]> {
  if (row.authorType === 'system' || row.deletedAt) return []
  if (row.authorType === 'agent' && row.agentStatus === 'running') return []
  const blocks = blocksOf(row)
  const stored = Array.isArray(blocks.unfurls) ? (blocks.unfurls as Unfurl[]) : null
  const links = extractLinks(row.text ?? '')
  if (stored && stored.every((u) => links.includes(u.url)) && links.every((l) => stored.some((u) => u.url === l) || cache.has(l))) {
    return stored
  }
  const unfurls = (await Promise.all(links.map(unfurlUrl))).filter(Boolean) as Unfurl[]
  if (!unfurls.length && !stored) return []
  const { unfurls: _old, ...rest } = blocks
  await updateMessageInternal(row.id, { blocks: unfurls.length ? { ...rest, unfurls } : rest })
  return unfurls
}

export async function unfurlMessage(result: PostMessageResult): Promise<Unfurl[]> {
  if (result.duplicate) return []
  return refreshUnfurls(result.row)
}

let registered = false

export function registerConversationUnfurls(): void {
  if (registered) return
  registered = true
  registerAfterPostHook((result, ctx) => {
    if (ctx.settled) return
    void unfurlMessage(result).catch((err) => console.warn('[Channels] unfurl failed:', err?.message))
  })
  onMessageTextSettled((row) => {
    void refreshUnfurls(row).catch((err) => console.warn('[Channels] unfurl failed:', err?.message))
  })
}

export function _setUnfurlFetcherForTests(fn: Fetcher | null): void {
  fetcher = fn ?? safeFetchText
  cache.clear()
}
