// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let existingPaths = new Set<string>()
let spawnPlan: {
  code?: number
  stdout?: string
  stderr?: string
  error?: Error
} = {}
const spawnCalls: any[] = []
let readFileResult = Buffer.from('fake audio')

mock.module('fs', () => ({
  existsSync: (path: string) => existingPaths.has(path),
}))

mock.module('fs/promises', () => ({
  readFile: mock(async () => readFileResult),
}))

mock.module('child_process', () => ({
  spawn: mock((binaryPath: string, args: string[], options: any) => {
    spawnCalls.push({ binaryPath, args, options })
    const proc: any = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    setTimeout(() => {
      if (spawnPlan.error) {
        proc.emit('error', spawnPlan.error)
        return
      }
      if (spawnPlan.stdout) proc.stdout.emit('data', Buffer.from(spawnPlan.stdout))
      if (spawnPlan.stderr) proc.stderr.emit('data', Buffer.from(spawnPlan.stderr))
      proc.emit('exit', spawnPlan.code ?? 0)
    }, 0)
    return proc
  }),
}))

const {
  getSherpaLibDir,
  getSherpaOfflinePath,
  getWhisperModelDir,
  transcribe,
  transcribeCloud,
  transcribeLocal,
} = await import('../services/transcription.service')

const ENV_KEYS = ['SHOGO_SHERPA_DIR', 'OPENAI_API_KEY', 'AI_PROXY_URL', 'AI_PROXY_TOKEN'] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.SHOGO_SHERPA_DIR = '/tmp/sherpa'
  existingPaths = new Set<string>()
  spawnPlan = {}
  spawnCalls.length = 0
  readFileResult = Buffer.from('fake audio')
  delete (globalThis as any).fetch
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  delete (globalThis as any).fetch
})

function installSherpa(model = 'base.en') {
  existingPaths.add('/tmp/sherpa/bin/sherpa-onnx-offline')
  existingPaths.add(`/tmp/sherpa/models/whisper-${model}/${model}-encoder.onnx`)
  existingPaths.add(`/tmp/sherpa/models/whisper-${model}/${model}-decoder.onnx`)
  existingPaths.add(`/tmp/sherpa/models/whisper-${model}/${model}-tokens.txt`)
}

describe('transcription path helpers', () => {
  test('resolves lib dir and installed whisper model from SHOGO_SHERPA_DIR', () => {
    installSherpa('small.en')

    expect(getSherpaOfflinePath()).toBe('/tmp/sherpa/bin/sherpa-onnx-offline')
    expect(getSherpaLibDir()).toBe('/tmp/sherpa/lib')
    expect(getWhisperModelDir('small.en')).toBe('/tmp/sherpa/models/whisper-small.en')
  })
})

describe('transcribeLocal', () => {
  test('runs sherpa and parses token timestamps plus duration', async () => {
    installSherpa()
    spawnPlan.stdout = [
      'loading model',
      JSON.stringify({
        text: ' hello world ',
        tokens: ['hello', 'world'],
        timestamps: [0, 1.25],
        lang: 'en',
      }),
      'Real time factor = 0.1 / 2.5 = 0.04',
    ].join('\n')

    const result = await transcribeLocal('/audio/input.wav')

    expect(spawnCalls[0].binaryPath).toBe('/tmp/sherpa/bin/sherpa-onnx-offline')
    expect(spawnCalls[0].args).toContain('/audio/input.wav')
    expect(spawnCalls[0].args).toContain('--num-threads=4')
    expect(spawnCalls[0].options.env.DYLD_LIBRARY_PATH).toContain('/tmp/sherpa/lib')
    expect(result).toEqual({
      text: 'hello world',
      language: 'en',
      duration: 2.5,
      segments: [
        { start: 0, end: 1.25, text: 'hello' },
        { start: 1.25, end: 1.75, text: 'world' },
      ],
    })
  })

  test('creates a single full-text segment when tokens and timestamps are absent', async () => {
    installSherpa()
    spawnPlan.stdout = JSON.stringify({ text: 'just text' })

    const result = await transcribeLocal('/audio/input.wav')

    expect(result).toEqual({
      text: 'just text',
      language: 'en',
      duration: 0,
      segments: [{ start: 0, end: 0, text: 'just text' }],
    })
  })

  test('throws when model files are missing', async () => {
    existingPaths.add('/tmp/sherpa/bin/sherpa-onnx-offline')

    await expect(transcribeLocal('/audio/input.wav')).rejects.toThrow('Whisper ONNX model')
  })

  test('surfaces spawn errors, non-zero exits, and parse failures', async () => {
    installSherpa()
    spawnPlan.error = new Error('spawn failed')
    await expect(transcribeLocal('/audio/input.wav')).rejects.toThrow('Failed to run sherpa-onnx-offline')

    spawnPlan = { code: 2, stderr: 'bad stderr' }
    await expect(transcribeLocal('/audio/input.wav')).rejects.toThrow('exited with code 2: bad stderr')

    spawnPlan = { stdout: 'not json' }
    await expect(transcribeLocal('/audio/input.wav')).rejects.toThrow('No JSON output found')
  })
})

describe('transcribeCloud and transcribe orchestrator', () => {
  test('uses OpenAI API key, default base URL, mime fallback, and response defaults', async () => {
    process.env.OPENAI_API_KEY = 'openai-key'
    const calls: any[] = []
    globalThis.fetch = (async (url: string, init: any) => {
      calls.push({ url, init })
      return Response.json({})
    }) as any

    const result = await transcribeCloud('/audio/input.unknown')

    expect(calls[0].url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(calls[0].init.headers.Authorization).toBe('Bearer openai-key')
    expect(result).toEqual({ text: '', segments: [], language: 'en', duration: 0 })
  })

  test('falls back to cloud when local transcription fails', async () => {
    installSherpa()
    spawnPlan = { code: 1, stderr: 'local failed' }
    process.env.AI_PROXY_URL = 'https://proxy.example'
    process.env.AI_PROXY_TOKEN = 'proxy-token'
    globalThis.fetch = (async () => Response.json({
      text: 'cloud text',
      language: 'en',
      duration: 3,
      segments: [],
    })) as any

    const result = await transcribe('/audio/input.wav', { preferLocal: true })

    expect(result.text).toBe('cloud text')
  })

  test('skips local lookup when preferLocal is false', async () => {
    process.env.AI_PROXY_URL = 'https://proxy.example'
    process.env.AI_PROXY_TOKEN = 'proxy-token'
    globalThis.fetch = (async () => Response.json({ text: 'cloud only' })) as any

    const result = await transcribe('/audio/input.wav', { preferLocal: false, language: 'fr' })

    expect(result.text).toBe('cloud only')
    expect(spawnCalls).toEqual([])
  })
})
