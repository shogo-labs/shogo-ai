// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for OutputStreamer.
 *
 * Tests cover:
 *   - stripAnsi: removes CSI, OSC, DCS sequences
 *   - feedOutput: accumulates and debounces
 *   - flushAndFinish: flushes remaining buffer
 *   - threshold: immediate flush when buffer exceeds threshold
 *   - lifecycle: start/stop/dispose
 *   - state tracking: getState, getAccumulated, reset
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { OutputStreamer, stripAnsi } from '../output-streamer'
import { Osc633Tracker } from '../osc633-tracker'

// ─── stripAnsi ──────────────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('removes CSI sequences', () => {
    expect(stripAnsi('\x1b[31mred text\x1b[0m')).toBe('red text')
    expect(stripAnsi('\x1b[1;32mbold green\x1b[0m')).toBe('bold green')
  })

  it('removes cursor movement sequences', () => {
    expect(stripAnsi('\x1b[2K\x1b[1G')).toBe('')
    expect(stripAnsi('before\x1b[5Cafter')).toBe('beforeafter')
  })

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
    expect(stripAnsi('')).toBe('')
  })

  it('handles mixed content', () => {
    expect(stripAnsi('\x1b[31merror:\x1b[0m something broke'))
      .toBe('error: something broke')
  })
})

// ─── OutputStreamer ─────────────────────────────────────────────────────

