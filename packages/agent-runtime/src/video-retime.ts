// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Video retiming for `read_file` (#2268).
 *
 * Every video path we route to except Google's native API samples a clip at
 * **1 frame per second of duration**. A 33 s / 20 fps clip therefore reaches
 * the model as 33 frames, and a QA agent signed off a clip with a 10.7 s
 * frozen tail because the frozen seconds were never sampled.
 *
 * There is no rate setting on those paths, so the only way to show the model
 * more frames is to hand it a clip that already *is* one frame per second:
 * extract the frames the caller asked for at `fps`, then re-encode each one as
 * one second of video. A 100-frame extraction becomes a 100 s clip and the
 * provider's 1 fps sampling returns all 100 frames (measured 100/100 on
 * Gemini 4 and GLM 5.3 Flash in the issue).
 *
 * Two documented dead ends, both avoided here: `setpts=PTS*n`, which keeps
 * every source frame and merely relabels the timestamps (the provider then
 * samples that at 1 fps and lands right back on 1 frame per second), and
 * encoding each part separately, which loses the frames at every part
 * boundary.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { delimiter, extname, join } from 'node:path'
import { readMp4Probe, type VideoProbe } from './mp4-probe'

/**
 * How many video tokens one `read_file` may spend. Gemini 4 charges about 73
 * tokens per frame and OpenRouter-hosted video models about 300, so this is
 * roughly 820 frames on Gemini and 200 on everything else — enough for a few
 * seconds at 24 fps, and a hard ceiling on a 10-minute clip.
 */
export const VIDEO_FRAME_TOKEN_BUDGET = 60_000

/** Scales tried in order when a retimed clip comes out over the inline cap. */
const RETIME_SCALES = [480, 360, 240] as const

/** Ceiling on a single ffmpeg run. A 660-frame retime takes a few seconds. */
const FFMPEG_TIMEOUT_MS = 180_000

export interface FfmpegPaths {
  ffmpeg: string | null
  ffprobe: string | null
}

let cachedFfmpeg: FfmpegPaths | null = null
/** Test seam: replaces the well-known install directories. `null` = use them. */
let extraBinDirsOverride: string[] | null = null

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path)
    return stat.isFile()
  } catch {
    return false
  }
}

const EXTRA_BIN_DIRS = (): string[] => [
  ...(process.env.HOMEBREW_PREFIX ? [join(process.env.HOMEBREW_PREFIX, 'bin')] : []),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  // Windows installs that do not add themselves to PATH.
  'C:\\ffmpeg\\bin',
  ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')] : []),
  ...(process.env.ProgramFiles ? [join(process.env.ProgramFiles, 'ffmpeg', 'bin')] : []),
]

