// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one-clip-at-a-time rule, and the speed menu.
 *
 * The audio engine is faked so this checks the store's behaviour rather than
 * the platform's audio API: what got loaded, what got paused, and what the
 * player reads back.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

interface EngineCalls {
  loaded: string[]
  plays: number
  pauses: number
  seeks: number[]
  rates: number[]
}

const calls: EngineCalls = { loaded: [], plays: 0, pauses: 0, seeks: [], rates: [] }
let handlers: {
  onProgress: (positionMs: number, durationMs: number) => void
  onEnded: () => void
  onError: (error?: unknown) => void
}

mock.module('../voice-playback-engine', () => ({
  createVoicePlaybackEngine: (next: typeof handlers) => {
    handlers = next
    return {
      load: (url: string) => calls.loaded.push(url),
      play: () => {
        calls.plays += 1
      },
      pause: () => {
        calls.pauses += 1
      },
      seek: (seconds: number) => calls.seeks.push(seconds),
      setRate: (rate: number) => calls.rates.push(rate),
      release: () => {},
    }
  },
}))

const {
  PLAYBACK_SPEEDS,
  readVoicePlayback,
  seekVoiceNote,
  seekVoiceNoteByMs,
  setVoiceNoteSpeed,
  stopVoiceNote,
  toggleVoiceNote,
  useVoicePlayback,
} = await import('../voice-playback')

// The store is module-level, so each test starts from a stopped clip.
const reset = () => {
  stopVoiceNote()
  calls.loaded = []
  calls.plays = 0
  calls.pauses = 0
  calls.seeks = []
  calls.rates = []
}

const snapshot = () => readVoicePlayback()

const noteA = { id: 'a', url: 'https://api.test/api/conversation-files/a?t=1', durationMs: 10_000 }
const noteB = { id: 'b', url: 'https://api.test/api/conversation-files/b?t=1', durationMs: 20_000 }

beforeEach(reset)

describe('toggleVoiceNote', () => {
  test('starts a clip and reports it as playing', () => {
    toggleVoiceNote(noteA)
    expect(calls.loaded).toEqual([noteA.url])
    expect(calls.plays).toBe(1)
    expect(snapshot()).toMatchObject({ activeId: 'a', isPlaying: true, positionMs: 0 })
  })

  test('pauses the clip that is playing when it is tapped again', () => {
    toggleVoiceNote(noteA)
    toggleVoiceNote(noteA)
    expect(calls.pauses).toBe(1)
    expect(calls.loaded).toHaveLength(1)
    expect(snapshot()).toMatchObject({ activeId: 'a', isPlaying: false })
  })

  test('resumes the same clip without loading it twice', () => {
    toggleVoiceNote(noteA)
    toggleVoiceNote(noteA)
    toggleVoiceNote(noteA)
    expect(calls.loaded).toHaveLength(1)
    expect(calls.plays).toBe(2)
    expect(snapshot()).toMatchObject({ isPlaying: true })
  })

  test('stops whatever was playing when another clip starts', () => {
    toggleVoiceNote(noteA)
    toggleVoiceNote(noteB)
    expect(calls.loaded).toEqual([noteA.url, noteB.url])
    expect(snapshot()).toMatchObject({ activeId: 'b', isPlaying: true, positionMs: 0 })
  })
})

