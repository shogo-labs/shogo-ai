// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Video retiming (§B, AC2 — SHO-591 / #2268).
 *
 * Every non-Google video path samples a clip at 1 frame per second of
 * duration, so `read_file` has to hand the model a clip that already is one
 * frame per second: extract the requested frames, then encode each one as one
 * second of video. The case that motivated the card is here verbatim — a 33 s
 * / 20 fps clip (660 frames) must arrive as 660 frames, not 33 — and a run
 * whose delivered count does not match the extraction must be an error rather
 * than a short clip.
 *
 * These tests drive the real ffmpeg and skip when it is not installed.
 *
 * Run: bun test packages/agent-runtime/src/__tests__/video-retime.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import {
  planVideoRead,
  probeVideoFile,
  resolveFfmpeg,
  retimeVideo,
  RetimeError,
  VIDEO_FRAME_TOKEN_BUDGET,
  __resetFfmpegCacheForTests,
  __setExtraBinDirsForTests,
} from '../video-retime'
import { readMp4Probe, readMp4VideoFrameCount, readMp4DurationSeconds } from '../mp4-probe'

const TEST_DIR = '/tmp/test-video-retime'
const CLIP = join(TEST_DIR, 'clip-33s-20fps.mp4')

const ffmpegAvailable = resolveFfmpeg().ffmpeg !== null

function ffmpeg(args: string[]): void {
  const { ffmpeg: bin } = resolveFfmpeg()
  const result = spawnSync(bin!, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  if (result.status !== 0) {
    throw new Error(`ffmpeg ${args.join(' ')} failed: ${result.stderr?.toString() ?? ''}`)
  }
}

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  if (!ffmpegAvailable) return
  // 33 s at 20 fps = 660 frames, the clip from the issue.
  ffmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=20:duration=33',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-preset', 'ultrafast',
    CLIP,
  ])
}, 120_000)

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('readMp4Probe', () => {
  test('reads duration and frame count from the container alone', () => {
    if (!ffmpegAvailable) return
    const { readFileSync } = require('fs') as typeof import('fs')
    const probe = readMp4Probe(readFileSync(CLIP))
    expect(probe).not.toBeNull()
    expect(probe!.durationSeconds).toBeCloseTo(33, 0)
    expect(probe!.sourceFrames).toBe(660)
    expect(probe!.sourceFps).toBeCloseTo(20, 0)
  })

  test('counts only the video track of a file that also has audio', () => {
    if (!ffmpegAvailable) return
    const withAudio = join(TEST_DIR, 'clip-with-audio.mp4')
    ffmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      withAudio,
    ])
    const { readFileSync } = require('fs') as typeof import('fs')
    const buffer = readFileSync(withAudio)
    // The audio track's stsz holds audio packets, not frames — picking the
    // first stsz would report ~170 for a 40-frame video.
    expect(readMp4VideoFrameCount(buffer)).toBe(40)
    expect(readMp4DurationSeconds(buffer)).toBeCloseTo(4, 0)
  }, 60_000)

  test('returns null for bytes that are not an mp4', () => {
    expect(readMp4Probe(Buffer.from('not-an-mp4-at-all'))).toBeNull()
    expect(readMp4Probe(Buffer.alloc(4))).toBeNull()
  })
})

describe('probeVideoFile', () => {
  test('falls back to the container for an mp4 and agrees with the clip', async () => {
    if (!ffmpegAvailable) return
    const probe = await probeVideoFile(CLIP)
    expect(probe!.sourceFrames).toBe(660)
    expect(probe!.durationSeconds).toBeCloseTo(33, 0)
  })

  test('returns null rather than guessing for an unreadable file', async () => {
    const bogus = join(TEST_DIR, 'bogus.webm')
    const { writeFileSync } = require('fs') as typeof import('fs')
    writeFileSync(bogus, Buffer.from('definitely not a webm'))
    expect(await probeVideoFile(bogus)).toBeNull()
  })
})

