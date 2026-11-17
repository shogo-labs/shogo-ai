// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The pictures and videos a message links to, so the chat can show them under
 * the text instead of only naming them.
 *
 * An agent almost never writes markdown image syntax: `share_file` tells it to
 * paste the URL, so a screenshot arrives as `[shot.png](https://…/api/f/<tok>)`
 * or as the bare URL, and both used to render as a chip you had to click to see
 * anything (SHO-388). One extraction here feeds every chat surface — team chat,
 * project chat, the workspace agent's turns and DMs — because they all render
 * through `ChatMarkdown`.
 *
 * Pure: no React, no network. The parsers are parameters so a test can pin the
 * classification without a host allow-list.
 */
import { parseInAppFileHref, type InAppFileRef } from '../../lib/share-file-links'
import { fileViewKind, type FileViewKind } from '../files/file-view-kind'
import type { ShareFileTarget } from './ShareFileViewer'

/** A chat target worth a preview card, plus what kind of card to draw. */
export type InlineMediaTarget = ShareFileTarget & { mediaKind: 'image' | 'video' }

export interface ExtractInlineMediaOptions {
  /**
   * Drop a URL that runs to the end of the text: while a message is still
   * streaming, that link is probably half-written, and a card that flashes a
   * broken thumbnail for a token that is about to grow is worse than no card.
   */
  isStreaming?: boolean
  /** `parseInAppFileHref` by default; injectable for tests. */
  parse?: (href: string | null | undefined) => InAppFileRef | null
  /** `fileViewKind` by default; injectable for tests. */
  kindFor?: (name: string, mime?: string | null) => FileViewKind
}

/** `[text](href)` and `![alt](src)` in one pass; group 1 says which. */
const MARKDOWN_LINK_RE = /(!?)\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g

/** A URL a model pasted on its own, absolute or app-relative. */
const BARE_URL_RE = /(?:https?:\/\/|\/(?:api|f)\/|file:\/\/)[^\s<>"'`()[\]{}]+/g

const FENCE_RE = /^\s*(?:```|~~~)/

/**
 * The text with code removed. A URL inside a fence or an inline code span is
 * being *shown*, not linked, so it must not grow a preview.
 */
function stripCode(markdown: string): string {
  const out: string[] = []
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      out.push('')
      continue
    }
    out.push(inFence ? '' : line.replace(/`[^`\n]*`/g, ' '))
  }
  return out.join('\n')
}

/** Sentence punctuation a model leaves stuck to a pasted URL. */
function trimUrl(value: string): string {
  let out = value
  for (;;) {
    const last = out[out.length - 1]
    if (!last) break
    if (/[.,;:!?'"*]/.test(last)) {
      out = out.slice(0, -1)
      continue
    }
    if (last === ')' && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
      out = out.slice(0, -1)
      continue
    }
    break
  }
  return out
}

/** A link's own text, with the emphasis markers a model wraps it in. */
function cleanLabel(label: string | null | undefined): string {
  return (label ?? '').trim().replace(/^[*_]{1,3}|[*_]{1,3}$/g, '').trim()
}

function mediaTarget(
  href: string,
  label: string | null,
  options: ExtractInlineMediaOptions,
): InlineMediaTarget | null {
  const parse = options.parse ?? parseInAppFileHref
  const kindFor = options.kindFor ?? fileViewKind
  const parsed = parse(href)
  if (!parsed) return null

  // The chip name comes from the token's own claims, which a link that only
  // names the download cannot fill in. The link's text is the next best label.
  const claimed = parsed.name?.trim() ?? ''
  const fallback = cleanLabel(label)
  const name = (!claimed || claimed === 'Download' || claimed === 'File') && fallback ? fallback : claimed
  if (!name) return null

  const mediaKind = kindFor(name, null)
  if (mediaKind !== 'image' && mediaKind !== 'video') return null

  return { href: parsed.href, name, kind: parsed.kind, path: parsed.path ?? null, mediaKind }
}

function endsText(text: string, index: number, length: number): boolean {
  return index + length >= text.replace(/\s+$/, '').length
}

/**
 * Every image or video link in `markdown`, in the order it appears, one per
 * href. `![]()` image syntax is left alone — that already renders as a picture,
 * and showing it twice would be a bug, not a feature.
 */
export function extractInlineMediaLinks(
  markdown: string,
  options: ExtractInlineMediaOptions = {},
): InlineMediaTarget[] {
  if (!markdown || (!markdown.includes('/') && !markdown.includes('.'))) return []
  const text = stripCode(markdown)
  const candidates: Array<{ index: number; href: string; label: string | null }> = []

  // Markdown links are read first, and every one of them — image syntax
  // included — is blanked out of the text the bare-URL scan then reads: the
  // destination of `![](…)` must not come back as a second card.
  let masked = ''
  let cursor = 0
  MARKDOWN_LINK_RE.lastIndex = 0
  for (let match = MARKDOWN_LINK_RE.exec(text); match; match = MARKDOWN_LINK_RE.exec(text)) {
    masked += text.slice(cursor, match.index) + ' '.repeat(match[0].length)
    cursor = match.index + match[0].length
    if (match[1] !== '!') {
      candidates.push({ index: match.index, href: match[3] ?? '', label: match[2] ?? null })
    }
  }
  masked += text.slice(cursor)

  BARE_URL_RE.lastIndex = 0
  for (let match = BARE_URL_RE.exec(masked); match; match = BARE_URL_RE.exec(masked)) {
    const href = match[0]
    if (options.isStreaming && endsText(masked, match.index, href.length)) continue
    candidates.push({ index: match.index, href, label: null })
  }

  const found: InlineMediaTarget[] = []
  const seen = new Set<string>()
  for (const candidate of candidates.sort((a, b) => a.index - b.index)) {
    const target = mediaTarget(trimUrl(candidate.href), candidate.label, options)
    if (!target || seen.has(target.href)) continue
    seen.add(target.href)
    found.push(target)
  }

  return found
}
