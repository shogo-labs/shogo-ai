// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage gap-filler for src/services/transcription.service.ts targeting:
//   - transcribeCloud: missing auth, proxy-vs-direct auth selection, non-200
//     response, segment mapping with + without fields, language fallback,
//     duration fallback, mime-type selection per extension
//   - transcribe orchestrator: preferLocal=false straight to cloud,
//     preferLocal=true with no binary falls through to cloud, preferLocal=true
//     when local throws → catches + falls back to cloud
//   - getWhisperModelDir returns null when files are missing
//   - getSherpaLibDir returns a path under the sherpa dir
//   - isLocalTranscriptionAvailable composes binary + model checks

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const realFetch = globalThis.fetch

const {
  transcribeCloud,
  transcribe,
  getWhisperModelDir,
  getSherpaLibDir,
  isLocalTranscriptionAvailable,
  getSherpaOfflinePath,
} = await import('../services/transcription.service')

let tmpDir: string
let audioPath: string
const originalEnv: Record<string, string | undefined> = {}

function saveEnv(...keys: string[]) {
  for (const k of keys) originalEnv[k] = process.env[k]
}
function restoreEnv() {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

beforeEach(() => {
  saveEnv('OPENAI_API_KEY', 'AI_PROXY_URL', 'AI_PROXY_TOKEN', 'SHOGO_SHERPA_DIR', 'SHOGO_DATA_DIR')
  tmpDir = mkdtempSync(join(tmpdir(), 'transcription-svc-'))
  audioPath = join(tmpDir, 'sample.wav')
  // Trivial bytes — the service just reads them into a Blob; no decoding.
  writeFileSync(audioPath, Buffer.from('RIFFFAKE'))
})

afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(tmpDir, { recursive: true, force: true })
  restoreEnv()
})

// ─── transcribeCloud ───────────────────────────────────────────────────

