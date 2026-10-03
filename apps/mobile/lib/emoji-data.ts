// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Every Unicode emoji, grouped the way pickers show them, with name search
 * and the handful of Slack shortcodes people type from muscle memory.
 */
import groups from 'unicode-emoji-json/data-by-group.json'

export interface EmojiEntry {
  emoji: string
  name: string
  slug: string
}

export interface EmojiGroup {
  name: string
  slug: string
  emojis: EmojiEntry[]
}

const ALIASES: Record<string, string> = {
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', smile: '😄', smiley: '😃', grin: '😁', joy: '😂',
  laughing: '😆', wink: '😉', blush: '😊', heart_eyes: '😍', thinking: '🤔', sweat_smile: '😅', sob: '😭',
  heart: '❤️', tada: '🎉', fire: '🔥', rocket: '🚀', eyes: '👀', white_check_mark: '✅', heavy_check_mark: '✔️',
  x: '❌', pray: '🙏', raised_hands: '🙌', clap: '👏', muscle: '💪', '100': '💯', ok_hand: '👌', wave: '👋',
  warning: '⚠️', sparkles: '✨', star: '⭐', pushpin: '📌', bulb: '💡', memo: '📝', bug: '🐛', zap: '⚡',
}

export const EMOJI_GROUPS: EmojiGroup[] = (groups as Array<{ name: string; slug: string; emojis: EmojiEntry[] }>)
  .filter((g) => g.slug !== 'component')
  .map((g) => ({ name: g.name, slug: g.slug, emojis: g.emojis.map(({ emoji, name, slug }) => ({ emoji, name, slug })) }))

const ALL: EmojiEntry[] = EMOJI_GROUPS.flatMap((g) => g.emojis)
const aliasesByEmoji = new Map<string, string[]>()
for (const [alias, emoji] of Object.entries(ALIASES)) {
  aliasesByEmoji.set(emoji, [...(aliasesByEmoji.get(emoji) ?? []), alias])
}

function haystack(e: EmojiEntry): string {
  return [e.name, e.slug, ...(aliasesByEmoji.get(e.emoji) ?? [])].join(' ').toLowerCase()
}

const index = ALL.map((e) => ({ entry: e, text: haystack(e), tokens: haystack(e).split(/[\s_]+/) }))
const byEmoji = new Map(ALL.map((e) => [e.emoji, e]))

/**
 * Emoji whose name, shortcode, or alias contains every word of `query`.
 * Ranked: exact shortcode, shortcodes starting with it, words starting with it, then anywhere.
 */
export function searchEmoji(query: string, limit = 64): EmojiEntry[] {
  const words = query.toLowerCase().replace(/:/g, ' ').split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const exact = ALIASES[words.join('_')]
  const hits: EmojiEntry[] = []
  const seen = new Set<string>()
  const add = (e: EmojiEntry | undefined) => {
    if (!e || seen.has(e.emoji) || hits.length >= limit) return
    seen.add(e.emoji)
    hits.push(e)
  }
  const slug = words.join('_')
  const aliasEntry = (alias: string, emoji: string) => byEmoji.get(emoji) ?? { emoji, name: alias.replace(/_/g, ' '), slug: alias }
  if (exact) add(aliasEntry(slug, exact))
  for (const [alias, emoji] of Object.entries(ALIASES)) if (alias.startsWith(slug)) add(aliasEntry(alias, emoji))
  for (const { entry } of index) if (entry.slug.startsWith(slug)) add(entry)
  for (const { entry, tokens } of index) if (words.every((w) => tokens.some((t) => t.startsWith(w)))) add(entry)
  for (const { entry, text } of index) if (words.every((w) => text.includes(w))) add(entry)
  return hits
}

/** The emoji for a `:shortcode:` the person finished typing, if there is one. */
export function emojiForShortcode(code: string): string | null {
  const key = code.toLowerCase()
  return ALIASES[key] ?? ALL.find((e) => e.slug === key)?.emoji ?? null
}

/** A `:shortcode` being typed right before the caret (two or more characters). */
export function activeEmojiQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = text.slice(0, caret).match(/(^|\s):([a-z0-9_+-]{2,})$/i)
  if (!m) return null
  return { start: caret - m[2]!.length - 1, query: m[2]! }
}

/** Swap finished `:shortcode:`s for their emoji; unknown codes (custom emoji included) stay as typed. */
export function replaceFinishedShortcode(text: string): string {
  return text.replace(/(^|\s):([a-z0-9_+-]+):(?=\s|$)/gi, (whole, lead: string, code: string) => {
    const emoji = emojiForShortcode(code)
    return emoji ? `${lead}${emoji}` : whole
  })
}
