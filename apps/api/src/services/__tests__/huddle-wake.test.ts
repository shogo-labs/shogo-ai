// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Hey Shogo" in a huddle: what counts as the phrase, who may say it, how often,
 * and how much of the call the agent is handed. Every rule here is pure, so a
 * mistake shows up as a failing assertion instead of a surprise agent run in a
 * real call.
 */

import { describe, expect, test } from 'bun:test'
import {
  WAKE_CONTEXT_DEFAULT_SECONDS,
  WAKE_CONTEXT_MAX_SECONDS,
  WAKE_CONTEXT_MIN_SECONDS,
  WAKE_HUDDLE_COOLDOWN_MS,
  WAKE_MAX_PER_HUDDLE,
  WAKE_SPEAKER_COOLDOWN_MS,
  decideWake,
  matchWakePhrase,
  wakeContext,
  wakeContextSeconds,
  type WakeDecisionInput,
} from '../huddle-wake.service'

const at = (text: string) => matchWakePhrase(text)

describe('matchWakePhrase', () => {
  test('finds the phrase and what was asked after it', () => {
    expect(at('hey Shogo, make a card for the login bug')?.request).toBe('make a card for the login bug')
    expect(at('Hey Shogo! summarise this')?.request).toBe('summarise this')
  })

  test('reads it anywhere in the line, not just at the start', () => {
    expect(at('so hey Shogo can you write that up')?.request).toBe('can you write that up')
    expect(at('i think, um, okay shogo — file it')?.request).toBe('file it')
  })

  test('accepts what a recogniser writes instead of "shogo"', () => {
    expect(at('hey showgo what do you think')).not.toBeNull()
    expect(at('hey show go what do you think')).not.toBeNull()
    expect(at('hi sho go, keep going')).not.toBeNull()
  })

  test('ignores a line that says "shogo" without a greeting', () => {
    expect(at('shogo is great at this')).toBeNull()
    expect(at('we use shogo every day')).toBeNull()
  })

  test('ignores a word that only starts with the phrase', () => {
    expect(at('hey shogun, nice to meet you')).toBeNull()
    expect(at('hey showgoers are here')).toBeNull()
    expect(at('they show going well')).toBeNull()
  })

  test('reports an empty request when the phrase stands alone', () => {
    expect(at('hey Shogo')).toEqual({ request: '' })
    expect(at('hey shogo?')).toEqual({ request: '' })
  })
})

const base: WakeDecisionInput = {
  isGuest: false,
  inCall: true,
  notesEnabled: true,
  canChat: true,
  speakerLastWakeAt: null,
  huddleLastWakeAt: null,
  wakeCount: 0,
  now: 1_000_000,
}

describe('decideWake', () => {
  test('lets a participant in the call wake the agent', () => {
    expect(decideWake(base)).toEqual({ wake: true })
  })

  test('never lets a guest start a run', () => {
    expect(decideWake({ ...base, isGuest: true })).toEqual({ wake: false, reason: 'guest' })
  })

  test('needs them still in the call and able to read its chat', () => {
    expect(decideWake({ ...base, inCall: false })).toEqual({ wake: false, reason: 'left' })
    expect(decideWake({ ...base, canChat: false })).toEqual({ wake: false, reason: 'no_chat' })
  })

  test('needs the notes on: the wake is built from the transcript', () => {
    expect(decideWake({ ...base, notesEnabled: false })).toEqual({ wake: false, reason: 'notes_off' })
  })

  test('holds one speaker to a wake every 30 s', () => {
    const justSaid = base.now - (WAKE_SPEAKER_COOLDOWN_MS - 1)
    expect(decideWake({ ...base, speakerLastWakeAt: justSaid })).toEqual({ wake: false, reason: 'speaker_cooldown' })
    expect(decideWake({ ...base, speakerLastWakeAt: base.now - WAKE_SPEAKER_COOLDOWN_MS })).toEqual({ wake: true })
  })

  test('holds the whole call to one wake every 10 s', () => {
    const justNow = base.now - (WAKE_HUDDLE_COOLDOWN_MS - 1)
    expect(decideWake({ ...base, huddleLastWakeAt: justNow })).toEqual({ wake: false, reason: 'huddle_cooldown' })
    expect(decideWake({ ...base, huddleLastWakeAt: base.now - WAKE_HUDDLE_COOLDOWN_MS })).toEqual({ wake: true })
  })

  test('stops after a call has woken the agent 20 times', () => {
    expect(decideWake({ ...base, wakeCount: WAKE_MAX_PER_HUDDLE - 1 })).toEqual({ wake: true })
    expect(decideWake({ ...base, wakeCount: WAKE_MAX_PER_HUDDLE })).toEqual({ wake: false, reason: 'limit' })
  })
})

describe('wakeContextSeconds', () => {
  const withEnv = (value: string | undefined): number => {
    const previous = process.env.HUDDLE_WAKE_CONTEXT_SECONDS
    if (value === undefined) delete process.env.HUDDLE_WAKE_CONTEXT_SECONDS
    else process.env.HUDDLE_WAKE_CONTEXT_SECONDS = value
    try {
      return wakeContextSeconds()
    } finally {
      if (previous === undefined) delete process.env.HUDDLE_WAKE_CONTEXT_SECONDS
      else process.env.HUDDLE_WAKE_CONTEXT_SECONDS = previous
    }
  }

  test('defaults to a minute', () => {
    expect(withEnv(undefined)).toBe(WAKE_CONTEXT_DEFAULT_SECONDS)
    expect(withEnv('')).toBe(WAKE_CONTEXT_DEFAULT_SECONDS)
    expect(withEnv('nonsense')).toBe(WAKE_CONTEXT_DEFAULT_SECONDS)
  })

  test('clamps a silly value instead of honouring it', () => {
    expect(withEnv('1')).toBe(WAKE_CONTEXT_MIN_SECONDS)
    expect(withEnv('100000')).toBe(WAKE_CONTEXT_MAX_SECONDS)
    expect(withEnv('-30')).toBe(WAKE_CONTEXT_DEFAULT_SECONDS)
    expect(withEnv('120')).toBe(120)
  })
})

describe('wakeContext', () => {
  const segment = (start: number, end: number, text: string, speaker = 'Ada') => ({ start, end, text, speaker })

  test('keeps the last minute, ending at the phrase', () => {
    const lines = wakeContext(
      [segment(0, 10, 'earlier'), segment(55, 60, 'just before'), segment(60, 61, 'hey shogo'), segment(90, 95, 'later')],
      61,
      60,
    )
    expect(lines.map((line) => line.text)).toEqual(['earlier', 'just before', 'hey shogo'])
  })

  test('stops at the phrase even when the line started earlier', () => {
    const lines = wakeContext([segment(50, 70, 'a long stretch that runs past the phrase')], 61, 60)
    expect(lines).toHaveLength(1)
    const after = wakeContext([segment(62, 80, 'said after the wake')], 61, 60)
    expect(after).toHaveLength(0)
  })

  test('labels every line with its speaker, including an unnamed one', () => {
    const lines = wakeContext([{ start: 1, end: 2, text: 'hi' }, segment(3, 4, 'hello')], 10, 60)
    expect(lines.map((line) => line.speaker)).toEqual(['Someone', 'Ada'])
  })

  test('drops empty lines and caps the total it hands over', () => {
    expect(wakeContext([segment(1, 2, '   ')], 10, 60)).toHaveLength(0)
    const lines = wakeContext([segment(1, 2, 'x'.repeat(60)), segment(3, 4, 'y'.repeat(60))], 10, 60, { maxChars: 100 })
    expect(lines).toHaveLength(1)
  })
})
