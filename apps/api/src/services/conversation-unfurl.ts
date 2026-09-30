// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Link previews for channel messages. After a message is posted, up to
 * three links are fetched through the SSRF-safe fetcher and their title,
 * description, and image are stored on the message as `blocks.unfurls`.
 */

import { safeFetchText } from '../lib/safe-fetch'
import { registerAfterPostHook } from './conversation-pipeline'
import { updateMessageInternal, type PostMessageResult } from './conversation.service'

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

export function parseUnfurl(url: string, html: string): Unfurl | null {
  const head = html.slice(0, 200_000)
  const title = meta(head, ['og:title', 'twitter:title']) ?? (/<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1]?.trim() || null)
  if (!title) return null
  let image = meta(head, ['og:image', 'og:image:url', 'twitter:image'])
  if (image) {
    try {
      image = new URL(image, url).toString()
      if (!/^https:\/\//i.test(image)) image = null
    } catch {
      image = null
    }
  }
  const description = meta(head, ['og:description', 'twitter:description', 'description'])
  return {
    url,
    title: decodeEntities(title).slice(0, 200),
    description: description ? description.slice(0, 400) : null,
    image,
    siteName: meta(head, ['og:site_name']) ?? new URL(url).hostname.replace(/^www\./, ''),
  }
}

export async function unfurlUrl(url: string): Promise<Unfurl | null> {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  let value: Unfurl | null = null
  try {
    const res = await fetcher(url)
    if (res.status < 400 && /text\/html|application\/xhtml/i.test(res.contentType)) value = parseUnfurl(res.url, res.body)
  } catch {
    value = null
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(url, { at: Date.now(), value })
  return value
}

export async function unfurlMessage(result: PostMessageResult): Promise<Unfurl[]> {
  const { row } = result
  if (result.duplicate || row.authorType === 'system' || !row.text) return []
  if (row.authorType === 'agent' && row.agentStatus === 'running') return []
  const blocks = (row.blocks && typeof row.blocks === 'object' ? row.blocks : {}) as Record<string, unknown>
  if (Array.isArray(blocks.unfurls)) return []
  const links = extractLinks(row.text)
  if (!links.length) return []
  const unfurls = (await Promise.all(links.map(unfurlUrl))).filter(Boolean) as Unfurl[]
  if (!unfurls.length) return []
  await updateMessageInternal(row.id, { blocks: { ...blocks, unfurls } })
  return unfurls
}

let registered = false

export function registerConversationUnfurls(): void {
  if (registered) return
  registered = true
  registerAfterPostHook((result) => {
    void unfurlMessage(result).catch((err) => console.warn('[Channels] unfurl failed:', err?.message))
  })
}

export function _setUnfurlFetcherForTests(fn: Fetcher | null): void {
  fetcher = fn ?? safeFetchText
  cache.clear()
}
