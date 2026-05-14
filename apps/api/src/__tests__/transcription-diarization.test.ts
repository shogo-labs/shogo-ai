// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getInstalledModels,
  getSherpaOfflinePath,
  getWhisperModelDir,
  isLocalTranscriptionAvailable,
  transcribeCloud,
} from '../services/transcription.service'
import {
  getDiarizationBinaryPath,
  getEmbeddingModelPath,
  getSegmentationModelPath,
  isDiarizationAvailable,
  mergeTranscriptWithSpeakers,
  splitTextBySpeakers,
} from '../services/diarization.service'

let tempDir = ''
const originalSherpaDir = process.env.SHOGO_SHERPA_DIR
const originalOpenAiKey = process.env.OPENAI_API_KEY
const originalProxyUrl = process.env.AI_PROXY_URL
const originalProxyToken = process.env.AI_PROXY_TOKEN

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'shogo-sherpa-test-'))
  process.env.SHOGO_SHERPA_DIR = tempDir
  delete process.env.OPENAI_API_KEY
  delete process.env.AI_PROXY_URL
  delete process.env.AI_PROXY_TOKEN
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  if (originalSherpaDir === undefined) delete process.env.SHOGO_SHERPA_DIR
  else process.env.SHOGO_SHERPA_DIR = originalSherpaDir
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalOpenAiKey
  if (originalProxyUrl === undefined) delete process.env.AI_PROXY_URL
  else process.env.AI_PROXY_URL = originalProxyUrl
  if (originalProxyToken === undefined) delete process.env.AI_PROXY_TOKEN
  else process.env.AI_PROXY_TOKEN = originalProxyToken
  delete (globalThis as any).fetch
})

function touch(path: string) {
  writeFileSync(path, '')
}

describe('transcription path helpers', () => {
  test('reports unavailable when sherpa files are absent', () => {
    expect(getSherpaOfflinePath()).toBeNull()
    expect(getWhisperModelDir('base.en')).toBeNull()
    expect(getInstalledModels()).toEqual([])
    expect(isLocalTranscriptionAvailable('base.en')).toBe(false)
  })

  test('detects installed binary and whisper model files', () => {
    const bin = join(tempDir, 'bin')
    const model = join(tempDir, 'models', 'whisper-base.en')
    require('fs').mkdirSync(bin, { recursive: true })
    require('fs').mkdirSync(model, { recursive: true })
    touch(join(bin, process.platform === 'win32' ? 'sherpa-onnx-offline.exe' : 'sherpa-onnx-offline'))
    touch(join(model, 'base.en-encoder.onnx'))
    touch(join(model, 'base.en-decoder.onnx'))
    touch(join(model, 'base.en-tokens.txt'))

    expect(getSherpaOfflinePath()).toContain('sherpa-onnx-offline')
    expect(getWhisperModelDir('base.en')).toBe(model)
    expect(getInstalledModels()).toContain('base.en')
    expect(isLocalTranscriptionAvailable('base.en')).toBe(true)
  })
})

describe('transcribeCloud', () => {
  test('requires an OpenAI key or proxy token', async () => {
    const audio = join(tempDir, 'audio.wav')
    writeFileSync(audio, 'fake wav')

    await expect(transcribeCloud(audio)).rejects.toThrow(/No OpenAI API key/)
  })

  test('posts audio to the proxy and maps verbose_json segments', async () => {
    const audio = join(tempDir, 'audio.mp3')
    writeFileSync(audio, 'fake mp3')
    process.env.AI_PROXY_URL = 'https://proxy.example'
    process.env.AI_PROXY_TOKEN = 'proxy-token'
    const calls: any[] = []
    globalThis.fetch = (async (url: string, init: any) => {
      calls.push({ url, init })
      return Response.json({
        text: ' hello world ',
        language: 'en',
        duration: 12,
        segments: [
          { start: 0, end: 1.2, text: ' hello ' },
          { start: 1.2, end: 2.4, text: ' world ' },
        ],
      })
    }) as any

    const result = await transcribeCloud(audio, 'en')

    expect(calls[0].url).toBe('https://proxy.example/v1/audio/transcriptions')
    expect(calls[0].init.headers.Authorization).toBe('Bearer proxy-token')
    expect(result).toEqual({
      text: ' hello world ',
      language: 'en',
      duration: 12,
      segments: [
        { start: 0, end: 1.2, text: 'hello' },
        { start: 1.2, end: 2.4, text: 'world' },
      ],
    })
  })

  test('surfaces upstream errors with status and body', async () => {
    const audio = join(tempDir, 'audio.wav')
    writeFileSync(audio, 'fake wav')
    process.env.OPENAI_API_KEY = 'openai-key'
    globalThis.fetch = (async () => new Response('bad request', { status: 400 })) as any

    await expect(transcribeCloud(audio)).rejects.toThrow(/400 bad request/)
  })
})

describe('diarization helpers', () => {
  test('detects diarization binary and models', () => {
    const bin = join(tempDir, 'bin')
    const segmentation = join(tempDir, 'models', 'segmentation')
    const embedding = join(tempDir, 'models', 'embedding')
    require('fs').mkdirSync(bin, { recursive: true })
    require('fs').mkdirSync(segmentation, { recursive: true })
    require('fs').mkdirSync(embedding, { recursive: true })
    touch(join(bin, process.platform === 'win32'
      ? 'sherpa-onnx-offline-speaker-diarization.exe'
      : 'sherpa-onnx-offline-speaker-diarization'))
    touch(join(segmentation, 'model.onnx'))
    touch(join(embedding, 'nemo_en_titanet_small.onnx'))

    expect(getDiarizationBinaryPath()).toContain('speaker-diarization')
    expect(getSegmentationModelPath()).toContain('segmentation')
    expect(getEmbeddingModelPath()).toContain('embedding')
    expect(isDiarizationAvailable()).toBe(true)
  })

  test('mergeTranscriptWithSpeakers assigns the greatest-overlap speaker', () => {
    const merged = mergeTranscriptWithSpeakers([
      { start: 0, end: 2, text: 'hello' },
      { start: 2, end: 4, text: 'there' },
      { start: 10, end: 11, text: 'alone' },
    ], [
      { start: 0, end: 1.5, speaker: 'speaker_00' },
      { start: 1.5, end: 4, speaker: 'speaker_01' },
    ])

    expect(merged).toEqual([
      { start: 0, end: 2, text: 'hello', speaker: 'speaker_00' },
      { start: 2, end: 4, text: 'there', speaker: 'speaker_01' },
      { start: 10, end: 11, text: 'alone', speaker: undefined },
    ])
  })

  test('splitTextBySpeakers distributes words by segment duration', () => {
    expect(splitTextBySpeakers('', [])).toEqual([])
    expect(splitTextBySpeakers('all words', [])).toEqual([{ start: 0, end: 0, text: 'all words' }])
    expect(splitTextBySpeakers('one two three four five', [
      { start: 0, end: 1, speaker: 'speaker_00' },
      { start: 1, end: 3, speaker: 'speaker_01' },
    ])).toEqual([
      { start: 0, end: 1, text: 'one two', speaker: 'speaker_00' },
      { start: 1, end: 3, text: 'three four five', speaker: 'speaker_01' },
    ])
    expect(splitTextBySpeakers('words', [{ start: 0, end: 0, speaker: 'speaker_00' }])).toEqual([
      { start: 0, end: 0, text: 'words' },
    ])
  })
})
