// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A link to another message, pasted into a message body, is not a link: it is
 * a reference. This module separates those references from the text around
 * them so the row can render the message they point at as a quote, instead of
 * a URL you have to recognise and tap.
 *
 * The borrowed URL is removed from the body it was pasted into (the whole line
 * when the line held nothing else), and never written back to anything: the
 * quote is derived per viewer, at render time, from the message it points at.
 *
 * Links inside fenced code blocks and inline code are left exactly as written —
 * a pasted log or a snippet that happens to contain one is documentation, not a
 * reference.
 */
import { parseMessageLink, type MessageLinkTarget } from './team-chat-links'

export interface MessageQuote {
  /** The URL as it appeared in the body. */
  href: string
  target: MessageLinkTarget
}

export interface MessageBodyWithQuotes {
  /** The body with the borrowed URLs removed, ready for the markdown renderer. */
  body: string
  /** References in the order they first appeared. */
  quotes: MessageQuote[]
}

export interface ExtractMessageQuoteOptions {
  /**
   * Return true to leave a link in the body instead of turning it into a
   * quote — used for links whose author declined a preview.
   */
  skip?: (href: string) => boolean
}

const FENCE = /^\s{0,3}(```|~~~)/
const INLINE_CODE = /`[^`\n]*`/g
/** A markdown link whose target is a message: the label goes with the URL. */
const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g
const BARE_URL = /https?:\/\/[^\s<>"']+/g

/** Trailing punctuation a sentence puts after a URL but the URL doesn't own. */
function trimUrl(url: string): string {
  return url.replace(/[.,;:!?)\]]+$/, '')
}

function insideRanges(at: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => at >= start && at < end)
}

function codeRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const match of line.matchAll(INLINE_CODE)) {
    ranges.push([match.index!, match.index! + match[0].length])
  }
  return ranges
}

/** The line with every matched range cut out, or '' when nothing else was on it. */
function withoutRanges(line: string, ranges: Array<[number, number]>): string {
  if (!ranges.length) return line
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  let out = ''
  let at = 0
  for (const [start, end] of sorted) {
    out += line.slice(at, start)
    at = Math.max(at, end)
  }
  out += line.slice(at)
  return out
}

/**
 * Pull this app's message links out of `text`.
 *
 * `hosts` is injectable so the behaviour can be checked without a browser.
 */
export function extractMessageQuotes(
  text: string,
  hosts?: Set<string>,
  opts?: ExtractMessageQuoteOptions,
): MessageBodyWithQuotes {
  const quotes: MessageQuote[] = []
  const seen = new Set<string>()
  const kept: string[] = []
  let inFence = false

  const record = (href: string) => {
    // A link the author declined to preview is left in the body exactly as
    // written: no card, but the URL itself stays visible and still opens for
    // whoever has access. Cutting it out and showing nothing would delete the
    // link from the message entirely.
    if (opts?.skip?.(href)) return false
    const target = parseMessageLink(href, hosts)
    if (!target) return false
    if (!seen.has(target.messageId)) {
      seen.add(target.messageId)
      quotes.push({ href, target })
    }
    return true
  }

  for (const line of (text ?? '').split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence
      kept.push(line)
      continue
    }
    if (inFence) {
      kept.push(line)
      continue
    }

    const code = codeRanges(line)
    const cuts: Array<[number, number]> = []

    // Markdown links first, so their label disappears with the URL rather than
    // being left behind as a dangling `[label]()`.
    for (const match of line.matchAll(MARKDOWN_LINK)) {
      const start = match.index!
      if (insideRanges(start, code)) continue
      if (!record(match[2]!)) continue
      cuts.push([start, start + match[0].length])
    }

    for (const match of line.matchAll(BARE_URL)) {
      const start = match.index!
      if (insideRanges(start, code) || cuts.some(([s, e]) => start >= s && start < e)) continue
      const href = trimUrl(match[0])
      if (!record(href)) continue
      cuts.push([start, start + href.length])
    }

    if (!cuts.length) {
      kept.push(line)
      continue
    }
    // What's left of a line the link was cut out of reads as one sentence, not
    // as the gap where the URL used to be.
    const rest = withoutRanges(line, cuts)
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([.,;:!?])/g, '$1')
      .replace(/[ \t]+$/, '')
    // A line that was only the link leaves nothing behind; dropping it removes
    // the blank gap the quote card would otherwise sit under.
    if (rest.trim()) kept.push(rest)
  }

  return { body: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), quotes }
}
