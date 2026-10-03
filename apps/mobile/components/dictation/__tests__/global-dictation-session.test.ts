// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, mock, test } from 'bun:test'

// The component file imports react-native / the desktop-dictation module; only
// the pure session driver is under test.
mock.module('react-native', () => ({ Text: 'Text', View: 'View' }))
class MicPermissionError extends Error {}
mock.module('../../chat/desktop-dictation', () => ({
  MicPermissionError,
  startDesktopDictation: async () => null,
  transcribeDesktopClip: async () => '',
}))
mock.module('../../../lib/desktop-bridge', () => ({ getDesktopBridge: () => null }))

const { createGlobalDictationSession } = await import('../GlobalDictationListener')

function setup(opts: { startDelay?: boolean; text?: string; startError?: Error } = {}) {
  const phases: Array<[string, string | undefined]> = []
  const wav = new Blob(['RIFF'])
  const session = { stop: mock(async () => wav as Blob | null), cancel: mock(() => {}) }
  let release: () => void = () => {}
  const start = mock(async () => {
    if (opts.startError) throw opts.startError
    if (opts.startDelay) await new Promise<void>((r) => (release = r))
    return session as any
  })
  const transcribe = mock(async (_: Blob) => opts.text ?? ' hello ')
  const deliver = mock(async (_: string) => ({ ok: true }))
  const driver = createGlobalDictationSession({
    start: start as any,
    transcribe: transcribe as any,
    deliver,
    onPhase: (p, m) => phases.push([p, m]),
  })
  return { driver, session, start, transcribe, deliver, phases, release: () => release() }
}

describe('global dictation session', () => {
  test('start then stop transcribes and delivers trimmed text', async () => {
    const t = setup()
    await t.driver.start()
    await t.driver.stop()
    expect(t.transcribe).toHaveBeenCalledTimes(1)
    expect(t.deliver).toHaveBeenCalledWith('hello')
    expect(t.phases.map((p) => p[0])).toEqual(['listening', 'transcribing', 'idle'])
  })

  test('cancel drops the clip without transcribing', async () => {
    const t = setup()
    await t.driver.start()
    await t.driver.cancel()
    expect(t.session.cancel).toHaveBeenCalledTimes(1)
    expect(t.transcribe).not.toHaveBeenCalled()
    expect(t.deliver).not.toHaveBeenCalled()
  })

  test('empty transcripts are not delivered', async () => {
    const t = setup({ text: '   ' })
    await t.driver.start()
    await t.driver.stop()
    expect(t.deliver).not.toHaveBeenCalled()
    expect(t.phases.at(-1)![0]).toBe('idle')
  })

  test('a stop that arrives while the mic is still opening is honoured', async () => {
    const t = setup({ startDelay: true })
    const starting = t.driver.start()
    await t.driver.stop()
    expect(t.deliver).not.toHaveBeenCalled()
    t.release()
    await starting
    expect(t.session.stop).toHaveBeenCalledTimes(1)
    expect(t.deliver).toHaveBeenCalledWith('hello')
  })

  test('a mic permission error surfaces an actionable message', async () => {
    const t = setup({ startError: new MicPermissionError('denied') })
    await t.driver.start()
    const last = t.phases.at(-1)!
    expect(last[0]).toBe('error')
    expect(last[1]).toContain('Microphone')
    // A later press can retry.
    await t.driver.stop()
    expect(t.deliver).not.toHaveBeenCalled()
  })

  test('transcription failure reports an error', async () => {
    const t = setup()
    t.transcribe.mockImplementation(async () => {
      throw new Error('no network')
    })
    await t.driver.start()
    await t.driver.stop()
    expect(t.phases.at(-1)).toEqual(['error', 'no network'])
  })
})