function findBinary(name: string, envOverride?: string): string | null {
  if (envOverride && isExecutableFile(envOverride)) return envOverride
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
    ...(extraBinDirsOverride ?? EXTRA_BIN_DIRS()),
  ]
  for (const dir of dirs) {
    const candidate = join(dir, exe)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

/**
 * Where `ffmpeg` / `ffprobe` live on this machine.
 *
 * Cloud images ship both. A desktop may have neither, which is not an error:
 * `read_file` still sends the clip at the provider default and says so, rather
 * than refusing a video read that used to work.
 */
export function resolveFfmpeg(): FfmpegPaths {
  if (cachedFfmpeg) return cachedFfmpeg
  cachedFfmpeg = {
    ffmpeg: findBinary('ffmpeg', process.env.FFMPEG_PATH),
    ffprobe: findBinary('ffprobe', process.env.FFPROBE_PATH),
  }
  return cachedFfmpeg
}

/** Test helper: forget the cached lookup (a stub PATH is only seen once). */
export function __resetFfmpegCacheForTests(): void {
  cachedFfmpeg = null
}

/**
 * Test helper: hide the well-known install directories, so "ffmpeg is missing
 * on this machine" can be exercised on a machine that has it. `null` restores
 * the real list.
 */
export function __setExtraBinDirsForTests(dirs: string[] | null): void {
  extraBinDirsOverride = dirs
  cachedFfmpeg = null
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function runBinary(bin: string, args: string[], timeoutMs = FFMPEG_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ code: null, stdout, stderr: `${stderr}\n[timed out after ${timeoutMs} ms]` })
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 1_000_000) stdout = stdout.slice(-1_000_000)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}` })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

function parseRate(raw: string | undefined): number | null {
  if (!raw) return null
  const [num, den] = raw.split('/')
  const n = Number(num)
  const d = den === undefined ? 1 : Number(den)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n === 0) return null
  return n / d
}

/**
 * `durationSeconds` / `sourceFps` for a clip on disk, container first and
 * `ffprobe` second. `null` when neither can read it — never a guess.
 */
export async function probeVideoFile(path: string): Promise<VideoProbe | null> {
  if (extname(path).toLowerCase() !== '.webm') {
    const fromContainer = readMp4Probe(readFileSync(path))
    if (fromContainer && (fromContainer.sourceFrames !== null || fromContainer.durationSeconds > 0)) {
      return fromContainer
    }
  }
  const { ffprobe } = resolveFfmpeg()
  if (!ffprobe) return null
  const { code, stdout } = await runBinary(
    ffprobe,
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=avg_frame_rate,nb_frames,duration:format=duration',
      '-of', 'json',
      path,
    ],
    20_000,
  )
  if (code !== 0) return null
  try {
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ avg_frame_rate?: string; nb_frames?: string; duration?: string }>
      format?: { duration?: string }
    }
    const stream = parsed.streams?.[0]
    if (!stream) return null
    const duration = Number(stream.duration ?? parsed.format?.duration)
    if (!Number.isFinite(duration) || duration <= 0) return null
    const frames = Number(stream.nb_frames)
    const sourceFrames = Number.isFinite(frames) && frames > 0 ? frames : null
    const sourceFps = parseRate(stream.avg_frame_rate) ?? (sourceFrames ? sourceFrames / duration : null)
    return { durationSeconds: duration, sourceFrames, sourceFps }
  } catch {
    return null
  }
}

export interface VideoReadPlan {
  /** Rate the frames will actually be extracted at. */
  fps: number
  /** First second of the source that is sent. */
  start: number
  /** Last second of the source that is sent. */
  end: number
  /** Frames the extraction will produce, on the plan's own arithmetic. */
  frames: number
  /** What the caller asked for, when it had to be lowered. */
  requestedFps?: number
  fpsClamped: boolean
}

export interface VideoReadPlanInput {
  durationSeconds: number
  /** What the caller asked for; 1 (the provider default) when unset. */
  requestedFps?: number
  start?: number
  end?: number
  /** Model's cost per frame, from the catalog. */
  tokensPerFrame: number
  budgetTokens?: number
}

/**
 * Decide how many frames a read can afford, and say what had to give.
 *
 * `frames × tokensPerFrame` has to fit the budget: a 30 s clip at 24 fps is
 * 720 frames, which is 216k tokens on an OpenRouter video model — a request
 * that either blows the context or gets silently truncated. So the rate is
 * lowered to fit and the caller is told it happened.
 */
export function planVideoRead(input: VideoReadPlanInput): VideoReadPlan {
  const duration = Number.isFinite(input.durationSeconds) && input.durationSeconds > 0 ? input.durationSeconds : 0
  const start = clamp(input.start ?? 0, 0, duration)
  const end = clamp(input.end ?? duration, start, duration)
  const span = Math.max(end - start, 0)
  const requestedFps = input.requestedFps !== undefined && input.requestedFps > 0 ? input.requestedFps : undefined
  const budgetTokens = input.budgetTokens ?? VIDEO_FRAME_TOKEN_BUDGET
  const tokensPerFrame = input.tokensPerFrame > 0 ? input.tokensPerFrame : 300
  const affordableFrames = Math.max(1, Math.floor(budgetTokens / tokensPerFrame))

  const wanted = requestedFps ?? 1
  const wantedFrames = Math.max(1, Math.floor(span * wanted + 1e-6))
  if (wantedFrames <= affordableFrames || span <= 0) {
    return { fps: wanted, start, end, frames: wantedFrames, fpsClamped: false }
  }
  const fps = Math.max(affordableFrames / span, 1 / 60)
  return {
    fps: roundRate(fps),
    start,
    end,
    frames: Math.max(1, Math.floor(span * fps + 1e-6)),
    requestedFps,
    fpsClamped: true,
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

/** Three decimals is plenty for a sampling rate, and keeps `fps=` readable. */
function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000
}

export interface RetimeResult {
  buffer: Buffer
  /** Frames actually delivered (verified against the extraction). */
  frames: number
  /** Scale the winning encode used, in pixels of the long side. */
  scale: number
  /** Rate the frames were extracted at — may be below the request. */
  fps: number
}

export interface RetimeOptions {
  inputPath: string
  /** Directory the frame sequence and the output are written to. */
  workDir: string
  fps: number
  start?: number
  end?: number
  /** Raw-byte ceiling; the encode steps down scale (then fps) to fit. */
  maxBytes: number
  scale?: number
}

export class RetimeError extends Error {}

function frameCount(pattern: string, dir: string): number {
  try {
    return readdirSync(dir).filter((name) => name.startsWith(pattern)).length
  } catch {
    return 0
  }
}

/**
 * Extract `fps` frames per second over [start, end] and re-encode each one as
 * one second of video, stepping the scale down (then the rate) until the
 * result fits `maxBytes`.
 *
 * A run whose delivered frame count does not match the extraction is a
 * `RetimeError`, never a short clip: a silently-truncated clip is exactly the
 * failure this replaces.
 */
export async function retimeVideo(options: RetimeOptions): Promise<RetimeResult> {
  const { ffmpeg } = resolveFfmpeg()
  if (!ffmpeg) throw new RetimeError('ffmpeg is not available on this machine')

  const fpsSteps = rateSteps(options.fps)
  const scaleSteps = options.scale ? [options.scale] : [...RETIME_SCALES]
  let lastError: string | null = null

  // Scale is given up before rate: the caller asked for a sampling density, and
  // a smaller frame is far less damaging than a sparser one. So every size is
  // tried at the requested rate first, and only then does the rate halve.
  for (const fps of fpsSteps) {
    for (const scale of scaleSteps) {
      const runDir = join(options.workDir, `retime-${fps}-${scale}`)
      rmSync(runDir, { recursive: true, force: true })
      mkdirSync(runDir, { recursive: true })
      try {
        const extractArgs = ['-hide_banner', '-loglevel', 'error', '-y']
        if (options.start !== undefined && options.start > 0) extractArgs.push('-ss', String(options.start))
        extractArgs.push('-i', options.inputPath)
        if (options.end !== undefined) {
          const span = Math.max((options.end ?? 0) - (options.start ?? 0), 1 / 60)
          extractArgs.push('-t', String(roundRate(span)))
        }
        extractArgs.push(
          '-vf', `fps=${fps},scale=-2:${scale}`,
          '-an',
          '-f', 'image2',
          join(runDir, 'f%06d.png'),
        )
        const extract = await runBinary(ffmpeg, extractArgs)
        if (extract.code !== 0) {
          lastError = `frame extraction failed: ${extract.stderr.trim()}`
          continue
        }
        const extracted = frameCount('f', runDir)
        if (extracted === 0) {
          lastError = 'frame extraction produced no frames'
          continue
        }

        const outPath = join(runDir, 'retimed.mp4')
        const encode = await runBinary(ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-framerate', '1',
          '-i', join(runDir, 'f%06d.png'),
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-an',
          outPath,
        ])
        if (encode.code !== 0) {
          lastError = `re-encode failed: ${encode.stderr.trim()}`
          continue
        }

        const buffer = readFileSync(outPath)
        const delivered = readMp4Probe(buffer)?.sourceFrames ?? null
        if (delivered !== extracted) {
          lastError = `frame count mismatch: extracted ${extracted}, delivered ${delivered ?? 'unknown'}`
          continue
        }
        if (buffer.byteLength > options.maxBytes) {
          lastError = `retimed clip is ${buffer.byteLength} bytes, over the ${options.maxBytes}-byte cap`
          continue
        }
        return { buffer, frames: extracted, scale, fps }
      } finally {
        rmSync(runDir, { recursive: true, force: true })
      }
    }
  }
  throw new RetimeError(lastError ?? 'retiming produced no usable clip')
}

/** Rate steps to try: the request, then halves down to 1 fps. */
function rateSteps(fps: number): number[] {
  const steps: number[] = []
  let rate = fps
  while (rate >= 1 && steps.length < 6) {
    steps.push(roundRate(rate))
    rate = rate / 2
  }
  if (steps.length === 0) steps.push(1)
  return steps
}
