// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ElevenLabs v3 expressive audio tags.
 *
 * Tags are inline markers like `[whispers]` that the TTS model interprets as
 * performance cues. They can appear mid-sentence ("[excited] that's amazing!")
 * or as non-verbal sounds ("[laughs]").
 *
 * Exposed to:
 *   - Settings UI (chip picker, per-companion allow-list)
 *   - Agent-driven "god mode" (tool surface)
 *   - Server-side prompt composer (composeExpressivityBlock)
 */

export type AudioTagGroup = 'emotion' | 'delivery' | 'reaction'

export interface AudioTag {
  tag: string
  group: AudioTagGroup
  label: string
  description: string
  example: string
}

export const AUDIO_TAGS: AudioTag[] = [
  // Emotions
  { tag: 'happy',     group: 'emotion', label: 'Happy',     description: 'Warm, upbeat delivery.',                example: '[happy] Oh, I\u2019m so glad you stopped by.' },
  { tag: 'sad',       group: 'emotion', label: 'Sad',       description: 'Subdued, heavy-hearted tone.',          example: '[sad] I wish things had gone differently.' },
  { tag: 'excited',   group: 'emotion', label: 'Excited',   description: 'Energized, eager delivery.',            example: '[excited] Wait until you hear this!' },
  { tag: 'curious',   group: 'emotion', label: 'Curious',   description: 'Inquisitive, rising inflection.',       example: '[curious] Hmm, what did they look like?' },
  { tag: 'sarcastic', group: 'emotion', label: 'Sarcastic', description: 'Dry, ironic tone.',                     example: '[sarcastic] Oh, fantastic. Another Monday.' },
  { tag: 'angry',     group: 'emotion', label: 'Angry',     description: 'Sharp, irritated edge.',                example: '[angry] I told you not to touch that.' },
  { tag: 'nervous',   group: 'emotion', label: 'Nervous',   description: 'Uneasy, faltering delivery.',           example: '[nervous] I\u2014 I didn\u2019t think you\u2019d actually come.' },
  { tag: 'confident', group: 'emotion', label: 'Confident', description: 'Grounded, assured delivery.',           example: '[confident] Trust me. I\u2019ve done this before.' },

  // Delivery
  { tag: 'whispers', group: 'delivery', label: 'Whispers', description: 'Hushed, close-mic delivery.',   example: '[whispers] Don\u2019t say it too loud.' },
  { tag: 'shouts',   group: 'delivery', label: 'Shouts',   description: 'Loud, projected delivery.',     example: '[shouts] Look out behind you!' },
  { tag: 'softly',   group: 'delivery', label: 'Softly',   description: 'Gentle, quiet tone.',           example: '[softly] It\u2019s okay. I\u2019m here.' },
  { tag: 'slowly',   group: 'delivery', label: 'Slowly',   description: 'Deliberate pacing.',            example: '[slowly] Tell me\u2026 exactly\u2026 what happened.' },
  { tag: 'quickly',  group: 'delivery', label: 'Quickly',  description: 'Rapid, urgent pacing.',         example: '[quickly] We need to go, right now.' },

  // Reactions (non-verbal sounds)
  { tag: 'laughs',        group: 'reaction', label: 'Laughs',        description: 'A genuine laugh.',           example: 'That\u2019s ridiculous [laughs].' },
  { tag: 'chuckles',      group: 'reaction', label: 'Chuckles',      description: 'A small, warm chuckle.',     example: '[chuckles] You always say that.' },
  { tag: 'sighs',         group: 'reaction', label: 'Sighs',         description: 'An audible sigh.',           example: '[sighs] Alright, fine. Let\u2019s do it.' },
  { tag: 'gasps',         group: 'reaction', label: 'Gasps',         description: 'A sharp inhale of surprise.', example: '[gasps] You didn\u2019t!' },
  { tag: 'hesitates',     group: 'reaction', label: 'Hesitates',     description: 'A pause with uncertainty.',  example: '[hesitates] I\u2019m not sure I should say.' },
  { tag: 'clears throat', group: 'reaction', label: 'Clears throat', description: 'Throat-clearing beat.',      example: '[clears throat] As I was saying\u2026' },
]

