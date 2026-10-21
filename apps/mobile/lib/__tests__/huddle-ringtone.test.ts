// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createReactNativeMock } from '../../test/react-native-mock'

const vibrate = mock((_pattern: unknown, _repeat?: boolean) => {})
const cancel = mock(() => {})
mock.module('react-native', () => createReactNativeMock({ Vibration: { vibrate, cancel } }))
mock.module('../notification-sound-asset', () => ({
  messageSoundUrl: () => '/assets/sounds/soft-knock.mp3',
  huddleRingtoneUrl: () => '/assets/sounds/llamada-clara.mp3',
}))

const { Platform } = await import('react-native')
const { startRingtone, previewHuddleSound, _resetHuddleRingtoneForTests } = await import('../huddle-ringtone')
const { _resetNotificationAudioForTests } = await import('../notification-sound')
// The mock copies Platform, so flip OS on the object the module actually reads.
const platform = Platform as { OS: string }

class FakeNode {
  connect(node: unknown) {
    return node
  }
}

class FakeOscillator extends FakeNode {
  type = 'sine'
  frequency = { value: 0 }
  start(_t: number) {}
  stop(_t: number) {}
}

class FakeGain extends FakeNode {
  gain = {
    value: 1,
    setValueAtTime: (_v: number, _t: number) => {},
    linearRampToValueAtTime: (_v: number, _t: number) => {},
    exponentialRampToValueAtTime: (_v: number, _t: number) => {},
  }
}

class FakeBufferSource extends FakeNode {
  buffer: unknown = null
  loop = false
  started = false
  stoppedAt: number | undefined | null = null
  start(_t: number) {
    this.started = true
  }
  stop(t?: number) {
    this.stoppedAt = t
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state: 'suspended' | 'running' = 'running'
  currentTime = 0
  destination = {}
  oscillators: FakeOscillator[] = []
  constructor() {
    FakeAudioContext.instances.push(this)
  }
  resume() {
    this.state = 'running'
    return Promise.resolve()
  }
  createOscillator() {
    const osc = new FakeOscillator()
    this.oscillators.push(osc)
    return osc
  }
  createGain() {
    return new FakeGain()
  }
}

/** A context that can decode the recording. */
class DecodingAudioContext extends FakeAudioContext {
  sources: FakeBufferSource[] = []
  decodeAudioData(_data: ArrayBuffer) {
    return Promise.resolve({ duration: 18.5 })
  }
  createBufferSource() {
    const source = new FakeBufferSource()
    this.sources.push(source)
    return source
  }
}

function decodingContext(): DecodingAudioContext {
  return FakeAudioContext.instances[0] as DecodingAudioContext
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Notes scheduled on the shared context so far. */
function notesPlayed(): number {
  return FakeAudioContext.instances.reduce((sum, ctx) => sum + ctx.oscillators.length, 0)
}

const originalWindow = (globalThis as any).window
const originalFetch = globalThis.fetch
const fetchMock = mock((_url: string) => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }))
const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
let interval: { fn: () => void; ms: number } | null = null
const clearIntervalMock = mock((_id?: unknown) => {})

beforeEach(() => {
  platform.OS = 'web'
  FakeAudioContext.instances = []
  ;(globalThis as any).window = { AudioContext: FakeAudioContext, addEventListener: () => {} }
  _resetNotificationAudioForTests()
  _resetHuddleRingtoneForTests()
  fetchMock.mockClear()
  globalThis.fetch = fetchMock as unknown as typeof fetch
  interval = null
  clearIntervalMock.mockClear()
  vibrate.mockClear()
  cancel.mockClear()
  // Capture the repeat timer instead of waiting for it.
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    interval = { fn, ms }
    return 1
  }) as unknown as typeof setInterval
  globalThis.clearInterval = clearIntervalMock as unknown as typeof clearInterval
})

afterEach(() => {
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
  globalThis.fetch = originalFetch
  if (originalWindow === undefined) delete (globalThis as any).window
  else (globalThis as any).window = originalWindow
})

