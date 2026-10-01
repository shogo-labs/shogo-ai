// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'

let localAvailable = false
let diarizationAvailable = false
let shouldFail = false
let spawnCalls: Array<{ command: string; args: string[] }> = []

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
}

mock.module('../transcription.service', () => ({
  getSherpaOfflinePath: mock(() => (localAvailable ? '/tmp/sherpa' : null)),
  isLocalTranscriptionAvailable: mock(() => localAvailable),
}))
mock.module('../diarization.service', () => ({
  isDiarizationAvailable: mock(() => diarizationAvailable),
}))
mock.module('child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawnCalls.push({ command, args })
    const child = new FakeProcess()
    queueMicrotask(() => child.emit('exit', shouldFail ? 1 : 0))
    return child
  },
}))

const installer = await import('../transcription-install.service')
const realDateNow = Date.now

beforeEach(() => {
  localAvailable = false
  diarizationAvailable = false
  shouldFail = false
  spawnCalls = []
  installer.resetTranscriptionInstallState()
})

afterEach(() => {
  Date.now = realDateNow
})

describe('transcription installer', () => {
  test('shares one in-flight install between concurrent callers', async () => {
    const first = installer.ensureTranscriptionEngine('base.en')
    const second = installer.ensureTranscriptionEngine('base.en')

    expect(first).toBe(second)
    await first
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]?.args).toContain('base.en')
    expect(installer.getTranscriptionInstallStatus().state).toBe('ready')
  })

  test('records failures and retries after the backoff', async () => {
    let now = 10_000
    Date.now = () => now
    shouldFail = true

    await expect(installer.ensureTranscriptionEngine()).rejects.toThrow(/exited with code 1/)
    expect(installer.getTranscriptionInstallStatus().state).toBe('failed')

    now += 5_001
    shouldFail = false
    await installer.ensureTranscriptionEngine()
    expect(spawnCalls).toHaveLength(2)
    expect(installer.getTranscriptionInstallStatus().state).toBe('ready')
  })

  test('does not download when all assets are already available', async () => {
    localAvailable = true
    diarizationAvailable = true

    await installer.ensureTranscriptionEngine()

    expect(spawnCalls).toHaveLength(0)
    expect(installer.getTranscriptionInstallStatus().state).toBe('ready')
  })
})
