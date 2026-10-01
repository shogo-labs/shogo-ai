// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'

let localAvailable = false
let diarizationAvailable = false
let shouldFail = false
let scriptExists = true
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
const realFs = await import('fs')
mock.module('fs', () => ({
  ...realFs,
  existsSync: (path: string) => (path.endsWith('download-sherpa.mjs') ? scriptExists : realFs.existsSync(path)),
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
  scriptExists = true
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

  test('queues a different model behind the running install instead of sharing it', async () => {
    const base = installer.ensureTranscriptionEngine('base.en')
    const small = installer.ensureTranscriptionEngine('small.en')

    expect(small).not.toBe(base)
    expect(installer.getTranscriptionInstallStatus().state).toBe('installing')
    await Promise.all([base, small])
    expect(spawnCalls.map((call) => call.args[call.args.indexOf('--model') + 1])).toEqual(['base.en', 'small.en'])
    expect(installer.getTranscriptionInstallStatus()).toMatchObject({ state: 'ready', model: 'small.en' })
  })

  test('fails without spawning when the installer script is missing', async () => {
    scriptExists = false
    await expect(installer.ensureTranscriptionEngine('base.en')).rejects.toThrow(/download-sherpa\.mjs not found/)
    expect(spawnCalls).toHaveLength(0)
    expect(installer.getTranscriptionInstallStatus().state).toBe('failed')
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