export const AUDIO_TAG_GROUPS: { id: AudioTagGroup; label: string; description: string }[] = [
  { id: 'emotion',  label: 'Emotions',  description: 'Overall feeling carried through the line.' },
  { id: 'delivery', label: 'Delivery',  description: 'How the words are spoken (pace, volume).' },
  { id: 'reaction', label: 'Reactions', description: 'Non-verbal sounds mixed into speech.' },
]

export type Expressivity = 'off' | 'subtle' | 'full'

export const EXPRESSIVITY_OPTIONS: { id: Expressivity; label: string; description: string }[] = [
  { id: 'off',    label: 'Off',    description: 'No audio tags. Plain, natural delivery.' },
  { id: 'subtle', label: 'Subtle', description: 'Occasional tag when it genuinely fits. Default.' },
  { id: 'full',   label: 'Full',   description: 'Freely expressive \u2014 tags sprinkled to carry emotion and reactions.' },
]

export const DEFAULT_ALLOWED_TAGS: string[] = [
  'whispers',
  'laughs',
  'sighs',
  'excited',
  'curious',
  'softly',
]

export interface VoiceSettings {
  stability?: number
  similarity_boost?: number
  style?: number
  use_speaker_boost?: boolean
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.8,
  style: 0,
  use_speaker_boost: true,
}

/**
 * Strip v3-style audio tags (e.g. `[whispers]`, `[softly]`, `[laughs]`) from
 * arbitrary text. ElevenLabs Agents Platform runs on Flash v2.5 / Multilingual
 * v2 which do NOT interpret audio tags, so we strip them before displaying in
 * chat and as a defense-in-depth for anything we render from the agent.
 *
 * Only strips tags we know about to avoid chewing through legitimate bracketed
 * content (e.g. markdown references, code).
 */
const KNOWN_TAG_SET = new Set(AUDIO_TAGS.map((t) => t.tag.toLowerCase()))

