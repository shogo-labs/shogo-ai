// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The coverage model: who transcribes whom, when the fallback steps in and
 * steps back, and what a handover leaves duplicated in the transcript.
 */

import { describe, expect, test } from 'bun:test'
import {
  FALLBACK_DELAY_MS,
  NOTES_ATTRIBUTE,
  NOTES_COVERING_ATTRIBUTE,
  NotesCoverage,
  coveredIdentities,
  dedupeHandoverSegments,
  isNotesAgent,
  notesItemSource,
  normalizeForCompare,
  parseCovering,
  textSimilarity,
  uncoveredSpeakers,
  type NotesParticipant,
} from '../huddle-notes-coverage'

const person = (identity: string, over: Partial<NotesParticipant> = {}): NotesParticipant => ({
  identity,
  hasMicrophone: true,
  muted: false,
  attributes: {},
  ...over,
})

const selfStreaming = (identity: string) =>
  person(identity, { attributes: { [NOTES_ATTRIBUTE]: 'self' } })

/** A coverer streams its own mic as well as the tracks it covers. */
const covering = (identity: string, whoms: string[]) =>
  person(identity, {
    attributes: { [NOTES_ATTRIBUTE]: 'self', [NOTES_COVERING_ATTRIBUTE]: whoms.join(',') },
  })

describe('attributes', () => {
  test('a coverer lists the identities it streams, tolerating spaces and gaps', () => {
    expect(parseCovering('ana, ben')).toEqual(['ana', 'ben'])
    expect(parseCovering(' , ,ana,,')).toEqual(['ana'])
    expect(parseCovering('')).toEqual([])
    expect(parseCovering(null)).toEqual([])
  })

  test('coverage is a device doing it itself, or a coverer naming it', () => {
    const covered = coveredIdentities([selfStreaming('web'), covering('web', ['phone', 'guest']), person('quiet')])
    expect([...covered].sort()).toEqual(['guest', 'phone', 'web'])
  })

  test('the hidden agent is never a participant anyone covers, or covers itself', () => {
    expect(isNotesAgent('huddle-notes')).toBe(true)
    expect(isNotesAgent('huddle-notes-7f3')).toBe(true)
    expect(isNotesAgent('ana')).toBe(false)
    expect(uncoveredSpeakers([person('huddle-notes'), person('ana')])).toEqual(['ana'])
  })
})

describe('uncoveredSpeakers', () => {
  test('a device streaming itself needs no fallback', () => {
    expect(uncoveredSpeakers([selfStreaming('ana')])).toEqual([])
  })

  test('a native-app participant with nobody covering is uncovered', () => {
    expect(uncoveredSpeakers([person('phone'), selfStreaming('web')])).toEqual(['phone'])
  })

  test('a muted track is not transcribed, so it is not uncovered either', () => {
    expect(uncoveredSpeakers([person('phone', { muted: true })])).toEqual([])
  })

  test('a participant with no microphone (screen share only) is skipped', () => {
    expect(uncoveredSpeakers([person('screen', { hasMicrophone: false })])).toEqual([])
  })

  test('a coverer that stops naming the track leaves it uncovered', () => {
    expect(uncoveredSpeakers([covering('web', ['phone']), person('phone')])).toEqual([])
    expect(uncoveredSpeakers([selfStreaming('web'), person('phone')])).toEqual(['phone'])
  })
})

describe('NotesCoverage', () => {
  test('waits the full delay before taking an uncovered track', () => {
    const coverage = new NotesCoverage()
    const roster = [person('phone')]
    expect(coverage.sync(roster, 1_000).start).toEqual([])
    expect(coverage.sync(roster, 1_000 + FALLBACK_DELAY_MS - 1).start).toEqual([])
    expect(coverage.sync(roster, 1_000 + FALLBACK_DELAY_MS).start).toEqual(['phone'])
    expect(coverage.active).toEqual(['phone'])
  })

  test('hands the track back as soon as a client covers it, and re-takes it later', () => {
    const coverage = new NotesCoverage()
    const now = 10_000
    coverage.sync([person('phone')], now)
    expect(coverage.sync([person('phone')], now + FALLBACK_DELAY_MS).start).toEqual(['phone'])

    expect(coverage.sync([covering('web', ['phone']), person('phone')], now + 6_000).stop).toEqual(['phone'])
    expect(coverage.active).toEqual([])

    const back = coverage.sync([selfStreaming('web'), person('phone')], now + 7_000)
    expect(back.start).toEqual([])
    expect(coverage.sync([selfStreaming('web'), person('phone')], now + 7_000 + FALLBACK_DELAY_MS).start).toEqual(['phone'])
  })

  test('a track that stays uncovered is not restarted on every pass', () => {
    const coverage = new NotesCoverage()
    const roster = [person('phone')]
    expect(coverage.sync(roster, 0).start).toEqual([])
    expect(coverage.sync(roster, FALLBACK_DELAY_MS).start).toEqual(['phone'])
    expect(coverage.sync(roster, FALLBACK_DELAY_MS + 1_000).start).toEqual([])
    expect(coverage.sync(roster, FALLBACK_DELAY_MS + 9_000).start).toEqual([])
    expect(coverage.active).toEqual(['phone'])
  })

  test('someone who leaves closes their stream and is forgotten', () => {
    const coverage = new NotesCoverage()
    coverage.sync([person('phone')], 0)
    coverage.sync([person('phone')], FALLBACK_DELAY_MS)
    expect(coverage.sync([person('web')], FALLBACK_DELAY_MS + 1).stop).toEqual(['phone'])
    expect(coverage.active).toEqual([])
    // Coming back starts a fresh delay rather than resuming.
    expect(coverage.sync([person('phone')], FALLBACK_DELAY_MS + 2).start).toEqual([])
  })

  test('notes off forgets everyone, so turning them on re-measures', () => {
    const coverage = new NotesCoverage()
    coverage.sync([person('phone')], 0)
    coverage.sync([person('phone')], FALLBACK_DELAY_MS)
    coverage.clear()
    expect(coverage.active).toEqual([])
    expect(coverage.sync([person('phone')], FALLBACK_DELAY_MS + 1).start).toEqual([])
  })
})

