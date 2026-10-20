// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Emoji detection for message rendering: is this message nothing but emoji?
 *
 * Built on code-point ranges and a small grapheme walker rather than `\p{…}`
 * property escapes or `Intl.Segmenter`. Neither is guaranteed on Hermes, and a
 * regex that throws while the module is being evaluated would take the whole
 * message list down with it — the same class of failure as the Switch crash.
 *
 * The walker is what makes a family or a flag count as ONE emoji rather than
 * five: 👨‍👩‍👧‍👦 is joined by zero-width joiners, 🇮🇳 is two regional
 * indicators, and 1️⃣ is a digit plus a variation selector plus a keycap.
 */

const ZWJ = 0x200d
const VS16 = 0xfe0f
const VS15 = 0xfe0e
const KEYCAP = 0x20e3

/** Modifiers that attach to the preceding emoji and never stand alone. */
function isSkinTone(cp: number): boolean {
  return cp >= 0x1f3fb && cp <= 0x1f3ff
}

/** Regional indicators pair into flags; a single one is a letter-like square. */
function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff
}

/** Tag characters (subdivision flags such as 🏴󠁧󠁢󠁳󠁣󠁴󠁿) trail their base. */
function isTag(cp: number): boolean {
  return cp >= 0xe0020 && cp <= 0xe007f
}

/**
 * Code-point ranges that render as emoji rather than as text.
 *
 * Plain arrows (→) and the dingbat-ish geometric shapes are deliberately left
 * out: people type those as typography, and a one-arrow message blown up to
 * 30px looks like a mistake.
 */
const EMOJI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1f000, 0x1faff], // mahjong, cards, enclosed alphanumerics, pictographs, emoticons, transport, supplemental, extended-A
  [0x2600, 0x27bf], // misc symbols and dingbats — ✅ ⚡ ❤️ ✨
  [0x2b00, 0x2bff], // ⭐ ⬛ ⬜ ⭕
  [0x2300, 0x23ff], // ⌚ ⏰ ⏳ ⏩
  [0x25a0, 0x25ff], // ▶ ◀ ◻
  [0x203c, 0x203c], // ‼️
  [0x2049, 0x2049], // ⁉️
  [0x2122, 0x2122], // ™️
  [0x2139, 0x2139], // ℹ️
  [0x24c2, 0x24c2], // Ⓜ️
  [0x3030, 0x3030], // 〰️
  [0x303d, 0x303d], // 〽️
  [0x3297, 0x3297], // ㊗️
  [0x3299, 0x3299], // ㊙️
  [0x00a9, 0x00a9], // ©️
  [0x00ae, 0x00ae], // ®️
]

function codePointsOf(text: string): number[] {
  const out: number[] = []
  for (const ch of text) out.push(ch.codePointAt(0) as number)
  return out
}

/**
 * Splits text into user-perceived characters, keeping emoji sequences whole.
 * `Array.from` alone is not enough: it splits by code point, so a skin-toned
 * wave would come back as two "emoji" and a family as five.
 */
export function splitGraphemes(text: string): string[] {
  const cps = Array.from(text)
  const out: string[] = []
  let i = 0
  while (i < cps.length) {
    const start = i
    const first = cps[i].codePointAt(0) as number
    i += 1
    if (isRegionalIndicator(first) && i < cps.length) {
      const next = cps[i].codePointAt(0) as number
      if (isRegionalIndicator(next)) i += 1
    } else {
      while (i < cps.length) {
        const cp = cps[i].codePointAt(0) as number
        if (cp === VS16 || cp === VS15 || cp === KEYCAP || isSkinTone(cp) || isTag(cp)) {
          i += 1
          continue
        }
        if (cp === ZWJ && i + 1 < cps.length) {
          i += 2
          continue
        }
        break
      }
    }
    out.push(cps.slice(start, i).join(''))
  }
  return out
}

/** True when one grapheme (see `splitGraphemes`) is an emoji and nothing else. */
export function isEmoji(grapheme: string): boolean {
  const cps = codePointsOf(grapheme)
  if (cps.length === 0) return false
  // ✏︎ — the text-presentation selector asks for a glyph, not an emoji.
  if (cps.includes(VS15)) return false
  if (cps.includes(KEYCAP)) {
    const base = cps[0]
    return (base >= 0x30 && base <= 0x39) || base === 0x23 || base === 0x2a
  }
  if (isRegionalIndicator(cps[0])) return cps.length > 1 && isRegionalIndicator(cps[1])
  return EMOJI_RANGES.some(([lo, hi]) => cps[0] >= lo && cps[0] <= hi)
}

/** Most emoji a message may hold and still render large. */
export const JUMBO_MAX_EMOJI = 6

/**
 * The emoji a message consists of, or null when it is not emoji-only.
 *
 * `isCustomCode` reports the workspace's `:name:` emoji, which are single
 * graphemes of letters and so would otherwise look like text.
 */
export function emojiOnlyCodes(text: string, isCustomCode: (code: string) => boolean): string[] | null {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 200) return null
  const codes: string[] = []
  for (const part of trimmed.split(/\s+/)) {
    if (isCustomCode(part)) {
      codes.push(part)
      continue
    }
    for (const grapheme of splitGraphemes(part)) {
      if (!isEmoji(grapheme)) return null
      codes.push(grapheme)
    }
  }
  return codes.length > 0 && codes.length <= JUMBO_MAX_EMOJI ? codes : null
}