export function stripAudioTags(text: string | null | undefined): string {
  if (!text) return ''
  return text
    .replace(/\[([a-z][a-z ]{0,24})\]/gi, (match, inner: string) => {
      const key = inner.trim().toLowerCase()
      return KNOWN_TAG_SET.has(key) ? '' : match
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim()
}

export const EXPRESSIVITY_BLOCK_OPEN = '<!--expressivity-->'
export const EXPRESSIVITY_BLOCK_CLOSE = '<!--/expressivity-->'

/**
 * Strip any previous expressivity block from a prompt so we can re-inject a
 * fresh one without duplicating.
 */
export function stripExpressivityBlock(prompt: string): string {
  if (!prompt) return prompt
  const open = EXPRESSIVITY_BLOCK_OPEN
  const close = EXPRESSIVITY_BLOCK_CLOSE
  const openIdx = prompt.indexOf(open)
  if (openIdx === -1) return prompt
  const closeIdx = prompt.indexOf(close, openIdx)
  if (closeIdx === -1) return prompt
  const before = prompt.slice(0, openIdx).replace(/\s+$/, '')
  const after = prompt.slice(closeIdx + close.length).replace(/^\s+/, '')
  return [before, after].filter(Boolean).join('\n\n')
}

/**
 * Compose the expressivity instruction block to inject into the system prompt.
 * Wrapped in HTML-comment delimiters so it can be stripped and replaced
 * idempotently across edits.
 *
 * Returns '' when expressivity is 'off' (caller should still strip any
 * previous block first).
 */
export function composeExpressivityBlock(
  expressivity: Expressivity,
  allowedTags: string[] | null | undefined,
): string {
  if (expressivity === 'off') return ''

  const allowed = (allowedTags && allowedTags.length > 0 ? allowedTags : DEFAULT_ALLOWED_TAGS)
    .filter((t) => AUDIO_TAGS.some((a) => a.tag === t))

  if (allowed.length === 0) return ''

  const intensity =
    expressivity === 'full'
      ? 'Use audio tags liberally to color your speech with emotion, delivery, and non-verbal reactions. Most substantive replies should include at least one tag. Never add so many tags that a line becomes unnatural.'
      : 'Use audio tags sparingly \u2014 only when one genuinely fits the emotion or reaction of the moment. Most lines will have no tag. At most one or two tags per reply.'

  const tagList = allowed
    .map((t) => {
      const entry = AUDIO_TAGS.find((a) => a.tag === t)!
      return `  - [${entry.tag}] \u2014 ${entry.description} Example: ${entry.example}`
    })
    .join('\n')

  const body = [
    'You speak through an expressive TTS engine that understands inline audio tags.',
    'Audio tags are lowercase words in square brackets placed directly in your spoken text \u2014 e.g. "[whispers] don\u2019t tell anyone" or "that was wild [laughs]".',
    'Tags are performance cues, not words. Never describe a tag (do not say "asterisk laughs asterisk" or "*laughs*"). Never read a tag aloud. Never put tags inside quoted speech from another character.',
    intensity,
    'You may only use tags from this allow-list:',
    tagList,
    'If no tag fits, use none. Tags are optional flavor, not filler.',
  ].join('\n')

  return `${EXPRESSIVITY_BLOCK_OPEN}\n${body}\n${EXPRESSIVITY_BLOCK_CLOSE}`
}

/**
 * A short demo sentence built from up to 3 of the selected tags, used by the
 * voice-preview endpoint so users can hear what their current settings sound
 * like.
 */
export function buildPreviewLine(
  allowedTags: string[] | null | undefined,
  characterName = 'your companion',
): string {
  const tags = (allowedTags ?? []).filter((t) => AUDIO_TAGS.some((a) => a.tag === t))
  if (tags.length === 0) {
    return `Hi there. This is a quick preview of how ${characterName} sounds.`
  }
  const pick = tags.slice(0, 3)
  const lead = pick[0]
  const mid = pick[1]
  const tail = pick[2]

  if (pick.length === 1) {
    return `[${lead}] Hey \u2014 this is how ${characterName} sounds when the mood takes over.`
  }
  if (pick.length === 2) {
    return `[${lead}] Oh, this is fun. [${mid}] Let me know what you think.`
  }
  return `[${lead}] Okay, listen. [${mid}] This is the new voice. [${tail}] How does it feel?`
}

/**
 * Normalize an arbitrary `audioTags` value from client JSON into a clean,
 * de-duplicated list of known tags. Returns `null` if `raw` isn't an array.
 */
export function normalizeAudioTags(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const cleaned = raw
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => AUDIO_TAGS.some((a) => a.tag === x))
  return Array.from(new Set(cleaned))
}

/**
 * Returns the provided expressivity string if it's a valid {@link Expressivity},
 * otherwise `undefined`.
 */
export function normalizeExpressivity(raw: unknown): Expressivity | undefined {
  if (raw === 'off' || raw === 'subtle' || raw === 'full') return raw
  return undefined
}

/**
 * Clamp + pick only known voice-setting fields from arbitrary JSON. Accepts
 * both snake_case and camelCase input keys.
 */
export function normalizeVoiceSettings(raw: unknown): VoiceSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const src = raw as Record<string, unknown>
  const out: VoiceSettings = {}
  const clamp = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined
  const stability = clamp(src.stability)
  const similarity = clamp(src.similarity_boost ?? src.similarityBoost)
  const style = clamp(src.style)
  const boost = src.use_speaker_boost ?? src.useSpeakerBoost
  if (stability !== undefined) out.stability = stability
  if (similarity !== undefined) out.similarity_boost = similarity
  if (style !== undefined) out.style = style
  if (typeof boost === 'boolean') out.use_speaker_boost = boost
  return Object.keys(out).length ? out : undefined
}

export function readAudioTags(raw: unknown): string[] {
  const norm = normalizeAudioTags(raw)
  return norm && norm.length > 0 ? norm : DEFAULT_ALLOWED_TAGS
}

export function readExpressivity(raw: unknown): Expressivity {
  return normalizeExpressivity(raw) ?? 'subtle'
}

export function readVoiceSettings(raw: unknown): VoiceSettings {
  return normalizeVoiceSettings(raw) ?? { ...DEFAULT_VOICE_SETTINGS }
}
