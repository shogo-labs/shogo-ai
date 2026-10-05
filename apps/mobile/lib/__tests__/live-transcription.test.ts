// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { beforeEach, describe, expect, test } from 'bun:test'
import { createPushTap, createStreamSink, type LiveChunk } from '../live-audio'
import { startAdaptiveLive } from '../live-transcription'
import { reduceLiveMeeting, snapshotFromTranscript, EMPTY_LIVE_MEETING } from '../use-live-meeting-transcript'
import { FakeSocket } from './fake-socket'

const RATE = 16000
const ticket = async () => ({ ticket: 't', path: '/api/meetings/live-stream', backend: 'openai' })
const noise = (seconds: number) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => 0.3 * Math.sin(i / 7))

beforeEach(() => FakeSocket.reset())

describe('createPushTap', () => {
  test('holds frames until a consumer attaches, then replays them in order', () => {
    const tap = createPushTap(RATE)
    const a = new Float32Array([1])
    const b = new Float32Array([2])
    tap.push(a)
    tap.push(b)
    const seen: Float32Array[] = []
    tap.attach((f) => seen.push(f))
    tap.push(new Float32Array([3]))
    expect(seen.map((f) => f[0])).toEqual([1, 2, 3])
    tap.disconnect()
    tap.push(new Float32Array([4]))
    expect(seen).toHaveLength(3)
  })

  test('keeps only the most recent 30 seconds while nothing is attached', () => {
    const tap = createPushTap(RATE)
    for (let i = 0; i < 40; i++) tap.push(new Float32Array(RATE).fill(i))
    const seen: Float32Array[] = []
    tap.attach((f) => seen.push(f))
    expect(seen.length).toBeLessThanOrEqual(31)
    expect(seen.at(-1)![0]).toBe(39)
  })
})

describe('createStreamSink', () => {
  test('regroups audio into 100 ms Int16 frames at 16 kHz, resampling from the mic rate', () => {
    const sent: Int16Array[] = []
    const sink = createStreamSink(48000, (f) => sent.push(f))
    sink.push(new Float32Array(48000 * 0.25).fill(0.5))
    expect(sent.map((f) => f.length)).toEqual([1600, 1600])
    expect(sent[0][10]).toBeGreaterThan(16000)
    sink.flush()
    expect(sent.at(-1)!.length).toBe(800)
  })
})

describe('startAdaptiveLive', () => {
  const base = () => {
    const chunks: LiveChunk[] = []
    const modes: string[] = []
    return {
      chunks,
      modes,
      options: (tap = createPushTap(RATE)) => ({
        tap,
        getTicket: ticket,
        wsBase: 'ws://x',
        WebSocketImpl: FakeSocket,
        connectTimeoutMs: 50,
        postChunk: async (chunk: LiveChunk) => {
          chunks.push(chunk)
        },
        onMode: (mode: string) => modes.push(mode),
      }),
    }
  }

  test('streams when the server can, including audio captured while connecting', async () => {
    const t = base()
    const tap = createPushTap(RATE)
    const capture = startAdaptiveLive(t.options(tap))
    tap.push(noise(0.5)) // heard before the socket is ready
    await new Promise((r) => setTimeout(r, 10))
    tap.push(noise(0.5))
    const summary = await capture.stop()
    expect(t.modes).toEqual(['stream'])
    expect(t.chunks).toHaveLength(0)
    expect(FakeSocket.last.audioSeconds()).toBeCloseTo(1, 1)
    expect(summary.complete).toBe(true)
  })

  test('falls back to chunk upload, without losing the start, when streaming is unavailable', async () => {
    FakeSocket.reset('error')
    const t = base()
    const tap = createPushTap(RATE)
    const capture = startAdaptiveLive(t.options(tap))
    tap.push(noise(7))
    await new Promise((r) => setTimeout(r, 20))
    tap.push(noise(7))
    const summary = await capture.stop()
    expect(t.modes).toEqual(['chunks'])
    expect(t.chunks.length).toBeGreaterThanOrEqual(1)
    expect(t.chunks[0].start).toBe(0)
    expect(summary.seconds).toBeGreaterThan(13)
  })

  test('when the stream dies mid-meeting, chunks take over from where it stopped and the result is flagged incomplete', async () => {
    const t = base()
    const tap = createPushTap(RATE)
    const capture = startAdaptiveLive(t.options(tap))
    await new Promise((r) => setTimeout(r, 10))
    tap.push(noise(2))
    FakeSocket.last.receive({ type: 'error', code: 'backend_error', message: 'recognizer died', fatal: true })
    tap.push(noise(9))
    tap.push(noise(9))
    const summary = await capture.stop()
    expect(t.modes).toEqual(['stream', 'chunks'])
    expect(t.chunks.length).toBeGreaterThanOrEqual(1)
    expect(t.chunks[0].start).toBeGreaterThanOrEqual(1.9)
    expect(summary.complete).toBe(false)
  })
})

describe('reduceLiveMeeting', () => {
  test('partials replace each other and a final clears them', () => {
    let state = reduceLiveMeeting(EMPTY_LIVE_MEETING, { type: 'partial', text: 'hel' })
    state = reduceLiveMeeting(state, { type: 'partial', text: 'hello wor' })
    expect(state.partial).toBe('hello wor')
    state = reduceLiveMeeting(state, { type: 'final', segment: { start: 0, end: 2, text: 'hello world' } })
    expect(state.partial).toBeNull()
    expect(state.segments.map((s) => s.text)).toEqual(['hello world'])
  })

  test('finals stay in time order and replays are not duplicated', () => {
    const s1 = { start: 4, end: 6, text: 'later' }
    const s0 = { start: 0, end: 2, text: 'earlier' }
    let state = reduceLiveMeeting(EMPTY_LIVE_MEETING, { type: 'final', segment: s1 })
    state = reduceLiveMeeting(state, { type: 'final', segment: s0 })
    state = reduceLiveMeeting(state, { type: 'final', segment: s0 })
    expect(state.segments.map((s) => s.text)).toEqual(['earlier', 'later'])
  })

  test('a snapshot after a reconnect replaces state and carries the server notice', () => {
    const state = reduceLiveMeeting(
      { ...EMPTY_LIVE_MEETING, partial: 'stale' },
      { type: 'snapshot', segments: [{ start: 0, end: 1, text: 'hi' }], liveStatus: { state: 'error', message: 'No key' }, status: 'recording' },
    )
    expect(state).toMatchObject({ partial: null, notice: 'No key', ended: false })
    expect(state.segments).toHaveLength(1)
  })

  test('status clears the notice when transcription recovers; ended is sticky', () => {
    let state = reduceLiveMeeting(EMPTY_LIVE_MEETING, { type: 'status', state: 'error', message: 'down' })
    expect(state.notice).toBe('down')
    state = reduceLiveMeeting(state, { type: 'status', state: 'ok' })
    expect(state.notice).toBeNull()
    state = reduceLiveMeeting(state, { type: 'ended' })
    expect(state.ended).toBe(true)
  })

  test('snapshotFromTranscript reads the stored draft and tolerates junk', () => {
    const raw = JSON.stringify({ segments: [{ start: 0, end: 1, text: 'x' }], liveStatus: { state: 'error', message: 'm' } })
    expect(snapshotFromTranscript(raw, 'recording')).toMatchObject({ type: 'snapshot', status: 'recording' })
    expect(snapshotFromTranscript('not json')).toBeNull()
    expect(snapshotFromTranscript(null)).toBeNull()
  })
})
