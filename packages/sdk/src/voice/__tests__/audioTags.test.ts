// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  AUDIO_TAGS,
  DEFAULT_ALLOWED_TAGS,
  DEFAULT_VOICE_SETTINGS,
  buildPreviewLine,
  composeExpressivityBlock,
  EXPRESSIVITY_BLOCK_CLOSE,
  EXPRESSIVITY_BLOCK_OPEN,
  normalizeAudioTags,
  normalizeExpressivity,
  normalizeVoiceSettings,
  readAudioTags,
  readExpressivity,
  readVoiceSettings,
  stripAudioTags,
  stripExpressivityBlock,
} from '../audioTags'

describe('stripAudioTags', () => {
  test('strips known tags and collapses whitespace', () => {
    expect(stripAudioTags('[whispers] hello [laughs] there')).toBe('hello there')
    expect(stripAudioTags('well [sighs], fine.')).toBe('well, fine.')
  })

  test('leaves unknown bracketed text intact', () => {
    expect(stripAudioTags('[not-a-tag] keep me')).toBe('[not-a-tag] keep me')
    expect(stripAudioTags('see [ref-1]')).toBe('see [ref-1]')
  })

  test('handles null/empty input', () => {
    expect(stripAudioTags(null)).toBe('')
    expect(stripAudioTags(undefined)).toBe('')
    expect(stripAudioTags('')).toBe('')
  })

  test('collapses repeated spaces left behind', () => {
    expect(stripAudioTags('hi  [laughs]  friend')).toBe('hi friend')
  })

  test('tag matching is case-insensitive', () => {
    expect(stripAudioTags('[WHISPERS] secret')).toBe('secret')
  })
})

describe('stripExpressivityBlock / composeExpressivityBlock', () => {
  test('compose → strip is idempotent', () => {
    const original = 'You are a helpful assistant.'
    const withBlock = `${original}\n\n${composeExpressivityBlock('subtle', ['laughs', 'whispers'])}`
    const stripped = stripExpressivityBlock(withBlock)
    expect(stripped).toBe(original)
  })

  test("expressivity='off' yields empty block", () => {
    expect(composeExpressivityBlock('off', ['laughs'])).toBe('')
  })

  test('empty allow-list falls back to DEFAULT_ALLOWED_TAGS', () => {
    const block = composeExpressivityBlock('subtle', [])
    expect(block).toContain('[laughs]')
    expect(block).toContain('[whispers]')
  })

  test('full expressivity uses the liberal intensity copy', () => {
    const block = composeExpressivityBlock('full', ['laughs'])
    expect(block).toContain('liberally')
    expect(block.startsWith(EXPRESSIVITY_BLOCK_OPEN)).toBe(true)
    expect(block.endsWith(EXPRESSIVITY_BLOCK_CLOSE)).toBe(true)
  })

  test('double-composing then stripping yields a single clean prompt', () => {
    const base = 'Be kind.'
    const a = `${base}\n\n${composeExpressivityBlock('subtle', ['laughs'])}`
    const reStripped = stripExpressivityBlock(a)
    const b = `${reStripped}\n\n${composeExpressivityBlock('full', ['whispers'])}`
    const final = stripExpressivityBlock(b)
    expect(final).toBe(base)
  })

  test('unknown tags are filtered out of the allow-list', () => {
    const block = composeExpressivityBlock('subtle', ['not-a-tag', 'laughs'])
    expect(block).toContain('[laughs]')
    expect(block).not.toContain('[not-a-tag]')
  })
})

describe('buildPreviewLine', () => {
  test('falls back to a generic line when no tags', () => {
    expect(buildPreviewLine([], 'Ada')).toContain('Ada')
    expect(buildPreviewLine(null)).toContain('your companion')
  })

  test('one, two, and three tag lines each include their tags', () => {
    const one = buildPreviewLine(['laughs'], 'Ada')
    expect(one).toContain('[laughs]')
    expect(one).toContain('Ada')

    const two = buildPreviewLine(['laughs', 'whispers'])
    expect(two).toContain('[laughs]')
    expect(two).toContain('[whispers]')

    const three = buildPreviewLine(['laughs', 'whispers', 'sighs'])
    expect(three).toContain('[laughs]')
    expect(three).toContain('[whispers]')
    expect(three).toContain('[sighs]')
  })

  test('filters out unknown tags before selecting', () => {
    const line = buildPreviewLine(['not-a-tag', 'laughs'])
    expect(line).toContain('[laughs]')
    expect(line).not.toContain('not-a-tag')
  })
})

describe('normalize* helpers', () => {
  test('normalizeAudioTags keeps only known tags, deduped and lowercased', () => {
    expect(normalizeAudioTags(['Laughs', 'laughs', 'whispers', 'bogus', 42])).toEqual([
      'laughs',
      'whispers',
    ])
    expect(normalizeAudioTags(null)).toBeNull()
    expect(normalizeAudioTags('oops')).toBeNull()
  })

  test('normalizeExpressivity returns undefined for bad input', () => {
    expect(normalizeExpressivity('off')).toBe('off')
    expect(normalizeExpressivity('subtle')).toBe('subtle')
    expect(normalizeExpressivity('full')).toBe('full')
    expect(normalizeExpressivity('MAX')).toBeUndefined()
    expect(normalizeExpressivity(null)).toBeUndefined()
  })

  test('normalizeVoiceSettings clamps numeric fields to [0,1] and accepts both cases', () => {
    const vs = normalizeVoiceSettings({
      stability: 2,
      similarityBoost: -3,
      style: 0.5,
      useSpeakerBoost: false,
    })
    expect(vs).toEqual({
      stability: 1,
      similarity_boost: 0,
      style: 0.5,
      use_speaker_boost: false,
    })
  })

  test('normalizeVoiceSettings returns undefined when nothing valid supplied', () => {
    expect(normalizeVoiceSettings({})).toBeUndefined()
    expect(normalizeVoiceSettings(null)).toBeUndefined()
  })
})

describe('read* helpers apply sensible defaults', () => {
  test('readAudioTags falls back to DEFAULT_ALLOWED_TAGS when input is empty', () => {
    expect(readAudioTags([])).toEqual(DEFAULT_ALLOWED_TAGS)
    expect(readAudioTags(null)).toEqual(DEFAULT_ALLOWED_TAGS)
    expect(readAudioTags(['laughs'])).toEqual(['laughs'])
  })

  test("readExpressivity defaults to 'subtle'", () => {
    expect(readExpressivity(null)).toBe('subtle')
    expect(readExpressivity('full')).toBe('full')
  })

  test('readVoiceSettings returns DEFAULT_VOICE_SETTINGS when empty', () => {
    expect(readVoiceSettings(null)).toEqual({ ...DEFAULT_VOICE_SETTINGS })
  })
})

describe('AUDIO_TAGS catalog', () => {
  test('all tags reference a known group', () => {
    for (const t of AUDIO_TAGS) {
      expect(['emotion', 'delivery', 'reaction']).toContain(t.group)
    }
  })

  test('tag names are unique', () => {
    const names = AUDIO_TAGS.map((t) => t.tag)
    expect(new Set(names).size).toBe(names.length)
  })

  test('all DEFAULT_ALLOWED_TAGS exist in the catalog', () => {
    for (const d of DEFAULT_ALLOWED_TAGS) {
      expect(AUDIO_TAGS.some((t) => t.tag === d)).toBe(true)
    }
  })
})