describe('item sources', () => {
  test('client and fallback lines are distinguishable by item id', () => {
    expect(notesItemSource('c:user_1:12')).toBe('client')
    expect(notesItemSource('lk:user_1:12')).toBe('livekit')
    expect(notesItemSource('12')).toBeNull()
    expect(notesItemSource(null)).toBeNull()
  })
})

describe('text matching', () => {
  test('normalising ignores case, punctuation and spacing', () => {
    expect(normalizeForCompare('  Ship it,  Friday! ')).toBe('ship it friday')
    expect(normalizeForCompare('São Paulo')).toBe('são paulo')
  })

  test('similarity is high for the same words and low for different ones', () => {
    expect(textSimilarity('ship it friday', 'Ship it Friday')).toBe(1)
    expect(textSimilarity('ship it friday', 'ship it')).toBeGreaterThan(0.6)
    expect(textSimilarity('ship it friday', 'lets talk about pricing')).toBeLessThan(0.3)
  })
})

describe('dedupeHandoverSegments', () => {
  const seg = (over: Partial<Parameters<typeof dedupeHandoverSegments>[0][number]>) => ({
    start: 10,
    end: 12,
    text: 'ship it friday',
    speaker: 'Ana',
    itemId: 'c:ana:1',
    ...over,
  })

  test('a handover line said once by both paths is kept once', () => {
    const kept = dedupeHandoverSegments([seg({}), seg({ itemId: 'lk:ana:1', start: 11, end: 13 })])
    expect(kept).toHaveLength(1)
    expect(kept[0].itemId).toBe('c:ana:1')
  })

  test('the client copy wins whichever order the segments arrive in', () => {
    const kept = dedupeHandoverSegments([seg({ itemId: 'lk:ana:1' }), seg({ start: 11, end: 13 })])
    expect(kept).toHaveLength(1)
    expect(kept[0].itemId).toBe('c:ana:1')
  })

  test('two fallback copies of one line are left alone — the agent does not double-write', () => {
    const kept = dedupeHandoverSegments([seg({ itemId: 'lk:ana:1' }), seg({ itemId: 'lk:ana:2', start: 11, end: 13 })])
    expect(kept).toHaveLength(2)
  })

  test('different speakers saying the same words are both kept', () => {
    const kept = dedupeHandoverSegments([seg({}), seg({ speaker: 'Ben', itemId: 'lk:ben:1' })])
    expect(kept).toHaveLength(2)
  })

  test('different words at the same moment are both kept', () => {
    const kept = dedupeHandoverSegments([seg({}), seg({ text: 'we should ship monday', itemId: 'lk:ana:2' })])
    expect(kept).toHaveLength(2)
  })

  test('the same person repeating themselves on one path is untouched', () => {
    const kept = dedupeHandoverSegments([seg({}), seg({ start: 11, end: 13 })])
    expect(kept).toHaveLength(2)
  })

  test('lines that do not overlap in time are both kept, even with the same words', () => {
    const kept = dedupeHandoverSegments([seg({}), seg({ itemId: 'lk:ana:2', start: 30, end: 32 })])
    expect(kept).toHaveLength(2)
  })

  test('a long call with many handovers keeps everything that was really said', () => {
    const segments = [
      seg({ itemId: 'c:ana:1', start: 1, end: 3, text: 'first point' }),
      seg({ itemId: 'lk:ana:1', start: 2, end: 4, text: 'first point' }),
      seg({ itemId: 'c:ben:1', start: 5, end: 7, text: 'agreed', speaker: 'Ben' }),
      seg({ itemId: 'lk:ana:2', start: 8, end: 10, text: 'second point' }),
      seg({ itemId: 'c:ana:2', start: 9, end: 11, text: 'second point' }),
    ]
    const kept = dedupeHandoverSegments(segments)
    expect(kept.map((s) => s.text)).toEqual(['first point', 'agreed', 'second point'])
    expect(kept.every((s) => notesItemSource(s.itemId) === 'client' || s.itemId === 'lk:ana:2')).toBe(true)
  })

  test('anything without an item id is left alone', () => {
    const kept = dedupeHandoverSegments([seg({ itemId: null }), seg({ itemId: null, start: 11, end: 13 })])
    expect(kept).toHaveLength(2)
  })

  test('two people who share a name are not one speaker', () => {
    const kept = dedupeHandoverSegments([
      seg({ speaker: 'Alex', speakerId: 'u-alex-1' }),
      seg({ speaker: 'Alex', speakerId: 'u-alex-2', itemId: 'lk:u-alex-2:1', start: 11, end: 13 }),
    ])
    expect(kept).toHaveLength(2)
  })

  test('one person under two labels is still one speaker', () => {
    // A coverer labels the phone by its guest name, the phone's own stream by
    // its display name: the id is what identifies them.
    const kept = dedupeHandoverSegments([
      seg({ speaker: 'Ben', speakerId: 'u-ben', itemId: 'c:u-ben:1' }),
      seg({ speaker: 'Ben (phone)', speakerId: 'u-ben', itemId: 'lk:u-ben:1', start: 11, end: 13 }),
    ])
    expect(kept).toHaveLength(1)
    expect(kept[0].itemId).toBe('c:u-ben:1')
  })
})