describe('progress and seeking', () => {
  test('reads position and length back from the engine', () => {
    toggleVoiceNote(noteA)
    handlers.onProgress(4_000, 10_000)
    expect(snapshot()).toMatchObject({ positionMs: 4_000, durationMs: 10_000 })
  })

  test('keeps the known length when the engine reports none yet', () => {
    toggleVoiceNote(noteA)
    handlers.onProgress(0, 0)
    expect(snapshot()).toMatchObject({ durationMs: 10_000 })
  })

  test('seeks to a fraction of the clip', () => {
    toggleVoiceNote(noteA)
    seekVoiceNote(noteA, 0.5)
    expect(calls.seeks).toEqual([5])
    expect(snapshot()).toMatchObject({ positionMs: 5_000 })
  })

  test('clamps a seek beyond either end', () => {
    toggleVoiceNote(noteA)
    seekVoiceNote(noteA, -1)
    seekVoiceNote(noteA, 4)
    expect(calls.seeks).toEqual([0, 10])
  })

  test('scrubbing a clip that is not loaded starts it there and plays', () => {
    seekVoiceNote(noteA, 0.25)
    expect(calls.loaded).toEqual([noteA.url])
    expect(calls.plays).toBe(1)
    expect(calls.seeks).toEqual([2.5])
    expect(snapshot()).toMatchObject({ activeId: 'a', isPlaying: true, positionMs: 2_500 })
  })

  test('applies a waveform seek once an older clip reports its length', () => {
    const olderNote = { id: 'c', url: 'https://api.test/c', durationMs: null }
    seekVoiceNote(olderNote, 0.5)
    expect(calls.seeks).toEqual([])
    handlers.onProgress(0, 10_000)
    expect(calls.seeks).toEqual([5])
    expect(snapshot()).toMatchObject({ positionMs: 5_000, durationMs: 10_000 })
  })

  test('moves by five seconds after metadata loads, including repeated key presses', () => {
    const olderNote = { id: 'c', url: 'https://api.test/c', durationMs: null }
    seekVoiceNoteByMs(olderNote, 5_000)
    seekVoiceNoteByMs(olderNote, 5_000)
    expect(calls.seeks).toEqual([])
    handlers.onProgress(0, 20_000)
    expect(calls.seeks).toEqual([10])
    expect(snapshot().positionMs).toBe(10_000)
  })

  test('drops a pending seek when another clip starts', () => {
    seekVoiceNote({ id: 'c', url: 'https://api.test/c', durationMs: null }, 0.5)
    toggleVoiceNote(noteA)
    handlers.onProgress(0, 10_000)
    expect(calls.seeks).toEqual([])
  })

  test('returns to the start when a clip finishes', () => {
    toggleVoiceNote(noteA)
    handlers.onProgress(9_900, 10_000)
    handlers.onEnded()
    expect(snapshot()).toMatchObject({ isPlaying: false, positionMs: 0 })
  })

  test('stops claiming to play when the engine errors', () => {
    toggleVoiceNote(noteA)
    handlers.onError(new Error('decode failed'))
    expect(snapshot()).toMatchObject({ isPlaying: false })
  })
})

describe('speed', () => {
  test('offers the three speeds the menu shows', () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([1, 1.5, 2])
  })

  test('applies the speed to the engine and reports it', () => {
    toggleVoiceNote(noteA)
    setVoiceNoteSpeed(1.5)
    expect(calls.rates).toEqual([1, 1.5])
    expect(snapshot()).toMatchObject({ rate: 1.5 })
  })

  test('sticks for the next clip, the way a person expects', () => {
    setVoiceNoteSpeed(2)
    reset()
    toggleVoiceNote(noteB)
    expect(calls.rates).toEqual([2])
    expect(snapshot()).toMatchObject({ rate: 2 })
    setVoiceNoteSpeed(1)
  })
})

describe('stopVoiceNote', () => {
  test('pauses and clears the loaded clip', () => {
    toggleVoiceNote(noteA)
    stopVoiceNote()
    expect(calls.pauses).toBe(1)
    expect(snapshot()).toMatchObject({ activeId: null, isPlaying: false, positionMs: 0 })
  })

  test('does nothing when no clip is loaded', () => {
    stopVoiceNote()
    expect(calls.pauses).toBe(0)
  })
})

describe('useVoicePlayback', () => {
  test('is exported as the hook players subscribe with', () => {
    expect(typeof useVoicePlayback).toBe('function')
  })
})
