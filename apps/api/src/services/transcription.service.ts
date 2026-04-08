// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { execSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'

export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

export interface TranscriptionResult {
  text: string
  segments: TranscriptSegment[]
  language: string
  duration: number
}

function whichSync(cmd: string): string | null {
  try {
    return execSync(`which ${cmd}`, { encoding: 'utf-8' }).trim() || null
  } catch {
    return null
  }
}

function getWhisperBinaryPath(): string | null {
  const candidates = [
    // Dev: apps/desktop/resources/whisper/whisper-cli (cwd = monorepo root)
    resolve(process.cwd(), 'apps', 'desktop', 'resources', 'whisper', 'whisper-cli'),
    // Packaged: resources/whisper/whisper-cli
    join(process.resourcesPath || '', 'whisper', 'whisper-cli'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  // System PATH fallback (e.g. brew install whisper-cpp)
  return whichSync('whisper-cli')
}

function getWhisperModelPath(model: string): string | null {
  const filename = `ggml-${model}.bin`
  const candidates = [
    // User data dir (runtime-downloaded models)
    join(process.env.SHOGO_DATA_DIR || '', 'whisper-models', filename),
    // Dev: apps/desktop/resources/whisper/models/ (cwd = monorepo root)
    resolve(process.cwd(), 'apps', 'desktop', 'resources', 'whisper', 'models', filename),
    // Packaged
    join(process.resourcesPath || '', 'whisper', 'models', filename),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export async function transcribeLocal(
  audioPath: string,
  model: string = 'base.en',
  language?: string,
): Promise<TranscriptionResult> {
  const whisperPath = getWhisperBinaryPath()
  if (!whisperPath) {
    throw new Error('whisper-cli binary not found. Run download-whisper to install it.')
  }

  const modelPath = getWhisperModelPath(model)
  if (!modelPath) {
    throw new Error(`Whisper model "${model}" not found. Run download-whisper --model ${model}`)
  }

  const outputBase = audioPath.replace(/\.[^.]+$/, '')

  const args = [
    '-m', modelPath,
    '-f', audioPath,
    '-oj',  // output JSON
    '-of', outputBase,
    '--no-prints',
  ]

  if (language) {
    args.push('-l', language)
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(whisperPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000, // 10 minute timeout
    })

    let stderr = ''
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to run whisper: ${err.message}`))
    })

    proc.on('exit', async (code) => {
      if (code !== 0) {
        reject(new Error(`whisper exited with code ${code}: ${stderr}`))
        return
      }

      try {
        const jsonPath = `${outputBase}.json`
        if (!existsSync(jsonPath)) {
          reject(new Error(`Whisper output not found at ${jsonPath}`))
          return
        }

        const raw = await readFile(jsonPath, 'utf-8')
        const result = JSON.parse(raw)

        const segments: TranscriptSegment[] = (result.transcription || []).map((seg: any) => ({
          start: parseTimestamp(seg.timestamps?.from || '00:00:00'),
          end: parseTimestamp(seg.timestamps?.to || '00:00:00'),
          text: (seg.text || '').trim(),
        }))

        const fullText = segments.map((s) => s.text).join(' ')
        const duration = segments.length > 0 ? segments[segments.length - 1].end : 0

        resolve({
          text: fullText,
          segments,
          language: result.result?.language || language || 'en',
          duration,
        })
      } catch (err) {
        reject(new Error(`Failed to parse whisper output: ${err}`))
      }
    })
  })
}

function parseTimestamp(ts: string): number {
  // Format: "HH:MM:SS.mmm" or "HH:MM:SS,mmm"
  const parts = ts.replace(',', '.').split(':')
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2])
  }
  return 0
}

export async function transcribeCloud(
  audioPath: string,
  language?: string,
): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY
  const proxyUrl = process.env.AI_PROXY_URL
  const proxyToken = process.env.AI_PROXY_TOKEN

  const baseUrl = proxyUrl || 'https://api.openai.com'
  const authHeader = proxyToken
    ? `Bearer ${proxyToken}`
    : apiKey
      ? `Bearer ${apiKey}`
      : null

  if (!authHeader) {
    throw new Error('No OpenAI API key or proxy configured for cloud transcription')
  }

  const audioBuffer = await readFile(audioPath)
  const ext = audioPath.split('.').pop() || 'wav'
  const mimeMap: Record<string, string> = {
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
    webm: 'audio/webm', mp4: 'audio/mp4', ogg: 'audio/ogg',
  }

  const formData = new FormData()
  formData.append('file', new Blob([audioBuffer], { type: mimeMap[ext] || 'audio/wav' }), `audio.${ext}`)
  formData.append('model', 'whisper-1')
  formData.append('response_format', 'verbose_json')
  if (language) formData.append('language', language)

  const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: authHeader },
    body: formData,
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`OpenAI Whisper API error: ${response.status} ${err}`)
  }

  const result: any = await response.json()

  const segments: TranscriptSegment[] = (result.segments || []).map((seg: any) => ({
    start: seg.start || 0,
    end: seg.end || 0,
    text: (seg.text || '').trim(),
  }))

  return {
    text: result.text || '',
    segments,
    language: result.language || language || 'en',
    duration: result.duration || 0,
  }
}

export async function transcribe(
  audioPath: string,
  options: {
    model?: string
    language?: string
    preferLocal?: boolean
  } = {},
): Promise<TranscriptionResult> {
  const { model = 'base.en', language, preferLocal = true } = options

  if (preferLocal) {
    const whisperPath = getWhisperBinaryPath()
    const modelPath = getWhisperModelPath(model)

    if (whisperPath && modelPath) {
      try {
        return await transcribeLocal(audioPath, model, language)
      } catch (err) {
        console.error('[Transcription] Local transcription failed, trying cloud:', err)
      }
    }
  }

  return transcribeCloud(audioPath, language)
}

export function isLocalTranscriptionAvailable(model: string = 'base.en'): boolean {
  return !!getWhisperBinaryPath() && !!getWhisperModelPath(model)
}
