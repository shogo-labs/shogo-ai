// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { expect, mock, test } from 'bun:test'

let finishSession: (() => void) | undefined
const session = new Promise<void>((resolve) => { finishSession = resolve })
let statusListener: ((status: { error?: string; currentTime: number; duration: number; didJustFinish: boolean }) => void) | undefined
const calls = { plays: 0, pauses: 0 }

mock.module('expo-audio', () => ({
  setAudioModeAsync: () => session,
  createAudioPlayer: () => ({
    addListener: (_event: string, listener: typeof statusListener) => {
      statusListener = listener
      return { remove: () => {} }
    },
    replace: () => {},
    play: () => { calls.plays += 1 },
    pause: () => { calls.pauses += 1 },
    seekTo: async () => {},
    setPlaybackRate: () => {},
    remove: () => {},
  }),
}))

const { createVoicePlaybackEngine } = await import('../voice-playback-engine')

test('a pending audio session cannot start playback after pause, and decoder errors reach the caller', async () => {
  const errors: unknown[] = []
  const engine = createVoicePlaybackEngine({
    onProgress: () => {},
    onEnded: () => {},
    onError: (error) => errors.push(error),
  })

  engine.load('https://api.test/clip.m4a')
  engine.play()
  engine.pause()
  finishSession?.()
  await session
  await Promise.resolve()
  expect(calls.plays).toBe(0)
  expect(calls.pauses).toBe(1)

  engine.play()
  await Promise.resolve()
  expect(calls.plays).toBe(1)

  statusListener?.({ error: 'Decoder failed', currentTime: 0, duration: 0, didJustFinish: false })
  expect(errors).toHaveLength(1)
  expect(errors[0]).toBeInstanceOf(Error)
})
