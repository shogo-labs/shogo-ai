// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('../notification-sound-asset', () => ({
  messageSoundUrl: (tone: string = 'knock') => (tone === 'knock' ? '/assets/sounds/soft-knock.mp3' : `/assets/sounds/${tone}.mp3`),
  huddleRingtoneUrl: () => '/assets/sounds/llamada-clara.mp3',
}))

import {
  MESSAGE_SOUND_THROTTLE_MS,
  _resetNotificationAudioForTests,
  claimMessageSound,
  messageSoundKindFor,
  messageSoundRecentlyPlayed,
  playMessageSound,
  previewMessageSound,
  setPreferredMessageTone,
  sharedAudioContext,
  unlockNotificationAudio,
} from '../notification-sound'

class FakeOscillator {
  type = 'sine'
  frequency = { value: 0 }
  started: number[] = []
  stopped: number[] = []
  connect(node: unknown) {
    return node
  }
  start(t: number) {
    this.started.push(t)
  }
  stop(t: number) {
    this.stopped.push(t)
  }
}

class FakeGain {
  peaks: number[] = []
  gain = {
    setValueAtTime: (_v: number, _t: number) => {},
    linearRampToValueAtTime: (v: number, _t: number) => {
      this.peaks.push(v)
    },
    exponentialRampToValueAtTime: (_v: number, _t: number) => {},
  }
  connect(node: unknown) {
    return node
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state: 'suspended' | 'running' = 'suspended'
  currentTime = 0
  destination = {}
  resumeCalls = 0
  oscillators: FakeOscillator[] = []
  gains: FakeGain[] = []
  constructor() {
    FakeAudioContext.instances.push(this)
  }
  resume() {
    this.resumeCalls += 1
    this.state = 'running'
    return Promise.resolve()
  }
  createOscillator() {
    const osc = new FakeOscillator()
    this.oscillators.push(osc)
    return osc
  }
  createGain() {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain
  }
}

const listeners = new Map<string, Array<(event?: unknown) => void>>()
const originalWindow = (globalThis as any).window

function fire(type: string) {
  for (const fn of listeners.get(type) ?? []) fn({})
}

function installWindow() {
  listeners.clear()
  ;(globalThis as any).window = {
    AudioContext: FakeAudioContext,
    addEventListener: (type: string, fn: (event?: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    },
  }
}

function lastContext(): FakeAudioContext {
  return FakeAudioContext.instances[FakeAudioContext.instances.length - 1]
}

beforeEach(() => {
  FakeAudioContext.instances = []
  installWindow()
  _resetNotificationAudioForTests()
})

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as any).window
  else (globalThis as any).window = originalWindow
})

describe('notification-sound: unlock on a user gesture', () => {
  test('the first click or key press creates and resumes one shared context', () => {
    unlockNotificationAudio()
    expect(FakeAudioContext.instances).toHaveLength(0)
    fire('pointerdown')
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(lastContext().resumeCalls).toBe(1)
    expect(lastContext().state).toBe('running')
    fire('keydown')
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(sharedAudioContext()).toBe(lastContext() as unknown as AudioContext)
  })

  test('installing the unlock listeners twice still installs one set', () => {
    unlockNotificationAudio()
    unlockNotificationAudio()
    expect(listeners.get('pointerdown')).toHaveLength(1)
    expect(listeners.get('keydown')).toHaveLength(1)
  })
})