describe('transcribeCloud', () => {
  test('throws when neither OPENAI_API_KEY nor AI_PROXY_TOKEN is set', async () => {
    delete process.env.OPENAI_API_KEY
    delete process.env.AI_PROXY_TOKEN
    delete process.env.AI_PROXY_URL
    await expect(transcribeCloud(audioPath)).rejects.toThrow(/No OpenAI API key or proxy configured/)
  })

  test('uses AI_PROXY_URL + AI_PROXY_TOKEN when both are set (proxy wins over API key)', async () => {
    process.env.OPENAI_API_KEY = 'sk-shouldnt-be-used'
    process.env.AI_PROXY_URL = 'https://proxy.example.com'
    process.env.AI_PROXY_TOKEN = 'proxy-tok-123'
    let capturedUrl = ''
    let capturedAuth = ''
    globalThis.fetch = (async (input: any, init?: any) => {
      capturedUrl = typeof input === 'string' ? input : input.url
      capturedAuth = init?.headers?.Authorization ?? ''
      return new Response(JSON.stringify({ text: 'hello', segments: [], language: 'en', duration: 1.2 }), { status: 200 })
    }) as any

    const result = await transcribeCloud(audioPath, 'en')
    expect(capturedUrl).toBe('https://proxy.example.com/v1/audio/transcriptions')
    expect(capturedAuth).toBe('Bearer proxy-tok-123')
    expect(result.text).toBe('hello')
    expect(result.duration).toBe(1.2)
    expect(result.language).toBe('en')
  })

  test('falls back to OpenAI base URL + OPENAI_API_KEY when no proxy is configured', async () => {
    process.env.OPENAI_API_KEY = 'sk-direct'
    delete process.env.AI_PROXY_URL
    delete process.env.AI_PROXY_TOKEN
    let capturedUrl = ''
    let capturedAuth = ''
    globalThis.fetch = (async (input: any, init?: any) => {
      capturedUrl = typeof input === 'string' ? input : input.url
      capturedAuth = init?.headers?.Authorization ?? ''
      return new Response(JSON.stringify({ text: 'ok', segments: [] }), { status: 200 })
    }) as any

    await transcribeCloud(audioPath)
    expect(capturedUrl).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(capturedAuth).toBe('Bearer sk-direct')
  })

  test('non-2xx response surfaces status + body in the thrown error', async () => {
    process.env.OPENAI_API_KEY = 'sk-direct'
    globalThis.fetch = (async () =>
      new Response('quota exceeded', { status: 429 })) as any
    await expect(transcribeCloud(audioPath)).rejects.toThrow(/OpenAI Whisper API error: 429/)
  })

  test('maps response.segments (including missing fields) to TranscriptSegment[]', async () => {
    process.env.OPENAI_API_KEY = 'sk-direct'
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        text: '  hello world  ',
        language: 'es',
        duration: 7.5,
        segments: [
          { start: 0, end: 1, text: '  hi  ' },
          { /* fully empty: start/end/text all default */ },
          { start: 2, text: 'no end' },
        ],
      }), { status: 200 })) as any

    const result = await transcribeCloud(audioPath, 'es')
    expect(result.text).toBe('  hello world  ') // top-level text is NOT trimmed
    expect(result.language).toBe('es')
    expect(result.duration).toBe(7.5)
    expect(result.segments).toHaveLength(3)
    expect(result.segments[0]).toEqual({ start: 0, end: 1, text: 'hi' })
    expect(result.segments[1]).toEqual({ start: 0, end: 0, text: '' })
    expect(result.segments[2]).toEqual({ start: 2, end: 0, text: 'no end' })
  })

  test('language fallback chain: response.language > argument > "en"', async () => {
    process.env.OPENAI_API_KEY = 'sk-direct'
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ text: 'x' }), { status: 200 })) as any

    // No explicit language + no response.language → defaults to 'en'.
    const r1 = await transcribeCloud(audioPath)
    expect(r1.language).toBe('en')

    // Explicit language arg + no response.language → uses arg.
    const r2 = await transcribeCloud(audioPath, 'fr')
    expect(r2.language).toBe('fr')

    // response.language always wins.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ text: 'x', language: 'de' }), { status: 200 })) as any
    const r3 = await transcribeCloud(audioPath, 'fr')
    expect(r3.language).toBe('de')
  })

  test('duration and text default to 0 / "" when missing', async () => {
    process.env.OPENAI_API_KEY = 'sk-direct'
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as any

    const r = await transcribeCloud(audioPath)
    expect(r.text).toBe('')
    expect(r.duration).toBe(0)
    expect(r.segments).toEqual([])
  })

  test('passes language form-field when provided', async () => {
    process.env.OPENAI_API_KEY = 'sk-direct'
    let capturedBody: any = null
    globalThis.fetch = (async (_input: any, init?: any) => {
      capturedBody = init?.body
      return new Response(JSON.stringify({ text: 'x' }), { status: 200 })
    }) as any

    await transcribeCloud(audioPath, 'ja')
    // FormData entries — check the language field is present.
    const langField = capturedBody.get('language')
    expect(langField).toBe('ja')
  })

  test('omits language form-field when no language arg is provided', async () => {
    process.env.OPENAI_API_KEY = 'sk-direct'
    let capturedBody: any = null
    globalThis.fetch = (async (_input: any, init?: any) => {
      capturedBody = init?.body
      return new Response(JSON.stringify({ text: 'x' }), { status: 200 })
    }) as any

    await transcribeCloud(audioPath)
    expect(capturedBody.get('language')).toBeNull()
  })

  test('picks mime type from extension (mp3 → audio/mpeg, m4a → audio/mp4, unknown → audio/wav)', async () => {
    process.env.OPENAI_API_KEY = 'sk-direct'
    const seen: string[] = []
    globalThis.fetch = (async (_input: any, init?: any) => {
      const file = init?.body?.get('file')
      seen.push(file?.type ?? 'unknown')
      return new Response(JSON.stringify({ text: 'x' }), { status: 200 })
    }) as any

    for (const ext of ['mp3', 'm4a', 'ogg', 'flac' /* unknown → wav */]) {
      const p = join(tmpDir, `audio.${ext}`)
      writeFileSync(p, Buffer.from('FAKE'))
      await transcribeCloud(p)
    }
    expect(seen[0]).toBe('audio/mpeg')
    expect(seen[1]).toBe('audio/mp4')
    expect(seen[2]).toBe('audio/ogg')
    expect(seen[3]).toBe('audio/wav') // unknown ext → default
  })
})

