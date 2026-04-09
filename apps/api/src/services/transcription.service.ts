// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'

export interface TranscriptSegment {
  start: number
  end: number
  text: string
  speaker?: string
}

export interface TranscriptionResult {
  text: string
  segments: TranscriptSegment[]
  language: string
  duration: number
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function getSherpaDir(): string {
  const candidates = [
    resolve(process.cwd(), 'apps', 'desktop', 'resources', 'sherpa-onnx'),
    join(process.resourcesPath || '', 'sherpa-onnx'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'bin', 'sherpa-onnx-offline'))) return dir
  }
  return candidates[0]
}

export function getSherpaOfflinePath(): string | null {
  const dir = getSherpaDir()
  const binPath = join(dir, 'bin', 'sherpa-onnx-offline')
  return existsSync(binPath) ? binPath : null
}

export function getSherpaLibDir(): string {
  return join(getSherpaDir(), 'lib')
}

export function getWhisperModelDir(model: string = 'base.en'): string | null {
  const dir = getSherpaDir()
  const modelDir = join(dir, 'models', `whisper-${model}`)
  const prefix = model
  const encoder = join(modelDir, `${prefix}-encoder.onnx`)
  const decoder = join(modelDir, `${prefix}-decoder.onnx`)
  const tokens = join(modelDir, `${prefix}-tokens.txt`)
  if (existsSync(encoder) && existsSync(decoder) && existsSync(tokens)) return modelDir
  return null
}

export function getInstalledModels(): string[] {
  const dir = getSherpaDir()
  const modelsDir = join(dir, 'models')
  if (!existsSync(modelsDir)) return []

  const knownModels = ['tiny.en', 'base.en', 'small.en', 'medium.en', 'tiny', 'base', 'small']
  return knownModels.filter((m) => getWhisperModelDir(m) !== null)
}

// ---------------------------------------------------------------------------
// Local transcription via sherpa-onnx-offline
// ---------------------------------------------------------------------------

export async function transcribeLocal(
  audioPath: string,
  model: string = 'base.en',
): Promise<TranscriptionResult> {
  const binaryPath = getSherpaOfflinePath()
  if (!binaryPath) {
    throw new Error('sherpa-onnx-offline binary not found. Run download-sherpa to install.')
  }

  const modelDir = getWhisperModelDir(model)
  if (!modelDir) {
    throw new Error(`Whisper ONNX model "${model}" not found. Run download-sherpa --model ${model}`)
  }

  const prefix = model
  const args = [
    `--whisper-encoder=${join(modelDir, `${prefix}-encoder.onnx`)}`,
    `--whisper-decoder=${join(modelDir, `${prefix}-decoder.onnx`)}`,
    `--tokens=${join(modelDir, `${prefix}-tokens.txt`)}`,
    '--num-threads=4',
    audioPath,
  ]

  const libDir = getSherpaLibDir()
  const env = { ...process.env }
  if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = [libDir, env.DYLD_LIBRARY_PATH].filter(Boolean).join(':')
  } else {
    env.LD_LIBRARY_PATH = [libDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':')
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      timeout: 600_000,
    })

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('error', (err) => reject(new Error(`Failed to run sherpa-onnx-offline: ${err.message}`)))

    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`sherpa-onnx-offline exited with code ${code}: ${stderr.slice(-500)}`))
        return
      }

      try {
        const result = parseSherpaOutput(stdout)
        resolve(result)
      } catch (err) {
        reject(new Error(`Failed to parse sherpa-onnx output: ${err}`))
      }
    })
  })
}

function parseSherpaOutput(stdout: string): TranscriptionResult {
  const lines = stdout.trim().split('\n')
  let jsonResult: any = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        jsonResult = JSON.parse(trimmed)
        break
      } catch { /* not JSON, continue */ }
    }
  }

  if (!jsonResult) {
    throw new Error('No JSON output found in sherpa-onnx-offline stdout')
  }

  const text = (jsonResult.text || '').trim()
  const tokens: string[] = jsonResult.tokens || []
  const timestamps: number[] = jsonResult.timestamps || []

  let segments: TranscriptSegment[] = []
  if (timestamps.length > 0 && timestamps.length === tokens.length) {
    segments = tokens.map((tok: string, i: number) => ({
      start: timestamps[i],
      end: i + 1 < timestamps.length ? timestamps[i + 1] : timestamps[i] + 0.5,
      text: tok,
    }))
  } else if (text) {
    segments = [{ start: 0, end: 0, text }]
  }

  const durationMatch = stdout.match(/Real time factor.*?\/\s*([\d.]+)\s*=/)
  const duration = durationMatch ? parseFloat(durationMatch[1]) : 0

  return { text, segments, language: jsonResult.lang || 'en', duration }
}

// ---------------------------------------------------------------------------
// Cloud transcription (OpenAI Whisper API) — unchanged
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Orchestrator: local-first with cloud fallback
// ---------------------------------------------------------------------------

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
    const binPath = getSherpaOfflinePath()
    const modelDir = getWhisperModelDir(model)

    if (binPath && modelDir) {
      try {
        return await transcribeLocal(audioPath, model)
      } catch (err) {
        console.error('[Transcription] Local transcription failed, trying cloud:', err)
      }
    }
  }

  return transcribeCloud(audioPath, language)
}

export function isLocalTranscriptionAvailable(model: string = 'base.en'): boolean {
  return !!getSherpaOfflinePath() && !!getWhisperModelDir(model)
}