describe('notification-sound: playMessageSound', () => {
  test('stays silent while the context is suspended (no gesture yet)', () => {
    unlockNotificationAudio()
    expect(playMessageSound('dm', 'default', 'knock', 10_000)).toBe(false)
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(lastContext().oscillators).toHaveLength(0)
  })

  test('plays a two-note knock for a direct message once unlocked', () => {
    unlockNotificationAudio()
    fire('pointerdown')
    expect(playMessageSound('dm', 'default', 'knock', 10_000)).toBe(true)
    expect(lastContext().oscillators.map((o) => o.frequency.value)).toEqual([880, 1318.5])
  })

  test('mentions and broadcasts get their own knock, thread replies and others one note', () => {
    unlockNotificationAudio()
    fire('pointerdown')
    playMessageSound('mention', 'default', 'knock', 10_000)
    expect(lastContext().oscillators).toHaveLength(2)
    playMessageSound('thread', 'default', 'knock', 20_000)
    expect(lastContext().oscillators).toHaveLength(3)
    playMessageSound('other', 'default', 'knock', 30_000)
    expect(lastContext().oscillators).toHaveLength(4)
  })

  test('off plays nothing, even when unlocked', () => {
    unlockNotificationAudio()
    fire('pointerdown')
    expect(playMessageSound('dm', 'off', 'knock', 10_000)).toBe(false)
    expect(lastContext().oscillators).toHaveLength(0)
  })

  test('subtle plays at a lower peak than default', () => {
    unlockNotificationAudio()
    fire('pointerdown')
    playMessageSound('dm', 'default', 'knock', 10_000)
    const defaultPeak = Math.max(...lastContext().gains.flatMap((g) => g.peaks))
    _resetNotificationAudioForTests()
    installWindow()
    unlockNotificationAudio()
    fire('pointerdown')
    playMessageSound('dm', 'subtle', 'knock', 10_000)
    const subtlePeak = Math.max(...lastContext().gains.flatMap((g) => g.peaks))
    expect(subtlePeak).toBeGreaterThan(0)
    expect(subtlePeak).toBeLessThan(defaultPeak)
  })

  test('plays at most once per throttle window', () => {
    unlockNotificationAudio()
    fire('pointerdown')
    expect(playMessageSound('dm', 'default', 'knock', 10_000)).toBe(true)
    expect(playMessageSound('mention', 'default', 'knock', 10_000 + 200)).toBe(false)
    expect(playMessageSound('thread', 'default', 'knock', 10_000 + MESSAGE_SOUND_THROTTLE_MS - 1)).toBe(false)
    expect(playMessageSound('thread', 'default', 'knock', 10_000 + MESSAGE_SOUND_THROTTLE_MS)).toBe(true)
  })

  test('reports a cue as recent only inside the throttle window', () => {
    unlockNotificationAudio()
    expect(messageSoundRecentlyPlayed(10_000)).toBe(false)
    fire('pointerdown')
    expect(playMessageSound('dm', 'default', 'knock', 10_000)).toBe(true)
    expect(messageSoundRecentlyPlayed(10_000 + 200)).toBe(true)
    expect(messageSoundRecentlyPlayed(10_000 + MESSAGE_SOUND_THROTTLE_MS - 1)).toBe(true)
    expect(messageSoundRecentlyPlayed(10_000 + MESSAGE_SOUND_THROTTLE_MS)).toBe(false)
  })

  test('only the first tab to claim a message plays its cue', async () => {
    const held = new Set<string>()
    const fakeLocks = {
      request: (name: string, _opts: unknown, cb: (lock: object | null) => unknown) => {
        if (held.has(name)) return Promise.resolve(cb(null))
        held.add(name)
        return Promise.resolve(cb({ name }))
      },
    }
    const nav = globalThis as any
    const original = Object.getOwnPropertyDescriptor(nav, 'navigator')
    Object.defineProperty(nav, 'navigator', { value: { locks: fakeLocks }, configurable: true })
    try {
      expect(await claimMessageSound('c1:m1')).toBe(true)
      expect(await claimMessageSound('c1:m1')).toBe(false)
      expect(await claimMessageSound('c1:m2')).toBe(true)
    } finally {
      if (original) Object.defineProperty(nav, 'navigator', original)
      else delete nav.navigator
    }
  })

  test('a claim resolves true where Web Locks are missing, so a cue is never lost', async () => {
    expect(await claimMessageSound('c1:m9')).toBe(true)
  })

  test('a refused cue does not start the throttle window', () => {
    unlockNotificationAudio()
    expect(playMessageSound('dm', 'default', 'knock', 10_000)).toBe(false)
    fire('pointerdown')
    expect(playMessageSound('dm', 'default', 'knock', 10_100)).toBe(true)
  })

  test('preview ignores the throttle but still respects off', () => {
    unlockNotificationAudio()
    fire('pointerdown')
    playMessageSound('dm', 'default', 'knock', Date.now())
    expect(previewMessageSound('default')).toBe(true)
    expect(previewMessageSound('off')).toBe(false)
  })
})

class FakeBufferSource {
  buffer: unknown = null
  started: number[] = []
  connect(node: unknown) {
    return node
  }
  start(t: number) {
    this.started.push(t)
  }
}

class DecodingAudioContext extends FakeAudioContext {
  sources: FakeBufferSource[] = []
  decoded = 0
  decodeAudioData(_data: ArrayBuffer) {
    this.decoded += 1
    return Promise.resolve({ duration: 2 })
  }
  createBufferSource() {
    const source = new FakeBufferSource()
    this.sources.push(source)
    return source
  }
}

