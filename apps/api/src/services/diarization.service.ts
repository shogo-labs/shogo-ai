// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { execSync, spawn } from 'child_process'
import { existsSync, openSync, readSync, closeSync } from 'fs'
import { join, resolve } from 'path'
import { getSherpaLibDir, type TranscriptSegment } from './transcription.service'

export interface SpeakerSegment {
  start: number
  end: number
  speaker: string
}

export interface DiarizationResult {
  segments: SpeakerSegment[]
  numSpeakers: number
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function getSherpaDir(): string {
  const candidates = [
    process.env.SHOGO_SHERPA_DIR,
    process.env.SHOGO_DATA_DIR ? join(process.env.SHOGO_DATA_DIR, 'sherpa-onnx') : undefined,
    resolve(process.cwd(), 'apps', 'desktop', 'resources', 'sherpa-onnx'),
    join((process as any).resourcesPath || '', 'sherpa-onnx'),
  ].filter(Boolean) as string[]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'bin', 'sherpa-onnx-offline-speaker-diarization'))) return dir
  }
  return candidates[0]
}

export function getDiarizationBinaryPath(): string | null {
  const bin = join(getSherpaDir(), 'bin', 'sherpa-onnx-offline-speaker-diarization')
  return existsSync(bin) ? bin : null
}

export function getSegmentationModelPath(): string | null {
  const p = join(getSherpaDir(), 'models', 'segmentation', 'model.onnx')
  return existsSync(p) ? p : null
}

export function getEmbeddingModelPath(): string | null {
  const p = join(getSherpaDir(), 'models', 'embedding', 'nemo_en_titanet_small.onnx')
  return existsSync(p) ? p : null
}

export function isDiarizationAvailable(): boolean {
  return !!getDiarizationBinaryPath() && !!getSegmentationModelPath() && !!getEmbeddingModelPath()
}