describe('planVideoRead', () => {
  test('keeps a request that fits the frame budget exactly as asked', () => {
    const plan = planVideoRead({
      durationSeconds: 10,
      requestedFps: 10,
      tokensPerFrame: 300,
    })
    expect(plan).toMatchObject({ fps: 10, start: 0, end: 10, frames: 100, fpsClamped: false })
  })

  test('lowers the rate when 10 s at 24 fps would blow a 300-token-per-frame budget', () => {
    // 240 frames × 300 = 72k tokens, over the 60k budget; 200 frames fit.
    const plan = planVideoRead({ durationSeconds: 10, requestedFps: 24, tokensPerFrame: 300 })
    expect(plan.fpsClamped).toBe(true)
    expect(plan.requestedFps).toBe(24)
    expect(plan.frames).toBeLessThanOrEqual(Math.floor(VIDEO_FRAME_TOKEN_BUDGET / 300))
    expect(plan.fps).toBeCloseTo(20, 5)
  })

  test('affords three times as many frames on a 73-token-per-frame model', () => {
    const cheap = planVideoRead({ durationSeconds: 33, requestedFps: 20, tokensPerFrame: 73 })
    const expensive = planVideoRead({ durationSeconds: 33, requestedFps: 20, tokensPerFrame: 300 })
    expect(cheap.fps).toBe(20)
    expect(cheap.fpsClamped).toBe(false)
    expect(expensive.fpsClamped).toBe(true)
    expect(expensive.fps).toBeLessThan(cheap.fps)
  })

  test('clamps start and end into the clip and honours a sub-range', () => {
    const plan = planVideoRead({ durationSeconds: 10, requestedFps: 10, start: 5, end: 10, tokensPerFrame: 300 })
    expect(plan).toMatchObject({ start: 5, end: 10, frames: 50, fps: 10, fpsClamped: false })
    const past = planVideoRead({ durationSeconds: 10, requestedFps: 1, start: 8, end: 99, tokensPerFrame: 300 })
    expect(past.end).toBe(10)
  })

  test('defaults to 1 fps when no rate was asked for', () => {
    const plan = planVideoRead({ durationSeconds: 33, tokensPerFrame: 300 })
    expect(plan).toMatchObject({ fps: 1, frames: 33, fpsClamped: false })
  })
})

describe('retimeVideo — the 660-frame case from #2268', () => {
  test('delivers all 660 frames of a 33 s / 20 fps clip', async () => {
    if (!ffmpegAvailable) return
    const result = await retimeVideo({
      inputPath: CLIP,
      workDir: TEST_DIR,
      fps: 20,
      maxBytes: 15 * 1024 * 1024,
    })
    // 660 frames, each encoded as one second: the provider's own 1 fps
    // sampling then returns every one of them.
    expect(result.frames).toBe(660)
    expect(readMp4Probe(result.buffer)!.sourceFrames).toBe(660)
    expect(readMp4Probe(result.buffer)!.durationSeconds).toBeCloseTo(660, 0)
    expect(result.buffer.byteLength).toBeLessThanOrEqual(15 * 1024 * 1024)
    // The frame sequence and the intermediate encode are cleaned up, so a
    // long read leaves nothing behind in the workspace.
    expect(readdirSync(TEST_DIR).filter((name) => name.startsWith('retime-'))).toEqual([])
  }, 180_000)

  test('retimes only the requested range', async () => {
    if (!ffmpegAvailable) return
    const result = await retimeVideo({
      inputPath: CLIP,
      workDir: TEST_DIR,
      fps: 10,
      start: 5,
      end: 10,
      maxBytes: 15 * 1024 * 1024,
    })
    expect(result.frames).toBe(50)
    expect(result.buffer.byteLength).toBeGreaterThan(0)
  }, 120_000)

  test('steps the scale down instead of failing when the output is over the cap', async () => {
    if (!ffmpegAvailable) return
    const generous = await retimeVideo({
      inputPath: CLIP,
      workDir: TEST_DIR,
      fps: 5,
      start: 0,
      end: 4,
      maxBytes: 15 * 1024 * 1024,
    })
    expect(generous.scale).toBe(480)
    // Half of what 480p cost cannot fit at 480p, so the next size down has to
    // be used rather than an oversized clip being returned.
    const result = await retimeVideo({
      inputPath: CLIP,
      workDir: TEST_DIR,
      fps: 5,
      start: 0,
      end: 4,
      maxBytes: Math.floor(generous.buffer.byteLength / 2),
    })
    expect(result.scale).toBeLessThan(480)
    expect(result.buffer.byteLength).toBeLessThanOrEqual(Math.floor(generous.buffer.byteLength / 2))
    expect(result.frames).toBeLessThanOrEqual(20)
  }, 120_000)

  test('raises RetimeError, never a short clip, when ffmpeg is unavailable', async () => {
    const previousPath = process.env.PATH
    const previousFfmpeg = process.env.FFMPEG_PATH
    process.env.PATH = TEST_DIR
    delete process.env.FFMPEG_PATH
    __setExtraBinDirsForTests([])
    try {
      expect(resolveFfmpeg().ffmpeg).toBeNull()
      await expect(
        retimeVideo({ inputPath: CLIP, workDir: TEST_DIR, fps: 10, maxBytes: 1024 * 1024 }),
      ).rejects.toBeInstanceOf(RetimeError)
    } finally {
      process.env.PATH = previousPath
      if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH
      else process.env.FFMPEG_PATH = previousFfmpeg
      __setExtraBinDirsForTests(null)
      __resetFfmpegCacheForTests()
    }
  })
})