describe('notification-sound: Soft Knock recording', () => {
  const originalFetch = globalThis.fetch
  let fetchOk = true
  let fetched: string[] = []

  beforeEach(() => {
    fetchOk = true
    fetched = []
    ;(globalThis as any).window.AudioContext = DecodingAudioContext
    ;(globalThis as any).fetch = async (url: string) => {
      fetched.push(url)
      return { ok: fetchOk, arrayBuffer: async () => new ArrayBuffer(8) }
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const ctx = () => lastContext() as DecodingAudioContext

  test('the first gesture fetches and decodes the recording once', async () => {
    unlockNotificationAudio()
    fire('pointerdown')
    fire('keydown')
    await flush()
    expect(fetched).toEqual(['/assets/sounds/soft-knock.mp3'])
    expect(ctx().decoded).toBe(1)
  })

  test('once loaded, every kind of message plays the recording instead of tones', async () => {
    unlockNotificationAudio()
    fire('pointerdown')
    await flush()
    expect(playMessageSound('dm', 'default', 'knock', 10_000)).toBe(true)
    expect(playMessageSound('thread', 'default', 'knock', 20_000)).toBe(true)
    expect(ctx().sources).toHaveLength(2)
    expect(ctx().sources.every((s) => s.started.length === 1 && s.buffer)).toBe(true)
    expect(ctx().oscillators).toHaveLength(0)
  })

  test('subtle plays the recording quieter than default', async () => {
    unlockNotificationAudio()
    fire('pointerdown')
    await flush()
    playMessageSound('dm', 'default', 'knock', 10_000)
    playMessageSound('dm', 'subtle', 'knock', 20_000)
    const [loud, quiet] = ctx().gains.map((g) => (g.gain as unknown as { value: number }).value)
    expect(quiet).toBeGreaterThan(0)
    expect(quiet).toBeLessThan(loud)
  })

  test('a message before the recording has loaded still plays the synthesized cue', () => {
    unlockNotificationAudio()
    fire('pointerdown')
    expect(playMessageSound('dm', 'default', 'knock', 10_000)).toBe(true)
    expect(ctx().oscillators.map((o) => o.frequency.value)).toEqual([880, 1318.5])
    expect(ctx().sources).toHaveLength(0)
  })

  test('when the recording cannot be fetched, messages keep the synthesized cue', async () => {
    fetchOk = false
    unlockNotificationAudio()
    fire('pointerdown')
    await flush()
    expect(playMessageSound('dm', 'default', 'knock', 10_000)).toBe(true)
    expect(ctx().sources).toHaveLength(0)
    expect(ctx().oscillators).toHaveLength(2)
  })

  test('the settings preview plays the recording', async () => {
    unlockNotificationAudio()
    fire('pointerdown')
    await flush()
    expect(previewMessageSound('default')).toBe(true)
    await flush()
    expect(ctx().sources).toHaveLength(1)
  })

  test('the chirp tone plays the synthesized cue even once the recording has loaded', async () => {
    unlockNotificationAudio()
    fire('pointerdown')
    await flush()
    expect(playMessageSound('dm', 'default', 'chirp', 10_000)).toBe(true)
    expect(ctx().sources).toHaveLength(0)
    expect(ctx().oscillators.map((o) => o.frequency.value)).toEqual([880, 1318.5])
  })

  test('the first gesture loads the preferred tone instead of Soft Knock', async () => {
    setPreferredMessageTone('glass')
    unlockNotificationAudio()
    fire('pointerdown')
    await flush()
    expect(fetched).toEqual(['/assets/sounds/glass.mp3'])
    expect(playMessageSound('dm', 'default', 'glass', 10_000)).toBe(true)
    expect(ctx().sources).toHaveLength(1)
    expect(ctx().oscillators).toHaveLength(0)
  })

  test('a tone that has not loaded yet plays the synthesized cue and starts loading', async () => {
    unlockNotificationAudio()
    fire('pointerdown')
    await flush()
    expect(playMessageSound('dm', 'default', 'pristine', 10_000)).toBe(true)
    expect(ctx().oscillators).toHaveLength(2)
    await flush()
    expect(fetched).toEqual(['/assets/sounds/soft-knock.mp3', '/assets/sounds/pristine.mp3'])
    expect(playMessageSound('dm', 'default', 'pristine', 20_000)).toBe(true)
    expect(ctx().sources).toHaveLength(1)
  })

  test('the settings preview plays the chosen tone', async () => {
    unlockNotificationAudio()
    fire('pointerdown')
    await flush()
    expect(previewMessageSound('default', 'definite')).toBe(true)
    await flush()
    expect(fetched).toContain('/assets/sounds/definite.mp3')
    expect(ctx().sources).toHaveLength(1)
  })
})

describe('notification-sound: reason mapping', () => {
  test('maps server reasons to cue kinds', () => {
    expect(messageSoundKindFor('dm')).toBe('dm')
    expect(messageSoundKindFor('group_dm')).toBe('dm')
    expect(messageSoundKindFor('mention')).toBe('mention')
    expect(messageSoundKindFor('broadcast')).toBe('mention')
    expect(messageSoundKindFor('thread')).toBe('thread')
    expect(messageSoundKindFor('keyword')).toBe('other')
    expect(messageSoundKindFor('message')).toBe('other')
    expect(messageSoundKindFor(undefined)).toBe('other')
  })
})