function whichSync(cmd: string): string | null {
  try {
    return execSync(`which ${cmd}`, { encoding: 'utf-8' }).trim() || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Diarization
// ---------------------------------------------------------------------------

/**
 * Runs speaker diarization on a WAV file.
 *
 * The sherpa-onnx diarization binary requires 16 kHz mono WAV input.
 * If the input is at a higher sample rate, we resample via ffmpeg first.
 */
export async function diarize(
  audioPath: string,
  options?: { numSpeakers?: number; clusterThreshold?: number },
): Promise<DiarizationResult> {
  const binaryPath = getDiarizationBinaryPath()
  if (!binaryPath) throw new Error('sherpa-onnx-offline-speaker-diarization binary not found')

  const segModel = getSegmentationModelPath()
  const embModel = getEmbeddingModelPath()
  if (!segModel || !embModel) throw new Error('Diarization models not found')

  const wavPath = await ensureResampled(audioPath)

  const args = [
    `--segmentation.pyannote-model=${segModel}`,
    `--embedding.model=${embModel}`,
    '--segmentation.num-threads=4',
    '--embedding.num-threads=4',
  ]

  if (options?.numSpeakers && options.numSpeakers > 0) {
    args.push(`--clustering.num-clusters=${options.numSpeakers}`)
  } else {
    args.push(`--clustering.cluster-threshold=${options?.clusterThreshold ?? 0.5}`)
  }

  args.push(wavPath)

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

    proc.on('error', (err) => reject(new Error(`Diarization failed: ${err.message}`)))

    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Diarization exited with code ${code}: ${stderr.slice(-500)}`))
        return
      }

      try {
        const result = parseDiarizationOutput(stdout + stderr)
        resolve(result)
      } catch (err) {
        reject(new Error(`Failed to parse diarization output: ${err}`))
      }
    })
  })
}

/**
 * Ensures the audio file is 16 kHz mono WAV (required by the diarization binary).
 * Returns the path to the 16 kHz file (which may be a temp file).
 */
async function ensureResampled(audioPath: string): Promise<string> {
  // Quick header check: read sample rate from WAV header (just 44 bytes)
  try {
    const fd = openSync(audioPath, 'r')
    const header = Buffer.alloc(44)
    readSync(fd, header, 0, 44, 0)
    closeSync(fd)
    if (header.length >= 28) {
      const sampleRate = header.readUInt32LE(24)
      if (sampleRate === 16000) return audioPath
    }
  } catch { /* proceed to resample */ }

  if (!whichSync('ffmpeg')) {
    throw new Error('ffmpeg is required for diarization (audio resampling). Install it with: brew install ffmpeg')
  }

  const resampledPath = audioPath.replace(/\.wav$/, '-16k.wav')
  execSync(
    `ffmpeg -y -i "${audioPath}" -ar 16000 -ac 1 "${resampledPath}"`,
    { stdio: 'ignore', timeout: 60_000 },
  )
  return resampledPath
}

/**
 * Parses the diarization output format:
 * ```
 * 0.318 -- 6.865 speaker_00
 * 7.017 -- 10.747 speaker_01
 * ```
 */
function parseDiarizationOutput(output: string): DiarizationResult {
  const segmentPattern = /^([\d.]+)\s+--\s+([\d.]+)\s+(speaker_\d+)\s*$/
  const segments: SpeakerSegment[] = []
  const speakers = new Set<string>()

  for (const line of output.split('\n')) {
    const match = line.trim().match(segmentPattern)
    if (match) {
      const speaker = match[3]
      speakers.add(speaker)
      segments.push({
        start: parseFloat(match[1]),
        end: parseFloat(match[2]),
        speaker,
      })
    }
  }

  return { segments, numSpeakers: speakers.size }
}

// ---------------------------------------------------------------------------
// Merge transcript segments with speaker labels
// ---------------------------------------------------------------------------

/**
 * For each transcript segment, finds the speaker with the greatest time overlap
 * from the diarization result.
 */
export function mergeTranscriptWithSpeakers(
  textSegments: TranscriptSegment[],
  speakerSegments: SpeakerSegment[],
): TranscriptSegment[] {
  if (speakerSegments.length === 0) return textSegments

  return textSegments.map((seg) => {
    let bestSpeaker = ''
    let bestOverlap = 0

    for (const sp of speakerSegments) {
      const overlapStart = Math.max(seg.start, sp.start)
      const overlapEnd = Math.min(seg.end, sp.end)
      const overlap = Math.max(0, overlapEnd - overlapStart)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        bestSpeaker = sp.speaker
      }
    }

    return { ...seg, speaker: bestSpeaker || undefined }
  })
}

/**
 * If the transcription returns a single full-text segment (no timestamps),
 * split it into segments based on the diarization time windows.
 * Each speaker segment gets the appropriate portion of text based on time proportion.
 */
export function splitTextBySpeakers(
  fullText: string,
  speakerSegments: SpeakerSegment[],
): TranscriptSegment[] {
  if (speakerSegments.length === 0) {
    return fullText ? [{ start: 0, end: 0, text: fullText }] : []
  }

  const totalDuration = speakerSegments.reduce((max, s) => Math.max(max, s.end), 0)
  if (totalDuration === 0) return [{ start: 0, end: 0, text: fullText }]

  const words = fullText.trim().split(/\s+/)
  const totalWords = words.length
  const result: TranscriptSegment[] = []

  let wordIndex = 0
  for (const sp of speakerSegments) {
    const segDuration = sp.end - sp.start
    const proportion = segDuration / totalDuration
    const wordCount = Math.max(1, Math.round(proportion * totalWords))
    const segWords = words.slice(wordIndex, wordIndex + wordCount)
    wordIndex += wordCount

    if (segWords.length > 0) {
      result.push({
        start: sp.start,
        end: sp.end,
        text: segWords.join(' '),
        speaker: sp.speaker,
      })
    }
  }

  // Append any remaining words to the last segment
  if (wordIndex < totalWords && result.length > 0) {
    const last = result[result.length - 1]
    const remaining = words.slice(wordIndex).join(' ')
    last.text = last.text + ' ' + remaining
  }

  return result
}