describe('huddle ringtone recording on the web', () => {
  beforeEach(() => {
    ;(globalThis as any).window = { AudioContext: DecodingAudioContext, addEventListener: () => {} }
  })

  test('a direct call chirps until the recording loads, then loops the recording', async () => {
    const stop = startRingtone({ sound: 'ring', loop: true })
    expect(notesPlayed()).toBe(2)
    await flush()
    const ctx = decodingContext()
    expect(fetchMock).toHaveBeenCalledWith('/assets/sounds/llamada-clara.mp3')
    expect(clearIntervalMock).toHaveBeenCalledTimes(1)
    expect(ctx.sources).toHaveLength(1)
    expect(ctx.sources[0].loop).toBe(true)
    expect(ctx.sources[0].started).toBe(true)
    stop()
    expect(ctx.sources[0].stoppedAt).toBeUndefined()
  })

  test('once loaded, a direct call starts on the recording with no chirp', async () => {
    startRingtone({ sound: 'ring', loop: true })()
    await flush()
    const ctx = decodingContext()
    const notesBefore = notesPlayed()
    startRingtone({ sound: 'ring', loop: true })
    expect(notesPlayed()).toBe(notesBefore)
    expect(ctx.sources.at(-1)?.loop).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('a group huddle plays the recording through once', async () => {
    startRingtone({ sound: 'ring', loop: true })()
    await flush()
    startRingtone({ sound: 'ring', loop: false })
    expect(decodingContext().sources.at(-1)?.loop).toBe(false)
  })

  test('stopping before the recording loads keeps it from starting', async () => {
    const stop = startRingtone({ sound: 'ring', loop: true })
    stop()
    await flush()
    expect(decodingContext().sources).toHaveLength(0)
  })

  test('chime stays synthesized and never fetches the recording', () => {
    startRingtone({ sound: 'chime', loop: true })
    expect(notesPlayed()).toBe(3)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('preview plays a six-second cut of the recording', async () => {
    previewHuddleSound('ring')
    await flush()
    const source = decodingContext().sources[0]
    expect(source.loop).toBe(false)
    expect(source.stoppedAt).toBeCloseTo(6.01)
  })

  test('a second preview stops the first', async () => {
    previewHuddleSound('ring')
    await flush()
    previewHuddleSound('ring')
    await flush()
    const [first, second] = decodingContext().sources
    expect(first.stoppedAt).toBeUndefined()
    expect(second.started).toBe(true)
  })

  test('falls back to the chirp when the recording cannot be fetched', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: false, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }))
    startRingtone({ sound: 'ring', loop: true })
    await flush()
    expect(decodingContext().sources).toHaveLength(0)
    expect(interval?.ms).toBe(2_400)
  })
})

describe('huddle ringtone on the web without decoding', () => {
  test('ring plays a two-note chirp and repeats every 2.4 s until stopped', () => {
    const stop = startRingtone({ sound: 'ring', loop: true })
    expect(notesPlayed()).toBe(2)
    expect(interval?.ms).toBe(2_400)
    interval?.fn()
    expect(notesPlayed()).toBe(4)
    stop()
    expect(clearIntervalMock).toHaveBeenCalledTimes(1)
  })

  test('chime plays three softer notes on its own repeat', () => {
    startRingtone({ sound: 'chime', loop: true })
    expect(notesPlayed()).toBe(3)
    expect(interval?.ms).toBe(3_200)
  })

  test('a group huddle plays its cue once and starts no repeat timer', () => {
    startRingtone({ sound: 'ring', loop: false })
    expect(notesPlayed()).toBe(2)
    expect(interval).toBeNull()
  })

  test('off plays nothing and starts no timer', () => {
    const stop = startRingtone({ sound: 'off', loop: true })
    expect(notesPlayed()).toBe(0)
    expect(interval).toBeNull()
    expect(() => stop()).not.toThrow()
  })

  test('the default is the ring, repeated for a direct call', () => {
    startRingtone()
    expect(notesPlayed()).toBe(2)
    expect(interval?.ms).toBe(2_400)
  })

  test('preview plays one cue, and nothing for off', () => {
    previewHuddleSound('chime')
    expect(notesPlayed()).toBe(3)
    previewHuddleSound('off')
    expect(notesPlayed()).toBe(3)
  })
})

describe('huddle ringtone on a phone', () => {
  beforeEach(() => {
    platform.OS = 'ios'
  })

  test('a direct call vibrates on a repeat until stopped', () => {
    startRingtone({ sound: 'ring', loop: true })
    expect(vibrate).toHaveBeenCalledWith([0, 400, 300, 400], true)
  })

  test('a group huddle vibrates once', () => {
    startRingtone({ sound: 'ring', loop: false })
    expect(vibrate).toHaveBeenCalledWith([0, 400, 300, 400], false)
  })

  test('no vibration while the system call screen is already ringing', () => {
    startRingtone({ sound: 'ring', loop: true, vibrate: false })
    expect(vibrate).not.toHaveBeenCalled()
  })

  test('off neither vibrates nor plays', () => {
    startRingtone({ sound: 'off', loop: true })
    expect(vibrate).not.toHaveBeenCalled()
  })

  test('stopping cancels the vibration', () => {
    const stop = startRingtone({ sound: 'ring', loop: true })
    stop()
    expect(cancel).toHaveBeenCalled()
  })

  test('preview buzzes once', () => {
    previewHuddleSound('ring')
    expect(vibrate).toHaveBeenCalledWith([0, 400, 300, 400])
  })
})