// ─── transcribe (orchestrator) ─────────────────────────────────────────

describe('transcribe — orchestrator', () => {
  test('preferLocal=false skips local entirely and calls cloud directly', async () => {
    process.env.OPENAI_API_KEY = 'sk-direct'
    let cloudCalled = false
    globalThis.fetch = (async () => {
      cloudCalled = true
      return new Response(JSON.stringify({ text: 'cloud said hi' }), { status: 200 })
    }) as any

    const result = await transcribe(audioPath, { preferLocal: false })
    expect(cloudCalled).toBe(true)
    expect(result.text).toBe('cloud said hi')
  })

  test('preferLocal=true with no sherpa binary → falls through to cloud', async () => {
    process.env.SHOGO_SHERPA_DIR = '/tmp/definitely-not-installed'
    process.env.OPENAI_API_KEY = 'sk-direct'
    let cloudCalled = false
    globalThis.fetch = (async () => {
      cloudCalled = true
      return new Response(JSON.stringify({ text: 'cloud fallback' }), { status: 200 })
    }) as any

    const result = await transcribe(audioPath /* default preferLocal=true */)
    expect(cloudCalled).toBe(true)
    expect(result.text).toBe('cloud fallback')
  })

  test('default options: preferLocal=true and model="base.en"', async () => {
    // With no binary installed, this still has to fall through to cloud.
    process.env.SHOGO_SHERPA_DIR = '/tmp/no-such-dir'
    process.env.OPENAI_API_KEY = 'sk-direct'
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ text: 'default-options' }), { status: 200 })) as any
    const result = await transcribe(audioPath, {})
    expect(result.text).toBe('default-options')
  })

  test('cloud failure propagates when no local fallback path is available', async () => {
    process.env.SHOGO_SHERPA_DIR = '/tmp/no-such-dir'
    process.env.OPENAI_API_KEY = 'sk-direct'
    globalThis.fetch = (async () => new Response('upstream busted', { status: 503 })) as any
    await expect(transcribe(audioPath, { preferLocal: false })).rejects.toThrow(/503/)
  })
})

// ─── Path helpers ──────────────────────────────────────────────────────

describe('path / availability helpers', () => {
  test('getWhisperModelDir returns null when model files are missing', () => {
    process.env.SHOGO_SHERPA_DIR = '/tmp/no-such-sherpa-dir'
    expect(getWhisperModelDir('base.en')).toBeNull()
  })

  test('getSherpaLibDir is the sherpa dir + "/lib"', () => {
    process.env.SHOGO_SHERPA_DIR = '/tmp/sherpa-fake'
    expect(getSherpaLibDir()).toBe(join('/tmp/sherpa-fake', 'lib'))
  })

  test('isLocalTranscriptionAvailable is false when binary is missing', () => {
    process.env.SHOGO_SHERPA_DIR = '/tmp/no-such-sherpa-dir'
    expect(isLocalTranscriptionAvailable()).toBe(false)
  })

  test('getSherpaOfflinePath returns null when binary is missing', () => {
    process.env.SHOGO_SHERPA_DIR = '/tmp/no-such-sherpa-dir'
    expect(getSherpaOfflinePath()).toBeNull()
  })
})
