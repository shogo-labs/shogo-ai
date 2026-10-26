// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live captions: a partial settles into its final, two copies of one sentence
 * show once, a line nobody settles still expires, and the strip never grows
 * past what fits on the screen. These are the rules that decide whether a
 * huddle reads as captions or as a wall of repeated text.
 */
import { describe, expect, test } from 'bun:test'
import {
  CAPTION_COLLAPSE_MS,
  CAPTION_FINAL_ATTRIBUTE,
  CAPTION_FINAL_TTL_MS,
  CAPTION_PARTIAL_MIN_INTERVAL_MS,
  CAPTION_PARTIAL_TTL_MS,
  CAPTION_SEGMENT_ATTRIBUTE,
  CAPTION_SPEAKER_ATTRIBUTE,
  CAPTION_TRACK_ATTRIBUTE,
  EMPTY_CAPTIONS,
  captionAttributes,
  captionFromAttributes,
  captionLineLabel,
  captionWindow,
  captionsNotice,
  captionsReducer,
  partialAllowed,
  textSimilarity,
  type CaptionEvent,
  type CaptionState,
} from '../huddle-captions'

/** Fold a list of events, the way the call does as lines arrive. */
const run = (events: CaptionEvent[], window?: number): CaptionState =>
  events.reduce((state, event) => captionsReducer(state, event, { window }), EMPTY_CAPTIONS)

const partial = (itemId: string, text: string, at = 0, speakerId = 'u1'): CaptionEvent => ({
  type: 'partial',
  itemId,
  speakerId,
  text,
  at,
})
const final = (itemId: string, text: string, at = 0, speakerId = 'u1'): CaptionEvent => ({
  type: 'final',
  itemId,
  speakerId,
  text,
  at,
})

describe('captionsReducer', () => {
  test('a partial grows in place and its final replaces it', () => {
    const state = run([partial('a', 'can you'), partial('a', 'can you hear'), final('a', 'can you hear me')])
    expect(state.lines).toHaveLength(1)
    expect(state.lines[0]).toMatchObject({ itemId: 'a', text: 'can you hear me', final: true })
  })

  test('different speakers stack up, oldest first', () => {
    const state = run([final('a', 'first', 0, 'u1'), final('b', 'second', 1, 'u2')])
    expect(state.lines.map((line) => [line.speakerId, line.text])).toEqual([
      ['u1', 'first'],
      ['u2', 'second'],
    ])
  })

  test('the same sentence from a device and the fallback worker shows once', () => {
    // One person, one moment, two item ids: the device heard it and so did the worker.
    const state = run([final('c:7', 'ship it on friday', 1_000), final('lk:u1:3', 'Ship it on Friday!', 1_200)])
    expect(state.lines).toHaveLength(1)
    expect(state.lines[0].text).toBe('Ship it on Friday!')
  })

  test('two people saying the same words are two lines', () => {
    const state = run([final('a', 'sounds good', 0, 'u1'), final('b', 'sounds good', 10, 'u2')])
    expect(state.lines).toHaveLength(2)
  })

  test('the same words long apart are two lines', () => {
    const state = run([final('a', 'ok', 0), final('b', 'ok', CAPTION_COLLAPSE_MS + 1)])
    expect(state.lines).toHaveLength(2)
  })

  test('keeps the newest lines and never more than the window', () => {
    const state = run([final('a', 'one', 0), final('b', 'two', 1), final('c', 'three', 2), final('d', 'four', 3)], 3)
    expect(state.lines.map((line) => line.text)).toEqual(['two', 'three', 'four'])
  })

  test('a settled line goes after 8 s, an unsettled one after 15 s', () => {
    const state = run([final('a', 'settled', 0), partial('b', 'unsettled', 0)])
    expect(captionsReducer(state, { type: 'expire', now: CAPTION_FINAL_TTL_MS }).lines.map((l) => l.text)).toEqual(['unsettled'])
    expect(captionsReducer(state, { type: 'expire', now: CAPTION_PARTIAL_TTL_MS }).lines).toHaveLength(0)
  })

  test('an empty partial does not blank the line it belongs to', () => {
    const state = run([partial('a', 'almost there')])
    expect(captionsReducer(state, partial('a', '   ')).lines[0].text).toBe('almost there')
  })

  test('clear empties the strip, and returns the same state when already empty', () => {
    const shown = run([final('a', 'hello')])
    expect(captionsReducer(shown, { type: 'clear' })).toBe(EMPTY_CAPTIONS)
    expect(captionsReducer(EMPTY_CAPTIONS, { type: 'clear' })).toBe(EMPTY_CAPTIONS)
  })
})