describe('OutputStreamer', () => {
  let tracker: Osc633Tracker

  beforeEach(() => {
    tracker = new Osc633Tracker()
  })

  describe('feedOutput()', () => {
    it('accumulates output and flushes on debounce', async () => {
      const chunks: string[] = []
      const streamer = new OutputStreamer({
        tracker,
        onData: (chunk) => chunks.push(chunk),
        debounceMs: 50,
      })

      streamer.start()
      streamer.feedOutput('hello ')
      streamer.feedOutput('world')

      // Not flushed yet (within debounce window)
      expect(chunks).toHaveLength(0)

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 80))

      expect(chunks).toEqual(['hello world'])
      expect(streamer.getState().totalFlushed).toBe(11)
      streamer.dispose()
    })

    it('flushes immediately when threshold exceeded', () => {
      const chunks: string[] = []
      const streamer = new OutputStreamer({
        tracker,
        onData: (chunk) => chunks.push(chunk),
        debounceMs: 5000,
        thresholdChars: 10,
      })

      streamer.start()
      streamer.feedOutput('a'.repeat(11)) // exceeds threshold

      // Should flush immediately
      expect(chunks).toHaveLength(1)
      expect(chunks[0]).toBe('a'.repeat(11))
      streamer.dispose()
    })

    it('strips ANSI from output', () => {
      const chunks: string[] = []
      const streamer = new OutputStreamer({
        tracker,
        onData: (chunk) => chunks.push(chunk),
        debounceMs: 0,
        thresholdChars: 1,
      })

      streamer.start()
      streamer.feedOutput('\x1b[31merror\x1b[0m')

      expect(chunks).toEqual(['error'])
      streamer.dispose()
    })

    it('no-op when not started', () => {
      const chunks: string[] = []
      const streamer = new OutputStreamer({
        tracker,
        onData: (chunk) => chunks.push(chunk),
        debounceMs: 0,
      })

      // Don't call start()
      streamer.feedOutput('should be ignored')
      expect(chunks).toHaveLength(0)
      streamer.dispose()
    })

    it('no-op after dispose', () => {
      const chunks: string[] = []
      const streamer = new OutputStreamer({
        tracker,
        onData: (chunk) => chunks.push(chunk),
        debounceMs: 0,
      })

      streamer.start()
      streamer.dispose()
      streamer.feedOutput('should be ignored')
      expect(chunks).toHaveLength(0)
    })

    it('skips empty/whitespace-only stripped output', () => {
      const chunks: string[] = []
      const streamer = new OutputStreamer({
        tracker,
        onData: (chunk) => chunks.push(chunk),
        debounceMs: 0,
      })

      streamer.start()
      streamer.feedOutput('\x1b[31m\x1b[0m') // ANSI that strips to empty
      streamer.feedOutput('   ') // whitespace only
      expect(chunks).toHaveLength(0)
      streamer.dispose()
    })
  })

  describe('flushAndFinish()', () => {
    it('flushes remaining buffer and marks inactive', () => {
      const chunks: string[] = []
      const streamer = new OutputStreamer({
        tracker,
        onData: (chunk) => chunks.push(chunk),
        debounceMs: 5000,
        thresholdChars: 1000,
      })

      streamer.start()
      streamer.feedOutput('partial output')

      expect(chunks).toHaveLength(0) // not yet flushed

      streamer.flushAndFinish()

      expect(chunks).toEqual(['partial output'])
      expect(streamer.getState().active).toBe(false)
      streamer.dispose()
    })

    it('does nothing if buffer is empty', () => {
      const chunks: string[] = []
      const streamer = new OutputStreamer({
        tracker,
        onData: (chunk) => chunks.push(chunk),
      })

      streamer.start()
      streamer.flushAndFinish()
      expect(chunks).toHaveLength(0)
      streamer.dispose()
    })
  })

  describe('stop() / start()', () => {
    it('can be stopped and resumed', async () => {
      const chunks: string[] = []
      const streamer = new OutputStreamer({
        tracker,
        onData: (chunk) => chunks.push(chunk),
        debounceMs: 50,
      })

      streamer.start()
      streamer.feedOutput('first ')

      streamer.stop()
      expect(chunks).toEqual(['first ']) // stopped = flushed

      // Feed while stopped — should be ignored
      streamer.feedOutput('ignored')
      expect(chunks).toHaveLength(1)

      // Resume
      streamer.start()
      streamer.feedOutput('second')
      await new Promise((r) => setTimeout(r, 80))

      expect(chunks).toEqual(['first ', 'second'])
      streamer.dispose()
    })
  })

  describe('getState()', () => {
    it('tracks buffered and flushed chars', () => {
      const streamer = new OutputStreamer({
        tracker,
        onData: () => {},
        debounceMs: 5000,
        thresholdChars: 1000,
      })

      streamer.start()
      let state = streamer.getState()
      expect(state.active).toBe(true)
      expect(state.bufferedChars).toBe(0)
      expect(state.totalFlushed).toBe(0)

      streamer.feedOutput('hello')
      state = streamer.getState()
      expect(state.bufferedChars).toBe(5)

      streamer.feedOutput(' world')
      state = streamer.getState()
      expect(state.bufferedChars).toBe(11)
      expect(state.totalFlushed).toBe(0)

      streamer.dispose()
    })
  })

  describe('getAccumulated()', () => {
    it('returns buffered content', () => {
      const streamer = new OutputStreamer({
        tracker,
        onData: () => {},
        debounceMs: 5000,
        thresholdChars: 1000,
      })

      streamer.start()
      streamer.feedOutput('abc')
      streamer.feedOutput('def')
      expect(streamer.getAccumulated()).toBe('abcdef')
      streamer.dispose()
    })
  })

  describe('reset()', () => {
    it('clears buffer and counters', () => {
      const chunks: string[] = []
      const streamer = new OutputStreamer({
        tracker,
        onData: (chunk) => chunks.push(chunk),
        debounceMs: 5000,
        thresholdChars: 1000,
      })

      streamer.start()
      streamer.feedOutput('some output')
      streamer.reset()

      expect(streamer.getAccumulated()).toBe('')
      expect(streamer.getState().totalFlushed).toBe(0)
      streamer.dispose()
    })
  })

  describe('dispose()', () => {
    it('cleans up timers and prevents further use', async () => {
      const chunks: string[] = []
      const streamer = new OutputStreamer({
        tracker,
        onData: (chunk) => chunks.push(chunk),
        debounceMs: 50,
      })

      streamer.start()
      streamer.feedOutput('buffered')
      streamer.dispose()

      // Wait past debounce — should not flush after dispose
      await new Promise((r) => setTimeout(r, 100))
      expect(chunks).toHaveLength(0)
    })
  })
})
