// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, expect, test } from 'bun:test'
import { createVoicePlaybackEngine } from '../voice-playback-engine.web'

const originalAudio = globalThis.Audio
const instances: FakeAudio[] = []

class FakeAudio {
  src = ''
  preload = ''
  currentTime = 0
  duration = 10
  playbackRate = 1
  playPromise: Promise<void> = Promise.resolve()
  pauses = 0
  loads = 0

  constructor() { instances.push(this) }
  addEventListener() {}
  removeAttribute(name: string) { if (name === 'src') this.src = '' }
  load() { this.loads += 1 }
  pause() { this.pauses += 1 }
  play() { return this.playPromise }
}

Object.defineProperty(globalThis, 'Audio', { value: FakeAudio, configurable: true })
afterAll(() => Object.defineProperty(globalThis, 'Audio', { value: originalAudio, configurable: true }))

test('uses a warmed note and ignores a rejected play from a previous note', async () => {
  instances.length = 0
  const errors: unknown[] = []
  const engine = createVoicePlaybackEngine({
    onProgress: () => {},
    onEnded: () => {},
    onError: (error) => errors.push(error),
  })

  const releasePreload = engine.preload('/first')
  expect(instances).toHaveLength(1)
  engine.load('/first')
  expect(instances).toHaveLength(1)

  let rejectOldPlay: (error: Error) => void = () => {}
  instances[0].playPromise = new Promise<void>((_, reject) => { rejectOldPlay = reject })
  engine.play()
  engine.load('/second')
  rejectOldPlay(new Error('old request aborted'))
  await Promise.resolve()
  await Promise.resolve()
  expect(errors).toEqual([])
  expect(instances[0].pauses).toBeGreaterThan(0)

  releasePreload()
  engine.release()
})

test('ignores an aborted play after the user pauses the same note', async () => {
  instances.length = 0
  const errors: unknown[] = []
  const engine = createVoicePlaybackEngine({
    onProgress: () => {}, onEnded: () => {}, onError: (error) => errors.push(error),
  })
  engine.load('/note')
  let rejectPlay: (error: Error) => void = () => {}
  instances[0].playPromise = new Promise<void>((_, reject) => { rejectPlay = reject })
  engine.play()
  engine.pause()
  rejectPlay(new Error('play interrupted by pause'))
  await Promise.resolve()
  await Promise.resolve()
  expect(errors).toEqual([])
  engine.release()
})