describe('captionWindow', () => {
  test('a phone gets two lines, a wide screen three', () => {
    expect(captionWindow(390)).toBe(2)
    expect(captionWindow(479)).toBe(2)
    expect(captionWindow(480)).toBe(3)
    expect(captionWindow(1280)).toBe(3)
    // Before the first layout pass there is no width: prefer the roomier window.
    expect(captionWindow(0)).toBe(3)
  })
})

describe('publishing', () => {
  test('a partial is throttled so it cannot flood the room', () => {
    expect(partialAllowed(undefined, 1_000)).toBe(true)
    expect(partialAllowed(1_000, 1_000 + CAPTION_PARTIAL_MIN_INTERVAL_MS - 1)).toBe(false)
    expect(partialAllowed(1_000, 1_000 + CAPTION_PARTIAL_MIN_INTERVAL_MS)).toBe(true)
  })

  test('the wire attributes carry the speaker, the item and whether it is settled', () => {
    expect(captionAttributes({ itemId: 'lk:u1:2', speakerId: 'u1', final: true, trackId: 'TR_1' })).toEqual({
      [CAPTION_SEGMENT_ATTRIBUTE]: 'lk:u1:2',
      [CAPTION_FINAL_ATTRIBUTE]: 'true',
      [CAPTION_SPEAKER_ATTRIBUTE]: 'u1',
      [CAPTION_TRACK_ATTRIBUTE]: 'TR_1',
    })
  })
})

describe('receiving', () => {
  test('reads the attributes a sender wrote', () => {
    expect(
      captionFromAttributes({
        [CAPTION_SEGMENT_ATTRIBUTE]: 'lk:u1:2',
        [CAPTION_SPEAKER_ATTRIBUTE]: 'u1',
        [CAPTION_FINAL_ATTRIBUTE]: 'true',
      }),
    ).toEqual({ itemId: 'lk:u1:2', speakerId: 'u1', final: true })
  })

  test('trusts the attribute over the sender identity, which a worker does not have', () => {
    expect(
      captionFromAttributes({ [CAPTION_SEGMENT_ATTRIBUTE]: 'lk:u1:2', [CAPTION_SPEAKER_ATTRIBUTE]: 'u1' }, 'worker'),
    ).toMatchObject({ speakerId: 'u1' })
    expect(captionFromAttributes({ [CAPTION_SEGMENT_ATTRIBUTE]: 'lk:u1:2' }, 'u1')).toMatchObject({ speakerId: 'u1' })
  })

  test('ignores a stream with nothing to attribute it to', () => {
    expect(captionFromAttributes(undefined, null)).toBeNull()
    expect(captionFromAttributes({ [CAPTION_SPEAKER_ATTRIBUTE]: 'u1' }, null)).toBeNull()
  })
})

describe('what the strip says', () => {
  test('names the speaker from the roster, never from the stream', () => {
    const line = { itemId: 'a', speakerId: 'u1', text: 'hi', final: true, at: 0, start: 0 }
    expect(captionLineLabel(line, (id) => (id === 'u1' ? 'Ada' : undefined))).toBe('Ada')
    expect(captionLineLabel(line, () => undefined)).toBe('Someone')
  })

  test('shows the wake as it happens, and clears itself after the answer', () => {
    expect(captionsNotice(null)).toBeNull()
    expect(captionsNotice({ by: 'Ada', status: 'running' })).toContain('Ada')
    expect(captionsNotice({ by: 'Ada', status: 'replied' })).toContain('replied')
    expect(captionsNotice({ by: 'Ada', status: 'failed', reason: 'no model' })).toContain('no model')
  })

  test('says so when the call has used its last wake', () => {
    expect(captionsNotice({ by: 'Ada', status: 'limit' })).toBe('Wake limit reached for this call')
  })
})

describe('textSimilarity', () => {
  test('ignores case and punctuation, and tells a different sentence apart', () => {
    expect(textSimilarity('Ship it on Friday!', 'ship it on friday')).toBe(1)
    expect(textSimilarity('ship it on friday', 'who is on call')).toBeLessThan(0.2)
  })
})
